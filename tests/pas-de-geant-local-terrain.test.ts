import { describe, expect, it } from "vitest";
import {
  LOCAL_GRID_SIZE,
  LOCAL_ACTIVE_TILE_BUDGET,
  LOCAL_LOD_HEADPOSE_DEADZONE_M,
  LOCAL_TERRAIN_MAX_ZOOM,
  LOCAL_TILE_SIZE,
  RTIN_TARGET_ERROR_PIXELS,
  TileRequestQueue,
  angularDistanceToMercatorTile,
  buildHeightGrid513,
  decodeTerrariumPixels,
  distanceFromEyeToMercatorTileWorldM,
  forceFullRtinBoundary,
  isValidMercatorAddress,
  isOceanOnlyHeightTile,
  localDetailBlendWeight,
  localDetailEdgeFadeWeight,
  localTerrainHorizonCoverage,
  mercatorHorizonBounds,
  mercatorTileKey,
  resolveLocalElevation,
  samplePixelsForMercatorTile,
  screenSpacePlanningPoseMovementM,
  screenSpaceRtinErrorBucket,
  selectScreenSpaceTerrainPlan,
  selectLocalTerrainZoom,
  selectLocalTileWindow,
  verticalErrorPixelsForTile,
} from "../apps/pas-de-geant/src/local-terrain-core.js";
import {
  MAPTERHORN_ELEVATION_CACHE_NAME,
  deleteCachedElevation,
  loadCachedElevation,
  type ElevationCacheStorage,
} from "../apps/pas-de-geant/src/elevation-cache.js";

describe("Pas de Géant local-terrain regressions", () => {
  it("does not duplicate wrapped or polar tiles at low zoom", () => {
    for (const zoom of [0, 1, 2, 3]) {
      for (const [latitude, longitude] of [
        [0, 0],
        [84, 179.99],
        [-84, -179.99],
      ] satisfies Array<[number, number]>) {
        const window = selectLocalTileWindow(latitude, longitude, zoom);
        const worldCells = (2 ** zoom) ** 2;
        expect(window.active).toHaveLength(worldCells);
        expect(window.required).toHaveLength(worldCells);
        expect(new Set(window.required.map(mercatorTileKey)).size).toBe(
          worldCells,
        );
        expect(window.required.every(isValidMercatorAddress)).toBe(true);
      }
    }
  });

  it("reuses and deletes successful elevation responses through the Cache API", async () => {
    const stored = new Map<string, Response>();
    let openedCacheName = "";
    let fetchCalls = 0;
    const cacheStorage: ElevationCacheStorage = {
      async open(cacheName) {
        openedCacheName = cacheName;
        return {
          async match(request) {
            return stored.get(String(request))?.clone();
          },
          async put(request, response) {
            stored.set(String(request), response.clone());
          },
          async delete(request) {
            return stored.delete(String(request));
          },
        };
      },
    };
    const fetcher = (async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/webp" },
      });
    }) as typeof fetch;
    const address = { z: 12, x: 2_031, y: 1_377 };

    const first = await loadCachedElevation(
      address,
      new AbortController().signal,
      { cacheStorage, fetcher },
    );
    const second = await loadCachedElevation(
      address,
      new AbortController().signal,
      { cacheStorage, fetcher },
    );

    expect(openedCacheName).toBe(MAPTERHORN_ELEVATION_CACHE_NAME);
    expect(first.cacheStatus).toBe("stored");
    expect(second.cacheStatus).toBe("hit");
    expect([...new Uint8Array(second.bytes)]).toEqual([1, 2, 3]);
    expect(fetchCalls).toBe(1);
    expect(await deleteCachedElevation(address, cacheStorage)).toBe("deleted");
  });

  it("decodes the external Terrarium pixel format", () => {
    const pixels = new Uint8ClampedArray(LOCAL_TILE_SIZE ** 2 * 4);
    for (let index = 0; index < pixels.length; index += 4) {
      pixels[index] = 128;
      pixels[index + 3] = 255;
    }
    pixels[4] = 128;
    pixels[5] = 3;
    pixels[6] = 128;

    const heights = decodeTerrariumPixels(pixels);
    expect(heights[0]).toBe(0);
    expect(heights[1]).toBe(4);
    expect(isOceanOnlyHeightTile(heights)).toBe(false);
    heights[1] = 0;
    expect(isOceanOnlyHeightTile(heights)).toBe(true);
    expect(() => decodeTerrariumPixels(new Uint8Array(16))).toThrow(
      "512 × 512",
    );
  });

  it("uses neighbour samples so adjacent height grids share exact edges", () => {
    const west = new Int16Array(LOCAL_TILE_SIZE ** 2).fill(10);
    const east = new Int16Array(LOCAL_TILE_SIZE ** 2).fill(20);
    const fartherEast = new Int16Array(LOCAL_TILE_SIZE ** 2).fill(30);
    const south = new Int16Array(LOCAL_TILE_SIZE ** 2).fill(40);
    const southEast = new Int16Array(LOCAL_TILE_SIZE ** 2).fill(50);
    const westGrid = buildHeightGrid513(west, east, south, southEast);
    const eastGrid = buildHeightGrid513(east, fartherEast);

    for (let row = 0; row < LOCAL_TILE_SIZE; row += 1) {
      expect(westGrid[row * 513 + 512]).toBe(eastGrid[row * 513]);
    }
    expect(westGrid[512 * 513]).toBe(40);
    expect(westGrid[512 * 513 + 512]).toBe(50);
  });

  it("fades only patch boundaries back to continuous global relief", () => {
    const noEdges = { north: 0, east: 0, south: 0, west: 0 };
    expect(localDetailBlendWeight(0, 2, 0, 256)).toBe(0);
    expect(localDetailBlendWeight(2, 2, 256, 256)).toBe(1);
    expect(resolveLocalElevation(-4_200, 0, 1)).toBe(-4_200);
    expect(resolveLocalElevation(800, 1_200, 0.5)).toBe(1_000);
    expect(localDetailEdgeFadeWeight(0, 0.5, noEdges, noEdges)).toBe(1);
    expect(
      localDetailEdgeFadeWeight(
        0,
        0.5,
        { ...noEdges, west: 1 },
        noEdges,
      ),
    ).toBe(0);
    expect(
      localDetailEdgeFadeWeight(
        0.25,
        0.5,
        noEdges,
        { ...noEdges, west: 1 },
      ),
    ).toBe(1);
  });

  it("forces RTIN borders so independently simplified tiles cannot crack", () => {
    const errors = new Float32Array(LOCAL_GRID_SIZE ** 2);
    forceFullRtinBoundary(errors);
    for (let coordinate = 0; coordinate < LOCAL_GRID_SIZE; coordinate += 1) {
      expect(errors[coordinate]).toBe(Infinity);
      expect(errors[(LOCAL_GRID_SIZE - 1) * LOCAL_GRID_SIZE + coordinate]).toBe(
        Infinity,
      );
      expect(errors[coordinate * LOCAL_GRID_SIZE]).toBe(Infinity);
      expect(errors[coordinate * LOCAL_GRID_SIZE + LOCAL_GRID_SIZE - 1]).toBe(
        Infinity,
      );
    }
    expect(errors[Math.floor(errors.length / 2)]).toBe(0);
  });

  it("selects the finest actual tile window that contains the horizon", () => {
    for (const [latitude, longitude, radius] of [
      [0, 0, 1],
      [40, -4, 63.710088],
      [80, 0, 63.710088],
      [-80, 179.99, 63.710088],
    ] satisfies Array<[number, number, number]>) {
      const bounds = mercatorHorizonBounds(latitude, longitude, radius);
      const zoom = selectLocalTerrainZoom(latitude, longitude, radius);
      expect(
        localTerrainHorizonCoverage(
          selectLocalTileWindow(latitude, longitude, zoom),
          bounds,
        ).covered,
      ).toBe(true);
      if (zoom < LOCAL_TERRAIN_MAX_ZOOM) {
        expect(
          localTerrainHorizonCoverage(
            selectLocalTileWindow(latitude, longitude, zoom + 1),
            bounds,
          ).covered,
        ).toBe(false);
      }
    }
  });

  it("selects mixed source zooms from per-eye sample size", () => {
    const options = {
      latitudeDegrees: 45,
      longitudeDegrees: 7,
      displayRadiusM: 1,
      eyeHeightWorldM: 1.65,
      focalLengthPixels: 1_100,
    };
    const plan = selectScreenSpaceTerrainPlan(options);
    expect(plan.budgetLimited).toBe(false);
    expect(plan.active.length).toBeLessThanOrEqual(LOCAL_ACTIVE_TILE_BUDGET);
    expect(plan.minZoom).toBeLessThan(plan.maxZoom);
    expect(new Set(plan.active.map((tile) => tile.z)).size).toBeGreaterThan(1);
    expect(Math.max(...plan.active.map((tile) => tile.samplePixels))).toBeLessThan(
      0.5,
    );

    for (const tile of plan.active) {
      for (const other of plan.active) {
        if (tile === other || tile.z >= other.z) continue;
        const divisor = 2 ** (other.z - tile.z);
        expect(
          Math.floor(other.x / divisor) === tile.x &&
            Math.floor(other.y / divisor) === tile.y,
        ).toBe(false);
      }
    }
  });

  it("uses source-LOD hysteresis and an error-halving bias", () => {
    const baseOptions = {
      latitudeDegrees: 45,
      longitudeDegrees: 7,
      displayRadiusM: 1,
      eyeHeightWorldM: 1.65,
      focalLengthPixels: 1_100,
    };
    const base = selectScreenSpaceTerrainPlan(baseOptions);
    const previousActiveKeys = new Set(base.active.map(mercatorTileKey));
    const coldAtHigherResolution = selectScreenSpaceTerrainPlan({
      ...baseOptions,
      focalLengthPixels: 1_250,
    });
    const hystereticAtHigherResolution = selectScreenSpaceTerrainPlan({
      ...baseOptions,
      focalLengthPixels: 1_250,
      previousActiveKeys,
    });
    expect(hystereticAtHigherResolution.maxZoom).toBe(base.maxZoom);
    expect(hystereticAtHigherResolution.active).toHaveLength(
      base.active.length,
    );
    expect(coldAtHigherResolution.maxZoom).toBeGreaterThan(base.maxZoom);

    const finerBias = selectScreenSpaceTerrainPlan({
      ...baseOptions,
      lodBias: 1,
    });
    expect(finerBias.maxZoom).toBeGreaterThanOrEqual(base.maxZoom);
    expect(finerBias.active.length).toBeGreaterThan(base.active.length);
  });

  it("holds LOD planning inside a cumulative centimetre head-pose deadzone", () => {
    const anchor = {
      latitudeDegrees: 45,
      longitudeDegrees: 7,
      eyeHeightWorldM: 1.65,
    };
    const oneDegreeWorldM = Math.PI / 180;
    const smallHorizontalDegrees =
      0.025 / (oneDegreeWorldM * Math.cos(Math.PI / 4));
    const withinDeadzone = screenSpacePlanningPoseMovementM(
      anchor,
      {
        latitudeDegrees: anchor.latitudeDegrees,
        longitudeDegrees: anchor.longitudeDegrees + smallHorizontalDegrees,
        eyeHeightWorldM: 1.67,
      },
      1,
    );
    const beyondDeadzone = screenSpacePlanningPoseMovementM(
      anchor,
      {
        latitudeDegrees: anchor.latitudeDegrees,
        longitudeDegrees: anchor.longitudeDegrees + smallHorizontalDegrees * 2,
        eyeHeightWorldM: 1.67,
      },
      1,
    );
    expect(withinDeadzone).toBeLessThan(LOCAL_LOD_HEADPOSE_DEADZONE_M);
    expect(beyondDeadzone).toBeGreaterThan(LOCAL_LOD_HEADPOSE_DEADZONE_M);
  });

  it("measures source and RTIN errors in actual eye-buffer pixels", () => {
    const underEye = { z: 12, x: 2_048, y: 2_048 };
    expect(angularDistanceToMercatorTile(0, 0, underEye)).toBe(0);
    expect(
      distanceFromEyeToMercatorTileWorldM(0, 0, underEye, 10, 1.65),
    ).toBeCloseTo(1.65);
    const sampleAtTen = samplePixelsForMercatorTile(
      0,
      0,
      underEye,
      10,
      1.65,
      1_100,
    );
    const sampleAtTwenty = samplePixelsForMercatorTile(
      0,
      0,
      underEye,
      20,
      1.65,
      1_100,
    );
    expect(sampleAtTwenty).toBeCloseTo(sampleAtTen * 2);

    const nearError = screenSpaceRtinErrorBucket(2, 637, 1, 1_100);
    const farError = screenSpaceRtinErrorBucket(20, 637, 1, 1_100);
    const biasedError = screenSpaceRtinErrorBucket(2, 637, 1, 1_100, 1);
    expect(farError).toBeGreaterThanOrEqual(nearError);
    expect(biasedError).toBeLessThanOrEqual(nearError);
    expect(
      verticalErrorPixelsForTile(nearError, 2, 637, 1, 1_100),
    ).toBeLessThanOrEqual(RTIN_TARGET_ERROR_PIXELS);
  });

  it("restarts a tile re-added while its aborted request settles", async () => {
    let calls = 0;
    const queue = new TileRequestQueue<number>(
      (_address, signal) =>
        new Promise((resolve, reject) => {
          calls += 1;
          if (calls === 2) {
            resolve(2);
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
      () => undefined,
      () => undefined,
      1,
    );
    const task = {
      address: { z: 5, x: 1, y: 1 },
      priority: 0,
    };

    queue.sync([task]);
    queue.sync([]);
    queue.sync([task]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    queue.dispose();
  });
});
