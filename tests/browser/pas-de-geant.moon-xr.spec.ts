import { expect, test } from "@playwright/test";
import { contactFrame } from "@found-in-space/worlds";

interface WalkingSnapshot {
  controls: {
    location: { latitudeDegrees: number; longitudeDegrees: number };
    focusedBodyDisplayRadiusM: number;
    scaleDenominator: number;
    navigation: { focusBody: string; mode: string };
  };
  renderer: { xr: { presenting: boolean }; draw: { frame: number } };
  terrain: { renderVisibility: { leftEyeVisibleCount: number; rightEyeVisibleCount: number } };
}

test.use({
  channel: "chromium",
  launchOptions: {
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  },
});

test("walks on the Moon in stereo VR and preserves the Earth launch", async ({ page }, testInfo) => {
  const errors: string[] = [];
  const localOrigin = new URL(testInfo.project.use.baseURL!).origin;
  page.on("pageerror", (error) => errors.push(error.message));
  // No external downloads are needed to exercise the shared walking runtime.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== localOrigin || url.pathname.startsWith("/api/")) {
      await route.fulfill({ status: 404, body: "Offline VR test" });
    } else {
      await route.continue();
    }
  });
  await page.goto("/?world=moon&xrEmulation=quest3&debug=1");
  await expect(page.locator("body")).toHaveAttribute("data-focus-body", "moon");
  await expect(page.locator("body")).toHaveAttribute("data-location-source", "preset");
  await expect(page.locator("#VRButton")).toHaveText("ENTER VR");
  await page.evaluate(() => window.pasDeGeantXrEmulator!.setHeadsetPose({
    position: { x: 0, y: 1.65, z: 0 }, pitchDegrees: -30,
  }));
  await page.locator("#VRButton").click();
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = window.pasDeGeantDebug!.snapshot() as unknown as WalkingSnapshot;
    return snapshot.renderer.xr.presenting && snapshot.terrain.renderVisibility.rightEyeVisibleCount > 0;
  })).toBe(true);

  const before = await page.evaluate(() => window.pasDeGeantDebug!.snapshot() as unknown as WalkingSnapshot);
  for (const x of [0.05, 0.1, 0.15, 0.2]) {
    const frame = await page.evaluate((positionX) => {
      const snapshot = window.pasDeGeantDebug!.snapshot() as unknown as WalkingSnapshot;
      window.pasDeGeantXrEmulator!.setHeadsetPose({
        position: { x: positionX, y: 1.65, z: 0 }, pitchDegrees: -30,
      });
      return snapshot.renderer.draw.frame;
    }, x);
    await expect.poll(async () => page.evaluate(() =>
      (window.pasDeGeantDebug!.snapshot() as unknown as WalkingSnapshot).renderer.draw.frame
    )).toBeGreaterThan(frame + 2);
  }
  const after = await page.evaluate(() => window.pasDeGeantDebug!.snapshot() as unknown as WalkingSnapshot);
  const from = contactFrame(before.controls.location.latitudeDegrees, before.controls.location.longitudeDegrees).upEcef;
  const to = contactFrame(after.controls.location.latitudeDegrees, after.controls.location.longitudeDegrees).upEcef;
  const walkedMetres = from.angleTo(to) * after.controls.focusedBodyDisplayRadiusM;
  expect(walkedMetres).toBeCloseTo(0.2, 4);
  expect(after.controls.navigation.focusBody).toBe("moon");
  expect(after.controls.navigation.mode).toBe("surface");
  expect(after.terrain.renderVisibility.leftEyeVisibleCount).toBeGreaterThan(0);
  expect(after.terrain.renderVisibility.rightEyeVisibleCount).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("moon-walking-stereo.png") });

  const changed = await page.evaluate(() => window.pasDeGeantDebug!.setScaleDenominator(30_000) as unknown as WalkingSnapshot["controls"]);
  expect(changed.focusedBodyDisplayRadiusM).toBeCloseTo(before.controls.focusedBodyDisplayRadiusM * 2, 6);
  await page.keyboard.press("Backspace");
  await expect.poll(async () => page.evaluate(() =>
    (window.pasDeGeantDebug!.snapshot() as unknown as WalkingSnapshot).controls.scaleDenominator
  )).toBe(before.controls.scaleDenominator);
  const reset = await page.evaluate(() => window.pasDeGeantDebug!.snapshot() as unknown as WalkingSnapshot);
  expect(reset.controls.location.latitudeDegrees).toBeCloseTo(before.controls.location.latitudeDegrees, 6);
  expect(reset.controls.location.longitudeDegrees).toBeCloseTo(before.controls.location.longitudeDegrees, 6);
  await page.evaluate(() => window.pasDeGeantXrEmulator!.endSession());
  await expect(page.locator("body")).not.toHaveClass(/xr-presenting/);

  await page.goto("/?xrEmulation=quest3&debug=1");
  await expect(page.locator("body")).toHaveAttribute("data-focus-body", "earth");
  await expect(page.locator("body")).toHaveAttribute("data-location-source", "device");
  await expect(page.locator("#VRButton")).toHaveText("ENTER VR");
  await page.locator("#VRButton").click();
  await expect.poll(async () => page.evaluate(() =>
    window.pasDeGeantXrEmulator!.snapshot().sessionActive
  )).toBe(true);
  await page.evaluate(() => window.pasDeGeantXrEmulator!.endSession());
  expect(errors).toEqual([]);
});
