import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function flatPng(
  size: number,
  red: number,
  green: number,
  blue: number,
): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const rowOffset = row * (size * 4 + 1);
    for (let column = 0; column < size; column += 1) {
      const offset = rowOffset + 1 + column * 4;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
      raw[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function flatTerrariumPng(heightM = 100): Buffer {
  const encoded = heightM + 32_768;
  return flatPng(
    512,
    Math.floor(encoded / 256),
    Math.floor(encoded % 256),
    0,
  );
}

async function routeFlatTerrain(page: Page): Promise<void> {
  const terrainImage = flatTerrariumPng();
  await page.route("https://tiles.mapterhorn.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: terrainImage,
    });
  });
}

async function waitForInitialImagery(page: Page): Promise<void> {
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-activation",
    "active",
    { timeout: 30_000 },
  );
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-visible-sources"),
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
}

test("toggles the native tile-surface overlay", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__ = true;
  });
  await routeFlatTerrain(page);
  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({
    timeout: 20_000,
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-tile-overlay",
    "false",
  );
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_TILE_OVERLAY__?.(true);
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-tile-overlay",
    "true",
  );
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_TILE_OVERLAY__?.(false);
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-tile-overlay",
    "false",
  );
});

test("toggles the imagery tile-surface overlay", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__ = true;
  });
  await routeFlatTerrain(page);
  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({
    timeout: 20_000,
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-texture-tile-overlay",
    "false",
  );
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_TEXTURE_TILE_OVERLAY__?.(true);
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-texture-tile-overlay",
    "true",
  );
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_TEXTURE_TILE_OVERLAY__?.(false);
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-texture-tile-overlay",
    "false",
  );
});

test("keeps the immutable globe under atomic terrain groups", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const terrainImage = flatTerrariumPng();
  const missingTiles = new Set([
    "6/54/21",
    "6/55/21",
    "6/54/22",
    "6/55/22",
    "6/54/25",
    "6/54/30",
  ]);
  await page.route("https://tiles.mapterhorn.com/**", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const key = `${parts[1]}/${parts[2]}/${parts[3]?.split(".")[0]}`;
    if (missingTiles.has(key)) {
      await route.fulfill({ status: 404, body: "No elevation tile" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: terrainImage,
    });
  });

  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({
    timeout: 20_000,
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-relief",
    "ready",
    { timeout: 360_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-window-size",
    "160",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-coverage-mesh-count",
    "155",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-fallback-cells",
    "5",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-base-globe-visible",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-contact-owner",
    /native|global/,
  );
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-detail-atomic-swap-total"),
        ),
    )
    .toBeGreaterThanOrEqual(4);

  const states = await page
    .locator("body")
    .getAttribute("data-detail-tile-states");
  expect(states).toHaveLength(160);
  expect(states?.replace(/[rfdpo]/g, "")).toBe("");
  expect(states?.split("f")).toHaveLength(6);

  const frameHashes: string[] = [];
  for (let frame = 0; frame < 3; frame += 1) {
    const screenshot = await page.screenshot({
      clip: { x: 400, y: 360, width: 480, height: 240 },
    });
    frameHashes.push(createHash("sha256").update(screenshot).digest("hex"));
    await page.waitForTimeout(100);
  }
  expect(new Set(frameHashes).size).toBe(1);
});

test("keeps photographic visibility while central caps swap and outer rings refine", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__ = true;
    window.__PAS_DE_GEANT_IMAGERY_CONFIG__ = {
      id: "fault-injected-onion",
      urlTemplate: "https://imagery.test/{z}/{x}/{y}.png",
      attribution: "Synthetic browser-test imagery",
      tileSize: 256,
      minZoom: 0,
      maxZoom: 20,
    };
  });
  await routeFlatTerrain(page);
  const imagery = flatPng(256, 30, 150, 70);
  let malformedInjected = false;
  let transientKey = "";
  const attempts = new Map<string, number>();
  await page.route("https://imagery.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    const attempt = (attempts.get(path) ?? 0) + 1;
    attempts.set(path, attempt);
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (!malformedInjected) {
      malformedInjected = true;
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from("malformed imagery"),
      });
      return;
    }
    if (!transientKey) transientKey = path;
    if (path === transientKey && attempt === 1) {
      await route.fulfill({ status: 503, body: "Retry later" });
      return;
    }
    const [, x, yWithExtension] = path.split("/");
    const y = Number(yWithExtension?.split(".")[0]);
    if (Number(x) % 11 === 0 && y % 3 === 0) {
      await route.fulfill({ status: 404, body: "No photographic tile" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: imagery,
    });
  });

  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({
    timeout: 20_000,
  });
  await waitForInitialImagery(page);
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-pool-layers",
    "279",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-window-size",
    "64",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-pinned-pages",
    "212",
  );
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-malformed-total"),
        ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () => attempts.get(transientKey) ?? 0,
      { timeout: 20_000 },
    )
    .toBeGreaterThan(1);

  const originalVisiblePlan = await page
    .locator("body")
    .getAttribute("data-imagery-visible-plan");
  const originalEpoch = Number(
    await page
      .locator("body")
      .getAttribute("data-imagery-page-table-epoch"),
  );
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_SCALE__?.(520);
  });
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-imagery-candidate-plan",
    "",
    { timeout: 20_000 },
  );
  for (let sample = 0; sample < 8; sample += 1) {
    const snapshot = await page.evaluate(() => ({
      candidate: document.body.dataset.imageryCandidatePlan,
      visible: document.body.dataset.imageryVisiblePlan,
      visibleSources: Number(document.body.dataset.imageryVisibleSources),
      epoch: Number(document.body.dataset.imageryPageTableEpoch),
    }));
    if (!snapshot.candidate) break;
    expect(snapshot.visibleSources).toBeGreaterThan(0);
    expect(snapshot.visible).toBe(originalVisiblePlan);
    expect(snapshot.epoch).toBe(originalEpoch);
    await page.waitForTimeout(40);
  }
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-candidate-plan",
    "",
    { timeout: 30_000 },
  );
  await expect
    .poll(
      async () =>
        await page
          .locator("body")
          .getAttribute("data-imagery-visible-plan"),
    )
    .not.toBe(originalVisiblePlan);
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-page-table-epoch"),
        ),
    )
    .toBeGreaterThan(originalEpoch);
});

test("changes imagery z with render scale and keeps photographic world layers", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__ = true;
    window.__PAS_DE_GEANT_IMAGERY_CONFIG__ = {
      id: "render-space-onion",
      urlTemplate: "https://imagery.test/{z}/{x}/{y}.png",
      attribution: "Synthetic browser-test imagery",
      tileSize: 256,
      minZoom: 0,
      maxZoom: 20,
    };
  });
  await routeFlatTerrain(page);
  const imagery = flatPng(256, 55, 135, 65);
  const requestedZooms = new Set<number>();
  await page.route("https://imagery.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname.split("/");
    requestedZooms.add(Number(path[1]));
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: imagery,
    });
  });

  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({
    timeout: 20_000,
  });
  await waitForInitialImagery(page);
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_LOCATION__?.(46, 9);
  });

  for (const [displayRadiusM, expectedZoom] of [
    [250, 9],
    [500, 10],
    [1_000, 11],
  ] as const) {
    await page.evaluate((radius) => {
      window.__PAS_DE_GEANT_TEST_SET_SCALE__?.(radius);
    }, displayRadiusM);
    await expect(page.locator("body")).toHaveAttribute(
      "data-imagery-desired-zoom",
      String(expectedZoom),
      { timeout: 30_000 },
    );
    await expect(page.locator("body")).toHaveAttribute(
      "data-imagery-visible-zoom",
      String(expectedZoom),
      { timeout: 30_000 },
    );
    await expect(page.locator("body")).toHaveAttribute(
      "data-imagery-plan-mode",
      "onion",
    );
    const centimetresPerTexel = Number(
      await page
        .locator("body")
        .getAttribute("data-imagery-centimetres-per-texel"),
    );
    expect(centimetresPerTexel).toBeGreaterThan(0.7);
    expect(centimetresPerTexel).toBeLessThan(1);
  }

  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_SCALE__?.(1);
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-desired-zoom",
    "1",
    { timeout: 30_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-visible-zoom",
    "1",
    { timeout: 30_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-plan-mode",
    "world",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-visible-group",
    "1",
    { timeout: 30_000 },
  );
  expect(requestedZooms.has(0)).toBe(true);
  expect(requestedZooms.has(1)).toBe(true);
  expect(
    Number(
      await page
        .locator("body")
        .getAttribute("data-imagery-visible-sources"),
    ),
  ).toBeGreaterThan(1);
});

test("A-to-B-to-A can replace aborted requests and ignores late completions", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__ = true;
    window.__PAS_DE_GEANT_IMAGERY_PROVIDER__ = {
      id: "ignored-cancellation-provider",
      attribution: "Synthetic browser-test imagery",
      tileSize: 256,
      minZoom: 0,
      maxZoom: 20,
      async load(address) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        const response = await fetch(
          `https://imagery.test/${address.z}/${address.x}/${address.y}.png`,
        );
        return response.blob();
      },
    };
  });
  await routeFlatTerrain(page);
  const imagery = flatPng(256, 40, 80, 180);
  await page.route("https://imagery.test/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: imagery,
    });
  });

  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({
    timeout: 20_000,
  });
  await waitForInitialImagery(page);
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-visible-group",
    "2",
    { timeout: 30_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-requests",
    "0",
    { timeout: 30_000 },
  );
  const planA = await page
    .locator("body")
    .getAttribute("data-imagery-visible-plan");
  const epochA = await page
    .locator("body")
    .getAttribute("data-imagery-page-table-epoch");
  const staleBefore = Number(
    await page.locator("body").getAttribute("data-imagery-stale-total"),
  );
  const requestTotalBeforeB = Number(
    await page.locator("body").getAttribute("data-imagery-request-total"),
  );

  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_LOCATION__?.(35.6762, -120);
  });
  await expect(page.locator("body")).not.toHaveAttribute(
    "data-imagery-candidate-plan",
    "",
    { timeout: 20_000 },
  );
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-request-total"),
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(requestTotalBeforeB);
  await page.evaluate(() => {
    window.__PAS_DE_GEANT_TEST_SET_LOCATION__?.(35.6762, 139.6503);
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-candidate-plan",
    "",
    { timeout: 20_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-imagery-visible-plan",
    planA ?? "",
  );
  expect(
    Number(
      await page
        .locator("body")
        .getAttribute("data-imagery-page-table-epoch"),
    ),
  ).toBeGreaterThanOrEqual(Number(epochA));
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-stale-total"),
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(staleBefore);
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator("body")
            .getAttribute("data-imagery-visible-sources"),
        ),
    )
    .toBeGreaterThan(0);
});
