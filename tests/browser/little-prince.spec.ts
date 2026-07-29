import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

const LOCAL_WINDOW_SIZE = 9;
const LOCAL_REQUIRED_WINDOW_SIZE = LOCAL_WINDOW_SIZE + 1;
const LOCAL_HEIGHT_CACHE_LIMIT = 128;
const LOCAL_GEOMETRY_BUDGET_BYTES = 96 * 1_024 * 1_024;
const LOCAL_IMAGERY_OVERLAY_LIMIT = 128;
const MAPTERHORN_ELEVATION_CACHE_NAME =
  "little-planet-mapterhorn-elevation-v1";

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

function onePixelPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4" +
      "2mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
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
        new URL(route.request().url()).pathname
          .split("/")
          .at(-1)
          ?.split(".")[0],
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
            lat: 35.7,
            lon: 139.7,
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
  await expect(page.locator("body")).toHaveAttribute(
    "data-location-source",
    "device",
  );
  await expect(page.locator("#coordinates")).toContainText("35.68° N");
  await expect(page.locator("#coordinates")).toContainText("139.65° E");
  await expect(page.locator("#scale-readout")).toContainText("10.0 m");
  await expect(page.locator("#scale-readout")).toContainText("1 km = 1.0 cm");
  await expect(page.locator("#radial-readout")).toContainText("1.0×");
  await expect(page.locator("#radial-readout")).toContainText("1 km = 1.0 cm");
  await expect(page.locator("#aircraft-readout")).toHaveText("Off · optional");
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
    "6",
  );
  await expect.poll(() => new Set(elevationRequests).size).toBe(100);
  const initialTerrainZoom = Number(
    await page.locator("body").getAttribute("data-detail-terrain-zoom"),
  );
  const initialHorizonDegrees = Number(
    await page.locator("body").getAttribute("data-detail-horizon-degrees"),
  );
  expect(
    elevationRequests.every(
      (url) =>
        Number(new URL(url).pathname.split("/")[1]) === initialTerrainZoom,
    ),
  ).toBe(true);
  expect(initialTerrainZoom).toBeGreaterThanOrEqual(0);
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
      Array.from({ length: LOCAL_REQUIRED_WINDOW_SIZE }, (_, row) =>
        Array.from({ length: LOCAL_REQUIRED_WINDOW_SIZE }, (_, column) => {
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
  await page.waitForFunction(
    () => document.body.dataset.detailScaleMotion === "false",
  );
  const reducedTerrainZoom = Number(
    await page.locator("body").getAttribute("data-detail-terrain-zoom"),
  );
  expect(reducedTerrainZoom).toBeLessThanOrEqual(initialTerrainZoom);
  expect(
    Number(
      await page.locator("body").getAttribute("data-detail-horizon-degrees"),
    ),
  ).toBeGreaterThan(initialHorizonDegrees);

  await page.keyboard.down("KeyV");
  await page.waitForTimeout(100);
  await page.keyboard.up("KeyV");
  await expect(page.locator("#radial-readout")).not.toContainText("1.0×");
  expect(
    Number(await page.locator("body").getAttribute("data-detail-terrain-zoom")),
  ).toBe(reducedTerrainZoom);

  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(page.locator("#coordinates")).toContainText("35.68° N");
  await expect(page.locator("#coordinates")).toContainText("139.65° E");
  await expect(page.locator("#scale-readout")).toContainText("10.0 m");
  await expect(page.locator("#radial-readout")).toContainText("1.0×");
  await expect(page.locator("#ocean-readout")).toHaveText("Surface");
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-terrain-zoom",
    String(initialTerrainZoom),
  );

  const aircraftToggle = page.getByRole("checkbox", {
    name: "Live aircraft",
  });
  await aircraftToggle.check();
  await expect(page.locator("#aircraft-readout")).toHaveText("Ready for VR");
  expect(aircraftRequests).toBe(0);
  await aircraftToggle.uncheck();
  await expect(page.locator("#aircraft-readout")).toHaveText("Off · optional");
  await expect
    .poll(() =>
      page.evaluate(
        async (cacheName) =>
          (await (await caches.open(cacheName)).keys()).length,
        MAPTERHORN_ELEVATION_CACHE_NAME,
      ),
    )
    .toBe(0);
  expect(
    Number(
      await page
        .locator("body")
        .getAttribute("data-detail-elevation-persistent-cache-deletes"),
    ),
  ).toBeGreaterThan(0);
  expect(consoleErrors).toEqual([]);
});

test("prepares bounded local meshes from mocked global detail tiles", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const terrainImage = flatTerrariumPng();
  const imageryPixel = onePixelPng();
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
      body: imageryPixel,
    });
  });
  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({ timeout: 20_000 });
  await expect(page.locator("#error-state")).toBeHidden();
  await page.waitForFunction(
    () =>
      document.body.dataset.detailRelief === "ready" &&
      document.body.dataset.detailStaging === "false",
    undefined,
    { timeout: 180_000 },
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
    localImageryRequests: Number(document.body.dataset.detailImageryRequests),
    localImageryCache: Number(document.body.dataset.detailImageryCache),
    imageryPatches: Number(document.body.dataset.detailImageryPatches),
    imageryDraws: Number(document.body.dataset.detailImageryDraws),
    geometryBytes: Number(document.body.dataset.detailGeometryBytes),
    vertices: Number(document.body.dataset.detailVertices),
    workerInflight: Number(document.body.dataset.detailWorkerInflight),
  }));
  const initialTerrainZoom = Number(
    await page.locator("body").getAttribute("data-detail-terrain-zoom"),
  );
  expect(initialTerrainZoom).toBe(6);
  expect(initialMetrics.meshCount).toBe(LOCAL_WINDOW_SIZE ** 2);
  expect(initialMetrics.cacheCount).toBeLessThanOrEqual(
    LOCAL_HEIGHT_CACHE_LIMIT,
  );
  expect(initialMetrics.localImageryRequests).toBe(0);
  expect(initialMetrics.localImageryCache).toBe(0);
  expect(initialMetrics.imageryPatches).toBeGreaterThan(0);
  expect(initialMetrics.imageryDraws).toBeGreaterThan(0);
  expect(initialMetrics.imageryDraws).toBeLessThanOrEqual(
    LOCAL_IMAGERY_OVERLAY_LIMIT,
  );
  expect(initialMetrics.geometryBytes).toBeLessThanOrEqual(
    LOCAL_GEOMETRY_BUDGET_BYTES,
  );
  expect(initialMetrics.vertices).toBeLessThanOrEqual(
    LOCAL_WINDOW_SIZE ** 2 * 16_384,
  );
  expect(initialMetrics.workerInflight).toBe(0);
  expect(maximumActiveElevationRequests).toBeLessThanOrEqual(4);
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-window-size",
    "9x9",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-horizon-coverage",
    "true",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-gibs-imagery-level",
    "6",
  );
  const horizonDiagnostics = await page.evaluate(() => ({
    degrees: Number(document.body.dataset.detailHorizonDegrees),
    distanceKm: Number(document.body.dataset.detailHorizonDistanceKm),
    margins: (document.body.dataset.detailCoverageMargins ?? "")
      .split(",")
      .map(Number),
    actualErrors: document.body.dataset.detailActualErrorMetres ?? "",
  }));
  expect(horizonDiagnostics.degrees).toBeGreaterThan(14);
  expect(horizonDiagnostics.degrees).toBeLessThan(15);
  expect(horizonDiagnostics.distanceKm).toBeGreaterThan(1_500);
  expect(horizonDiagnostics.distanceKm).toBeLessThan(1_700);
  expect(horizonDiagnostics.margins).toHaveLength(4);
  expect(horizonDiagnostics.margins.every((margin) => margin >= -0.001)).toBe(
    true,
  );
  expect(horizonDiagnostics.actualErrors).not.toBe("");
  expect(
    elevationUrls.every(
      (url) =>
        Number(new URL(url).pathname.split("/")[1]) ===
        initialTerrainZoom,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      async (cacheName) =>
        (await (await caches.open(cacheName)).keys()).length,
      MAPTERHORN_ELEVATION_CACHE_NAME,
    ),
  ).toBeGreaterThanOrEqual(LOCAL_REQUIRED_WINDOW_SIZE ** 2);
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
      Array.from({ length: LOCAL_REQUIRED_WINDOW_SIZE }, (_, row) =>
        Array.from({ length: LOCAL_REQUIRED_WINDOW_SIZE }, (_, column) => {
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
        new Set(elevationUrls.filter((url) => !initialElevationKeys.has(url)))
          .size,
    )
    .toBe(expectedNewTiles);

  const beforeRtinRefinement = elevationUrls.length;
  await page.keyboard.down("KeyX");
  await page.waitForFunction(
    (zoom) =>
      document.body.dataset.detailTargetZoom === zoom &&
      document.body.dataset.detailRequestedErrorMetres === "80",
    String(initialTerrainZoom),
  );
  await page.keyboard.up("KeyX");
  await page.waitForFunction(
    (zoom) =>
      document.body.dataset.detailActiveZoom === zoom &&
      document.body.dataset.detailStaging === "false" &&
      (document.body.dataset.detailActualErrorMetres ?? "")
        .split(",")
        .includes("80"),
    String(initialTerrainZoom),
    { timeout: 90_000 },
  );
  expect(elevationUrls.length).toBe(beforeRtinRefinement);

  await page.keyboard.down("KeyX");
  await page.waitForFunction(
    (zoom) => document.body.dataset.detailTargetZoom === zoom,
    String(initialTerrainZoom + 1),
  );
  expect(
    elevationUrls.some(
      (url) =>
        Number(new URL(url).pathname.split("/")[1]) ===
        initialTerrainZoom + 1,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(() => document.body.dataset.detailScaleMotion),
  ).toBe("true");
  await expect(page.locator("#scale-readout")).not.toContainText("10.0 m");
  await page.keyboard.up("KeyX");
  await page.waitForFunction(
    (zoom) =>
      document.body.dataset.detailActiveZoom === zoom &&
      document.body.dataset.detailStaging === "false" &&
      document.body.dataset.detailWorkerQueued === "0" &&
      document.body.dataset.detailWorkerInflight === "0",
    String(initialTerrainZoom + 1),
    { timeout: 180_000 },
  );
  expect(
    elevationUrls.some(
      (url) =>
        Number(new URL(url).pathname.split("/")[1]) ===
        initialTerrainZoom + 1,
    ),
  ).toBe(true);
  expect(
    elevationUrls.every(
      (url) =>
        Number(new URL(url).pathname.split("/")[1]) <=
        initialTerrainZoom + 1,
    ),
  ).toBe(true);
  expect(
    Number(
      await page
        .locator("body")
        .getAttribute("data-detail-source-sample-metres"),
    ),
  ).toBeLessThan(1_000);
  await expect(page.locator("body")).toHaveAttribute(
    "data-gibs-imagery-level",
    "7",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-requested-error-metres",
    "40",
  );
  expect(consoleErrors).toEqual([]);
});

test("feathers partial Mapterhorn coverage into stable GEBCO fallback", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const terrainImage = flatTerrariumPng();
  const imageryPixel = onePixelPng();
  const missingTiles = new Set([
    "6/54/21",
    "6/55/21",
    "6/54/22",
    "6/55/22",
    "6/54/25",
    "6/54/30",
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
      body: imageryPixel,
    });
  });

  await page.goto("/");
  await expect(page.locator("#loading-state")).toBeHidden({
    timeout: 20_000,
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-relief",
    "ready",
    { timeout: 60_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-mesh-count",
    "76",
    { timeout: 180_000 },
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-fallback-cells",
    "5",
  );
  await expect(page.locator("body")).toHaveAttribute(
    "data-detail-tile-states",
    [
      "rrffrrrrr",
      "rrffrrrrr",
      "rrrrrrrrr",
      "rrrrrrrrr",
      "rrfrrrrrr",
      "rrrrrrrrr",
      "rrrrrrrrr",
      "rrrrrrrrr",
      "rrrrrrrrr",
    ].join("/"),
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
        await page.locator("body").getAttribute("data-detail-imagery-patches"),
      ),
    )
    .toBeGreaterThan(0);

  await page.waitForTimeout(500);
  const frameHashes: string[] = [];
  for (let frame = 0; frame < 4; frame += 1) {
    const screenshot = await page.screenshot({
      clip: { x: 400, y: 360, width: 480, height: 240 },
    });
    frameHashes.push(createHash("sha256").update(screenshot).digest("hex"));
    await page.waitForTimeout(100);
  }
  expect(new Set(frameHashes).size).toBe(1);
});
