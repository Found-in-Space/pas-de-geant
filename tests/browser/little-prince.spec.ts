import { expect, test } from "@playwright/test";
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

function flatTerrariumPng(heightM = 100): Buffer {
  const size = 512;
  const encoded = heightM + 32_768;
  const red = Math.floor(encoded / 256);
  const green = Math.floor(encoded % 256);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const rowOffset = row * (size * 4 + 1);
    for (let column = 0; column < size; column += 1) {
      const offset = rowOffset + 1 + column * 4;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = 0;
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

test("loads and operates the Little Planet desktop fallback", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  let aircraftRequests = 0;
  const blueMarbleRequests: string[] = [];
  const elevationRequests: string[] = [];
  let activeElevationRequests = 0;
  let maximumActiveElevationRequests = 0;
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      consoleErrors.push(message.text());
    }
  });
  page.on("request", (request) => {
    if (request.url().includes("BlueMarble_ShadedRelief_Bathymetry")) {
      blueMarbleRequests.push(request.url());
    }
    if (request.url().startsWith("https://tiles.mapterhorn.com/")) {
      elevationRequests.push(request.url());
    }
  });
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) =>
    route.abort(),
  );
  await page.route("https://tiles.mapterhorn.com/**", async (route) => {
    activeElevationRequests += 1;
    maximumActiveElevationRequests = Math.max(
      maximumActiveElevationRequests,
      activeElevationRequests,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const y = Number(
        new URL(route.request().url()).pathname.split("/").at(-1)?.split(".")[0],
      );
      await route.fulfill(
        y % 2 === 0
          ? {
              status: 200,
              contentType: "image/webp",
              body: "malformed elevation image",
            }
          : {
              status: 404,
              contentType: "text/plain",
              body: "No elevation tile",
            },
      );
    } finally {
      activeElevationRequests -= 1;
    }
  });
  await page.route("https://api.airplanes.live/**", (route) => {
    aircraftRequests += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ac: [
          {
            hex: "484abc",
            flight: "KLM123",
            lat: 40.1,
            lon: -3.9,
            alt_baro: 32_000,
            gs: 430,
            track: 91,
            seen_pos: 0.2,
          },
        ],
      }),
    });
  });
  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#error-state")).toBeHidden();
  await expect(page.locator("#scene-root canvas")).toHaveCount(1);
  await expect(page.locator("body")).toHaveAttribute(
    "data-relief-fallback",
    "false",
  );
  await expect(page.locator("#coordinates")).toContainText("40.00° N");
  await expect(page.locator("#scale-readout")).toContainText("10.0 m");
  await expect(page.locator("#scale-readout")).toContainText(
    "1 km = 1.0 cm",
  );
  await expect(page.locator("#radial-readout")).toContainText("1.0×");
  await expect(page.locator("#radial-readout")).toContainText(
    "1 km = 1.0 cm",
  );
  await expect(page.locator("#aircraft-readout")).toHaveText(
    "Off · optional",
  );
  await expect.poll(() => blueMarbleRequests.length).toBeGreaterThan(0);
  expect(
    blueMarbleRequests.every(
      (url) => url.includes("/wmts/") && !url.includes("/wms/"),
    ),
  ).toBe(true);
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-relief",
    "fallback",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-terrain-zoom",
    "11",
  );
  await expect.poll(() => new Set(elevationRequests).size).toBe(36);
  const initialTerrainZoom = Number(
    await page.locator("body").getAttribute("data-detail-terrain-zoom"),
  );
  expect(
    elevationRequests.every(
      (url) =>
        Number(new URL(url).pathname.split("/")[1]) === initialTerrainZoom,
    ),
  ).toBe(true);
  expect(initialTerrainZoom).toBeGreaterThanOrEqual(3);
  expect(initialTerrainZoom).toBeLessThanOrEqual(12);
  expect(maximumActiveElevationRequests).toBeLessThanOrEqual(4);
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-mesh-count",
    "0",
  );
  const initialElevationKeys = new Set(elevationRequests);
  const initialWindowOrigin = await page
    .locator("body")
    .getAttribute("data-detail-window-origin");

  await page.keyboard.down("KeyD");
  await page.waitForFunction(
    (origin) => document.body.dataset.detailWindowOrigin !== origin,
    initialWindowOrigin,
  );
  await page.keyboard.up("KeyD");
  const movedWindowOrigin = await page
    .locator("body")
    .getAttribute("data-detail-window-origin");
  const parseOrigin = (value: string | null): [number, number] => {
    const [x = "0", y = "0"] = (value ?? "").split("/");
    return [Number(x), Number(y)];
  };
  const [initialOriginX, initialOriginY] = parseOrigin(initialWindowOrigin);
  const [movedOriginX, movedOriginY] = parseOrigin(movedWindowOrigin);
  const tileCount = 2 ** initialTerrainZoom;
  const requiredKeys = (originX: number, originY: number): Set<string> =>
    new Set(
      Array.from({ length: 6 }, (_, row) =>
        Array.from({ length: 6 }, (_, column) => {
          const x = (originX + column + tileCount) % tileCount;
          return `${initialTerrainZoom}/${x}/${originY + row}`;
        }),
      ).flat(),
    );
  const initialRequiredKeys = requiredKeys(initialOriginX, initialOriginY);
  const movedRequiredKeys = requiredKeys(movedOriginX, movedOriginY);
  const expectedNewTiles = [...movedRequiredKeys].filter(
    (key) => !initialRequiredKeys.has(key),
  ).length;
  expect(expectedNewTiles).toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        new Set(
          elevationRequests.filter((url) => !initialElevationKeys.has(url)),
        ).size,
    )
    .toBe(expectedNewTiles);
  await page.waitForTimeout(250);
  expect(aircraftRequests).toBe(0);

  await page.getByRole("button", { name: "Reveal seabed" }).click();
  await expect(page.locator("#ocean-readout")).toHaveText("Seabed revealed");
  await expect(
    page.getByRole("button", { name: "Restore ocean" }),
  ).toBeVisible();

  await page.keyboard.down("KeyZ");
  await page.waitForTimeout(1_200);
  await page.keyboard.up("KeyZ");
  await expect(page.locator("#scale-readout")).not.toContainText("10.0 m");
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-terrain-zoom",
    "10",
  );

  await page.keyboard.down("KeyV");
  await page.waitForTimeout(100);
  await page.keyboard.up("KeyV");
  await expect(page.locator("#radial-readout")).not.toContainText("1.0×");

  await page.getByRole("button", { name: "Reset Iberia" }).click();
  await expect(page.locator("#scale-readout")).toContainText("10.0 m");
  await expect(page.locator("#radial-readout")).toContainText("1.0×");
  await expect(page.locator("#ocean-readout")).toHaveText("Surface");
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-terrain-zoom",
    "11",
  );

  const aircraftToggle = page.getByRole("checkbox", {
    name: "Live aircraft",
  });
  await aircraftToggle.check();
  await expect(page.locator("#aircraft-readout")).toHaveText("Ready for VR");
  expect(aircraftRequests).toBe(0);
  await aircraftToggle.uncheck();
  await expect(page.locator("#aircraft-readout")).toHaveText("Off · optional");
  expect(consoleErrors).toEqual([]);
});

test("prepares bounded local meshes from mocked global detail tiles", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const terrainImage = flatTerrariumPng();
  const elevationUrls: string[] = [];
  const localImageryUrls: string[] = [];
  const globalImageryUrls: string[] = [];
  const consoleErrors: string[] = [];
  let activeElevationRequests = 0;
  let maximumActiveElevationRequests = 0;
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      consoleErrors.push(message.text());
    }
  });
  await page.route("https://tiles.mapterhorn.com/**", async (route) => {
    elevationUrls.push(route.request().url());
    activeElevationRequests += 1;
    maximumActiveElevationRequests = Math.max(
      maximumActiveElevationRequests,
      activeElevationRequests,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: terrainImage,
      });
    } finally {
      activeElevationRequests -= 1;
    }
  });
  await page.route("https://gibs.earthdata.nasa.gov/**", (route) => {
    if (route.request().url().includes("/wmts/epsg3857/")) {
      localImageryUrls.push(route.request().url());
    }
    if (route.request().url().includes("/wmts/epsg4326/")) {
      globalImageryUrls.push(route.request().url());
    }
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      body: terrainImage,
    });
  });
  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#error-state")).toBeHidden();
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-relief",
    "ready",
    { timeout: 20_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-staging",
    "false",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-stencil",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-material-side",
    "front",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-centre-state",
    "r",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-overbudget-cells",
    "0",
  );
  await page.waitForFunction(
    () =>
      Number(document.body.dataset.detailImageryPatches) > 0 &&
      Number(document.body.dataset.detailImageryDraws) > 0 &&
      document.body.dataset.gibsImageryActive === "0" &&
      document.body.dataset.gibsImageryQueued === "0",
  );
  const initialMetrics = await page.evaluate(() => ({
    meshCount: Number(document.body.dataset.detailMeshCount),
    cacheCount: Number(document.body.dataset.detailHeightCache),
    localImageryRequests: Number(
      document.body.dataset.detailImageryRequests,
    ),
    localImageryCache: Number(document.body.dataset.detailImageryCache),
    imageryPatches: Number(document.body.dataset.detailImageryPatches),
    imageryDraws: Number(document.body.dataset.detailImageryDraws),
    geometryBytes: Number(document.body.dataset.detailGeometryBytes),
    vertices: Number(document.body.dataset.detailVertices),
    workerInflight: Number(document.body.dataset.detailWorkerInflight),
  }));
  expect(initialMetrics.meshCount).toBe(25);
  expect(initialMetrics.cacheCount).toBeLessThanOrEqual(64);
  expect(initialMetrics.localImageryRequests).toBe(0);
  expect(initialMetrics.localImageryCache).toBe(0);
  expect(initialMetrics.imageryPatches).toBeGreaterThan(0);
  expect(initialMetrics.imageryDraws).toBeGreaterThan(0);
  expect(initialMetrics.imageryDraws).toBeLessThanOrEqual(64);
  expect(initialMetrics.geometryBytes).toBeLessThanOrEqual(
    32 * 1_024 * 1_024,
  );
  expect(initialMetrics.vertices).toBeLessThanOrEqual(25 * 16_384);
  expect(initialMetrics.workerInflight).toBe(0);
  expect(maximumActiveElevationRequests).toBeLessThanOrEqual(4);
  expect(
    elevationUrls.every(
      (url) => new URL(url).pathname.split("/")[1] === "11",
    ),
  ).toBe(true);
  expect(globalImageryUrls.length).toBeGreaterThan(0);
  expect(localImageryUrls).toEqual([]);
  const settledImageryRequestCount = globalImageryUrls.length;
  await page.waitForTimeout(500);
  expect(globalImageryUrls.length).toBe(settledImageryRequestCount);

  const terrainFrameHashes: string[] = [];
  for (let frame = 0; frame < 3; frame += 1) {
    const screenshot = await page.screenshot({
      clip: { x: 460, y: 400, width: 320, height: 160 },
    });
    terrainFrameHashes.push(
      createHash("sha256").update(screenshot).digest("hex"),
    );
    await page.waitForTimeout(100);
  }
  expect(new Set(terrainFrameHashes).size).toBe(1);

  const initialWindowOrigin = await page
    .locator("body")
    .getAttribute("data-detail-window-origin");
  const initialElevationKeys = new Set(elevationUrls);
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      detailMeshSamples?: number[];
      detailMeshSampleTimer?: number;
    };
    testWindow.detailMeshSamples = [];
    testWindow.detailMeshSampleTimer = window.setInterval(() => {
      testWindow.detailMeshSamples?.push(
        Number(document.body.dataset.detailMeshCount),
      );
    }, 50);
  });
  await page.keyboard.down("KeyD");
  await page.waitForFunction(
    (origin) => document.body.dataset.detailWindowOrigin !== origin,
    initialWindowOrigin,
  );
  await page.keyboard.up("KeyD");
  const movementMeshCounts = await page.evaluate(() => {
    const testWindow = window as typeof window & {
      detailMeshSamples?: number[];
      detailMeshSampleTimer?: number;
    };
    if (testWindow.detailMeshSampleTimer !== undefined) {
      window.clearInterval(testWindow.detailMeshSampleTimer);
    }
    return testWindow.detailMeshSamples ?? [];
  });
  expect(movementMeshCounts.length).toBeGreaterThan(0);
  expect(Math.min(...movementMeshCounts)).toBeGreaterThan(0);
  const movedWindowOrigin = await page
    .locator("body")
    .getAttribute("data-detail-window-origin");
  const parseOrigin = (value: string | null): [number, number] => {
    const [x = "0", y = "0"] = (value ?? "").split("/");
    return [Number(x), Number(y)];
  };
  const [initialX, initialY] = parseOrigin(initialWindowOrigin);
  const [movedX, movedY] = parseOrigin(movedWindowOrigin);
  const activeZoom = Number(
    await page.locator("body").getAttribute("data-detail-active-zoom"),
  );
  const tileCount = 2 ** activeZoom;
  const requiredKeys = (originX: number, originY: number): Set<string> =>
    new Set(
      Array.from({ length: 6 }, (_, row) =>
        Array.from({ length: 6 }, (_, column) => {
          const x = (originX + column + tileCount) % tileCount;
          return `${activeZoom}/${x}/${originY + row}`;
        }),
      ).flat(),
    );
  const initialRequiredKeys = requiredKeys(initialX, initialY);
  const movedRequiredKeys = requiredKeys(movedX, movedY);
  const expectedNewTiles = [...movedRequiredKeys].filter(
    (key) => !initialRequiredKeys.has(key),
  ).length;
  await expect
    .poll(
      () =>
        new Set(
          elevationUrls.filter((url) => !initialElevationKeys.has(url)),
        ).size,
    )
    .toBe(expectedNewTiles);

  await page.keyboard.down("KeyZ");
  await page.waitForFunction(
    () => document.body.dataset.detailTargetZoom === "10",
  );
  expect(
    elevationUrls.some(
      (url) => new URL(url).pathname.split("/")[1] === "10",
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => document.body.dataset.detailScaleMotion,
    ),
  ).toBe("true");
  await page.keyboard.up("KeyZ");
  await page.waitForFunction(
    () =>
      document.body.dataset.detailActiveZoom === "10" &&
      document.body.dataset.detailStaging === "false" &&
      document.body.dataset.detailWorkerQueued === "0" &&
      document.body.dataset.detailWorkerInflight === "0",
    undefined,
    { timeout: 15_000 },
  );
  expect(
    elevationUrls.every(
      (url) => Number(new URL(url).pathname.split("/")[1]) <= 12,
    ),
  ).toBe(true);
  expect(consoleErrors).toEqual([]);
});

test("feathers partial Mapterhorn coverage into stable GEBCO fallback", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const terrainImage = flatTerrariumPng();
  const missingTiles = new Set([
    "11/999/773",
    "11/1000/773",
    "11/999/774",
    "11/1000/774",
    "11/999/776",
    "11/999/778",
  ]);
  const localImageryUrls: string[] = [];
  await page.route("https://tiles.mapterhorn.com/**", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const key = `${parts[1]}/${parts[2]}/${parts[3]?.split(".")[0]}`;
    if (missingTiles.has(key)) {
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "No elevation tile",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: terrainImage,
    });
  });
  await page.route("https://gibs.earthdata.nasa.gov/**", async (route) => {
    if (route.request().url().includes("/wmts/epsg3857/")) {
      localImageryUrls.push(route.request().url());
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
    { timeout: 20_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-mesh-count",
    "20",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-fallback-cells",
    "5",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-tile-states",
    "ffrrr/ffrrr/rrrrr/frrrr/rrrrr",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-imagery-requests",
    "0",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-centre-state",
    "r",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-material-side",
    "front",
  );
  expect(localImageryUrls).toEqual([]);
  await expect
    .poll(async () =>
      Number(
        await page
          .locator("body")
          .getAttribute("data-detail-imagery-patches"),
      ),
    )
    .toBeGreaterThan(0);

  await page.waitForTimeout(500);
  const frameHashes: string[] = [];
  for (let frame = 0; frame < 4; frame += 1) {
    const screenshot = await page.screenshot({
      clip: { x: 400, y: 360, width: 480, height: 240 },
    });
    frameHashes.push(
      createHash("sha256").update(screenshot).digest("hex"),
    );
    await page.waitForTimeout(100);
  }
  expect(new Set(frameHashes).size).toBe(1);
});
