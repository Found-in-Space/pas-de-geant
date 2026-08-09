import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const PISA = {
  latitudeDegrees: 43.722952,
  longitudeDegrees: 10.396597,
} as const;
const TARGET_SCALE = 15_000;
const PLANNER_SETTLE_TIMEOUT_MS = 180_000;

interface PlannerPipelineSnapshot {
  readonly topology: {
    readonly transition_complete: boolean;
  };
  readonly payload_tile_requests: {
    readonly planner_requests: {
      readonly total_outstanding: number;
    };
    readonly target_submission: {
      readonly pending: boolean;
      readonly in_flight: boolean;
    };
  };
  readonly source_jobs: {
    readonly queued: number;
    readonly in_flight: number;
  };
}

interface RuntimeSnapshot {
  readonly capturedAt: string;
  readonly controls: {
    readonly location: {
      readonly latitudeDegrees: number;
      readonly longitudeDegrees: number;
    };
    readonly displayRadiusM: number;
  };
  readonly frame: Record<string, unknown>;
  readonly renderer: {
    readonly xr: {
      readonly presenting: boolean;
      readonly frameRate: number | null;
    };
    readonly drawingBuffer: {
      readonly width: number;
      readonly height: number;
    };
    readonly draw: {
      readonly frame: number;
    };
  };
  readonly planner: {
    readonly terrain: PlannerPipelineSnapshot;
    readonly textures: PlannerPipelineSnapshot;
  };
  readonly terrain: Record<string, unknown>;
  readonly browser: Record<string, unknown>;
}

interface StageCapture {
  readonly name: string;
  readonly screenshot: string | null;
  readonly emulator: ReturnType<NonNullable<Window["pasDeGeantXrEmulator"]>["snapshot"]>;
  readonly runtime: RuntimeSnapshot;
}

function pipelineSettled(pipeline: PlannerPipelineSnapshot): boolean {
  return pipeline.payload_tile_requests.planner_requests.total_outstanding === 0 &&
    !pipeline.payload_tile_requests.target_submission.pending &&
    !pipeline.payload_tile_requests.target_submission.in_flight &&
    pipeline.source_jobs.queued === 0 &&
    pipeline.source_jobs.in_flight === 0;
}

function pipelineProgress(pipeline: PlannerPipelineSnapshot): Record<string, unknown> {
  return {
    transitionComplete: pipeline.topology.transition_complete,
    outstanding:
      pipeline.payload_tile_requests.planner_requests.total_outstanding,
    submissionPending:
      pipeline.payload_tile_requests.target_submission.pending ||
      pipeline.payload_tile_requests.target_submission.in_flight,
    queued: pipeline.source_jobs.queued,
    inFlight: pipeline.source_jobs.in_flight,
  };
}

async function runtimeSnapshot(page: Page): Promise<RuntimeSnapshot> {
  return await page.evaluate(() =>
    window.pasDeGeantDebug!.snapshot() as unknown as RuntimeSnapshot
  );
}

async function waitForPlannerSettle(
  page: Page,
  label: string,
): Promise<{ elapsedMs: number; snapshot: RuntimeSnapshot }> {
  const startedAt = Date.now();
  let latest = await runtimeSnapshot(page);
  let nextProgressAt = 10_000;
  while (Date.now() - startedAt < PLANNER_SETTLE_TIMEOUT_MS) {
    if (
      pipelineSettled(latest.planner.terrain) &&
      pipelineSettled(latest.planner.textures)
    ) {
      return { elapsedMs: Date.now() - startedAt, snapshot: latest };
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= nextProgressAt) {
      console.log("XR_SETTLE_PROGRESS", JSON.stringify({
        label,
        elapsedSeconds: Math.round(elapsedMs / 1_000),
        terrain: pipelineProgress(latest.planner.terrain),
        textures: pipelineProgress(latest.planner.textures),
      }));
      nextProgressAt += 10_000;
    }
    await page.waitForTimeout(1_000);
    latest = await runtimeSnapshot(page);
  }
  throw new Error(
    `${label} did not settle within ${PLANNER_SETTLE_TIMEOUT_MS} ms: ${JSON.stringify(latest.planner)}`,
  );
}

async function captureStage(
  page: Page,
  testInfo: TestInfo,
  name: string,
  takeScreenshot = true,
): Promise<StageCapture> {
  const screenshot = takeScreenshot ? `${name}.png` : null;
  if (screenshot) {
    await page.screenshot({
      path: testInfo.outputPath(screenshot),
    });
  }
  return await page.evaluate(({ stageName, screenshotName }) => ({
    name: stageName,
    screenshot: screenshotName,
    emulator: window.pasDeGeantXrEmulator!.snapshot(),
    runtime: window.pasDeGeantDebug!.snapshot() as unknown as RuntimeSnapshot,
  }), { stageName: name, screenshotName: screenshot });
}

test("runs the Pisa scale-15000 Quest 3 WebXR look-around diagnostic", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__ = true;
  });
  await page.goto("/?xrEmulation=quest3&debug=1");
  await expect(page.locator("#loading-state")).toBeHidden({ timeout: 20_000 });

  const emulatorBeforeSession = await page.evaluate(() =>
    window.pasDeGeantXrEmulator?.snapshot()
  );
  expect(emulatorBeforeSession?.deviceName).toBe("Meta Quest 3");
  expect(emulatorBeforeSession?.stereoEnabled).toBe(true);
  expect(emulatorBeforeSession?.sessionActive).toBe(false);

  await expect(page.locator("#VRButton")).toHaveText("ENTER VR");
  await page.locator("#VRButton").click();
  await expect.poll(async () => {
    const snapshot = await runtimeSnapshot(page);
    return snapshot.renderer.xr.presenting;
  }).toBe(true);

  await page.evaluate(() => {
    window.pasDeGeantDebug!.beginBenchmark();
  });
  const defaultSettle = await waitForPlannerSettle(page, "Pisa default scale");
  expect(defaultSettle.snapshot.controls.location.latitudeDegrees).toBeCloseTo(
    PISA.latitudeDegrees,
    5,
  );
  expect(defaultSettle.snapshot.controls.location.longitudeDegrees).toBeCloseTo(
    PISA.longitudeDegrees,
    5,
  );
  const stages: StageCapture[] = [
    await captureStage(page, testInfo, "01-pisa-default"),
  ];

  await page.evaluate((displayRadiusM) => {
    window.pasDeGeantDebug!.setScale(displayRadiusM);
  }, TARGET_SCALE);
  const zoomSettle = await waitForPlannerSettle(page, "Pisa scale 15,000");
  expect(zoomSettle.snapshot.controls.displayRadiusM).toBe(
    TARGET_SCALE,
  );
  await page.evaluate(() => {
    window.pasDeGeantDebug!.setTileRecalculation("both", false);
  });
  stages.push(await captureStage(page, testInfo, "02-pisa-scale-15000-forward"));

  await page.evaluate(() => {
    window.pasDeGeantDebug!.clearMetrics();
  });
  const views = [
    {
      name: "03-pisa-scale-15000-down",
      pitchDegrees: -55,
      yawDegrees: 0,
      screenshot: true,
    },
    {
      name: "04-pisa-scale-15000-left",
      pitchDegrees: -25,
      yawDegrees: -90,
      screenshot: false,
    },
    {
      name: "05-pisa-scale-15000-back",
      pitchDegrees: -25,
      yawDegrees: 180,
      screenshot: false,
    },
    {
      name: "06-pisa-scale-15000-right",
      pitchDegrees: -25,
      yawDegrees: 90,
      screenshot: false,
    },
  ] as const;
  for (const view of views) {
    const frameBeforePose = (await runtimeSnapshot(page)).renderer.draw.frame;
    await page.evaluate((pose) => {
      window.pasDeGeantXrEmulator!.setHeadsetPose(pose);
    }, view);
    await expect.poll(async () =>
      (await runtimeSnapshot(page)).renderer.draw.frame
    ).toBeGreaterThan(frameBeforePose);
    stages.push(
      await captureStage(page, testInfo, view.name, view.screenshot),
    );
  }

  const result = {
    scenario: "Pisa default scale to scale 15,000, then emulated-headset look-around",
    completedAt: new Date().toISOString(),
    route: {
      start: PISA,
      targetScale: TARGET_SCALE,
    },
    settle: {
      defaultMs: defaultSettle.elapsedMs,
      scale15000Ms: zoomSettle.elapsedMs,
    },
    stages,
  };
  const resultPath = testInfo.outputPath("pisa-quest3-webxr-audit.json");
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log("PISA_QUEST3_WEBXR_AUDIT", JSON.stringify({
    scenario: result.scenario,
    settle: result.settle,
    stages: result.stages.map((stage) => ({
      name: stage.name,
      screenshot: stage.screenshot,
      frame: stage.runtime.renderer.draw.frame,
    })),
    resultPath,
  }, null, 2));

  await page.evaluate(async () => {
    window.pasDeGeantDebug!.endBenchmark();
    await window.pasDeGeantXrEmulator!.endSession();
  });
});
