import { describe, expect, it } from "vitest";
import {
  LOCAL_DETAIL_TARGET_SAMPLE_WORLD_M,
  LOCAL_DETAIL_ZOOM_HYSTERESIS,
  LOCAL_GEOMETRY_BUDGET_BYTES,
  LOCAL_HEIGHT_CACHE_LIMIT,
  LOCAL_HORIZON_COVERAGE_PADDING,
  LOCAL_GRID_SIZE,
  LOCAL_MESH_VERTEX_LIMIT,
  LOCAL_SCALE_SETTLE_MS,
  LOCAL_TILE_SIZE,
  LOCAL_TERRAIN_MAX_ZOOM,
  LOCAL_TERRAIN_MIN_ZOOM,
  LOCAL_WINDOW_SIZE,
  RTIN_FALLBACK_ERROR_BUCKETS_M,
  LruCache,
  TileRequestQueue,
  WEB_MERCATOR_MAX_LATITUDE,
  buildHeightGrid513,
  clampMercatorLatitude,
  decodeTerrariumPixels,
  elevationFailureDecision,
  forceFullRtinBoundary,
  heightLoadTasksForWindow,
  isOceanOnlyHeightTile,
  localDetailBlendWeight,
  localDetailEdgeFadeWeight,
  localDetailEnabled,
  localTerrainPatchWidthM,
  localTerrainProjectedSampleM,
  lruEvictionKeys,
  mapterhornUrlForTile,
  mercatorAddressForCoordinates,
  mercatorTileKey,
  resolveLocalElevation,
  rtinErrorBucket,
  selectLocalTerrainZoom,
  selectLocalTileWindow,
  terrainScaleInputChanged,
  terrainScaleInputIsStable,
  terrariumElevationMetres,
  wrapMercatorX,
} from "../apps/little-prince/src/local-terrain-core.js";
import {
  terrainHorizonDiameterM,
  terrainHorizonRadians,
} from "../apps/little-prince/src/terrain-horizon.js";

describe("Little Planet local Mercator terrain", () => {
  it("addresses variable-zoom tiles globally and wraps the antimeridian", () => {
    expect(mercatorAddressForCoordinates(0, 0, 5)).toEqual({
      z: 5,
      x: 16,
      y: 16,
    });
    expect(mercatorAddressForCoordinates(0, 180, 5).x).toBe(0);
    expect(mercatorAddressForCoordinates(0, -180, 5).x).toBe(0);
    expect(wrapMercatorX(-1, 5)).toBe(31);
    expect(wrapMercatorX(32, 5)).toBe(0);
    expect(clampMercatorLatitude(90)).toBe(WEB_MERCATOR_MAX_LATITUDE);
    expect(mercatorAddressForCoordinates(90, 0, 5).y).toBe(0);
  });

  it("selects 25 active tiles and only the required east/south halo", () => {
    const window = selectLocalTileWindow(40, -4, 5);
    const activeKeys = new Set(window.active.map(mercatorTileKey));
    const requiredKeys = new Set(window.required.map(mercatorTileKey));
    expect(window.zoom).toBe(5);
    expect(window.active).toHaveLength(25);
    expect(window.required).toHaveLength(36);
    expect(activeKeys.size).toBe(25);
    expect(requiredKeys.size).toBe(36);
    expect(
      heightLoadTasksForWindow(window).map((task) => task.priority),
    ).toEqual(Array.from({ length: 36 }, (_, index) => index));
    const minimumWindow = selectLocalTileWindow(0, 179.99, 0);
    expect(minimumWindow.zoom).toBe(LOCAL_TERRAIN_MIN_ZOOM);
    expect(
      new Set(minimumWindow.required.map(mercatorTileKey)).size,
    ).toBe(36);
    expect(selectLocalTileWindow(0, 0, 99).zoom).toBe(
      LOCAL_TERRAIN_MAX_ZOOM,
    );
  });

  it("loads only six newly exposed tiles after moving one tile east", () => {
    const first = selectLocalTileWindow(0, 0, 5);
    const nextLongitude = (17.5 / 32) * 360 - 180;
    const second = selectLocalTileWindow(0, nextLongitude, 5);
    const firstKeys = new Set(first.required.map(mercatorTileKey));
    const newKeys = second.required
      .map(mercatorTileKey)
      .filter((key) => !firstKeys.has(key));
    expect(newKeys).toHaveLength(6);
  });

  it("requests the selected Mapterhorn pyramid level", () => {
    const address = { z: 5, x: 15, y: 12 };
    const url = new URL(mapterhornUrlForTile(address));
    expect(url.hostname).toBe("tiles.mapterhorn.com");
    expect(url.pathname).toBe("/5/15/12.webp");
    expect(url.search).toBe("");
  });

  it("keeps local geometry and scale transitions within hard budgets", () => {
    expect(LOCAL_MESH_VERTEX_LIMIT).toBe(16_384);
    expect(LOCAL_GEOMETRY_BUDGET_BYTES).toBe(32 * 1_024 * 1_024);
    expect(LOCAL_SCALE_SETTLE_MS).toBe(250);
  });

  it("debounces terrain streaming until scale input is stable", () => {
    expect(terrainScaleInputChanged(undefined, undefined, 10, 1)).toBe(false);
    expect(terrainScaleInputChanged(10, 1, 10, 1)).toBe(false);
    expect(terrainScaleInputChanged(10, 1, 10.01, 1)).toBe(true);
    expect(terrainScaleInputChanged(10, 1, 10, 1.01)).toBe(true);
    expect(terrainScaleInputIsStable(1_249, 1_000)).toBe(false);
    expect(terrainScaleInputIsStable(1_250, 1_000)).toBe(true);
  });

  it("negatively caches 404s and bounds transient and malformed retries", () => {
    expect(elevationFailureDecision("not-found", 1, 1_000)).toEqual({
      permanent: true,
      retryAtMs: Infinity,
      retryScheduled: false,
    });
    expect(elevationFailureDecision("transient", 1, 1_000)).toEqual({
      permanent: false,
      retryAtMs: 2_000,
      retryScheduled: true,
    });
    expect(elevationFailureDecision("transient", 2, 1_000)).toEqual({
      permanent: false,
      retryAtMs: 6_000,
      retryScheduled: true,
    });
    expect(elevationFailureDecision("transient", 3, 1_000)).toEqual({
      permanent: false,
      retryAtMs: 301_000,
      retryScheduled: false,
    });
    expect(elevationFailureDecision("malformed", 1, 1_000)).toEqual({
      permanent: false,
      retryAtMs: 301_000,
      retryScheduled: false,
    });
  });

  it("decodes Terrarium RGB values to metre elevations", () => {
    expect(terrariumElevationMetres(128, 0, 0)).toBe(0);
    expect(terrariumElevationMetres(128, 3, 128)).toBe(3.5);
    expect(terrariumElevationMetres(127, 255, 0)).toBe(-1);
    const pixels = new Uint8ClampedArray(
      LOCAL_TILE_SIZE * LOCAL_TILE_SIZE * 4,
    );
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

  it("uses east and south halo samples so adjacent grids share heights", () => {
    const west = new Int16Array(LOCAL_TILE_SIZE ** 2).fill(10);
    const east = new Int16Array(LOCAL_TILE_SIZE ** 2).fill(20);
    const fartherEast = new Int16Array(LOCAL_TILE_SIZE ** 2).fill(30);
    const south = new Int16Array(LOCAL_TILE_SIZE ** 2).fill(40);
    const southEast = new Int16Array(LOCAL_TILE_SIZE ** 2).fill(50);
    const westGrid = buildHeightGrid513(west, east, south, southEast);
    const eastGrid = buildHeightGrid513(east, fartherEast);
    for (let row = 0; row <= LOCAL_TILE_SIZE; row += 1) {
      if (row === LOCAL_TILE_SIZE) continue;
      expect(westGrid[row * 513 + 512]).toBe(eastGrid[row * 513]);
    }
    expect(westGrid[512 * 513]).toBe(40);
    expect(westGrid[512 * 513 + 512]).toBe(50);
  });

  it("blends the outer ring to GEBCO and preserves bathymetry at ocean zero", () => {
    expect(localDetailBlendWeight(0, 2, 0, 256)).toBe(0);
    expect(localDetailBlendWeight(0, 2, 512, 256)).toBe(1);
    expect(localDetailBlendWeight(2, 2, 256, 256)).toBe(1);
    expect(resolveLocalElevation(-4200, 0, 1)).toBe(-4200);
    expect(resolveLocalElevation(800, 1200, 0.5)).toBe(1000);
    expect(resolveLocalElevation(800, 1200, 0)).toBe(800);
  });

  it("fades outer and unavailable edges without weakening shared edges", () => {
    const none = { north: 0, east: 0, south: 0, west: 0 };
    expect(localDetailEdgeFadeWeight(0, 0.5, none, none)).toBe(1);
    expect(
      localDetailEdgeFadeWeight(
        0,
        0.5,
        { ...none, west: 1 },
        none,
      ),
    ).toBe(0);
    expect(
      localDetailEdgeFadeWeight(
        0.25,
        0.5,
        none,
        { ...none, west: 1 },
      ),
    ).toBe(1);
    expect(
      localDetailEdgeFadeWeight(
        0.125,
        0.5,
        none,
        { ...none, west: 1 },
      ),
    ).toBeCloseTo(0.5);
  });

  it("forces every RTIN boundary sample for crack-free shared edges", () => {
    const errors = new Float32Array(LOCAL_GRID_SIZE ** 2);
    forceFullRtinBoundary(errors);
    for (let coordinate = 0; coordinate < LOCAL_GRID_SIZE; coordinate += 1) {
      expect(errors[coordinate]).toBe(Infinity);
      expect(
        errors[(LOCAL_GRID_SIZE - 1) * LOCAL_GRID_SIZE + coordinate],
      ).toBe(Infinity);
      expect(errors[coordinate * LOCAL_GRID_SIZE]).toBe(Infinity);
      expect(
        errors[coordinate * LOCAL_GRID_SIZE + LOCAL_GRID_SIZE - 1],
      ).toBe(Infinity);
    }
    expect(errors[Math.floor(errors.length / 2)]).toBe(0);
  });

  it("selects bounded RTIN error buckets and disables imperceptible detail", () => {
    expect(rtinErrorBucket(318.55, 20)).toBe(5);
    expect(rtinErrorBucket(318.55, 1)).toBe(40);
    expect(rtinErrorBucket(127.42, 1)).toBe(80);
    expect(rtinErrorBucket(63.71, 1)).toBe(150);
    expect(rtinErrorBucket(318.55, 1, true)).toBe(80);
    expect(localDetailEnabled(40)).toBe(true);
    expect(localDetailEnabled(WEB_MERCATOR_MAX_LATITUDE)).toBe(false);
  });

  it("calculates the tangent horizon independently of local detail", () => {
    const radius = 63.710088;
    const eyeOnly = Math.acos(radius / (radius + 1.7));
    expect(terrainHorizonRadians(radius, 0, 1.7, 6_940)).toBeCloseTo(
      eyeOnly,
    );
    expect(terrainHorizonRadians(radius, 1, 1.7, 6_940)).toBeGreaterThan(
      eyeOnly,
    );
    expect(terrainHorizonDiameterM(radius, 20, 1.7, 6_940)).toBeGreaterThan(
      terrainHorizonDiameterM(radius, 1, 1.7, 6_940),
    );
  });

  it("keeps the high-resolution patch wider than the visible horizon", () => {
    const radius = 63.710088;
    const maximumElevationM = 6_940;
    const horizonDiameterM = terrainHorizonDiameterM(
      radius,
      1,
      1.7,
      maximumElevationM,
    );
    const zoom = selectLocalTerrainZoom(
      40,
      radius,
      1,
      undefined,
      1.7,
      maximumElevationM,
    );
    expect(zoom).toBe(5);
    expect(
      localTerrainPatchWidthM(40, radius, zoom),
    ).toBeGreaterThanOrEqual(
      horizonDiameterM * LOCAL_HORIZON_COVERAGE_PADDING,
    );
    expect(
      localTerrainPatchWidthM(40, radius, zoom + 1),
    ).toBeLessThan(
      horizonDiameterM * LOCAL_HORIZON_COVERAGE_PADDING,
    );
    expect(
      localTerrainProjectedSampleM(40, radius, 1, zoom),
    ).toBeGreaterThan(LOCAL_DETAIL_TARGET_SAMPLE_WORLD_M);
    expect(
      selectLocalTerrainZoom(40, radius, 1, undefined, 0, 0),
    ).toBe(11);
  });

  it("adapts horizon coverage across scale, exaggeration, and latitude", () => {
    const select = (
      latitudeDegrees: number,
      displayRadiusM: number,
      radialMultiplier: number,
    ): number =>
      selectLocalTerrainZoom(
        latitudeDegrees,
        displayRadiusM,
        radialMultiplier,
        undefined,
        1.7,
        6_940,
      );
    expect(select(40, 1, 1)).toBe(3);
    expect(select(40, 63.710088, 1)).toBe(5);
    expect(select(40, 63.710088, 20)).toBe(4);
    expect(select(40, 318.55044, 1)).toBe(6);
    expect(select(0, 318.55044, 0)).toBe(6);
    expect(select(80, 63.710088, 1)).toBe(3);
    expect(select(0, 1e12, 0)).toBe(
      LOCAL_TERRAIN_MAX_ZOOM,
    );
    expect(select(80, 0.001, 20)).toBe(
      LOCAL_TERRAIN_MIN_ZOOM,
    );
  });

  it("keeps resolution hysteresis when the horizon does not constrain it", () => {
    expect(LOCAL_DETAIL_ZOOM_HYSTERESIS).toBe(1.2);
    expect(selectLocalTerrainZoom(40, 50, 1, undefined, 0, 0)).toBe(11);
    expect(selectLocalTerrainZoom(40, 50, 1, 10, 0, 0)).toBe(10);
    expect(selectLocalTerrainZoom(40, 63.710088, 1, 10, 0, 0)).toBe(11);
    expect(selectLocalTerrainZoom(40, 43, 1, 11, 0, 0)).toBe(10);
  });

  it("keeps emergency RTIN simplification available after normal buckets", () => {
    expect(RTIN_FALLBACK_ERROR_BUCKETS_M[0]).toBeGreaterThan(150);
    expect(RTIN_FALLBACK_ERROR_BUCKETS_M.at(-1)).toBe(9_600);
  });
});

describe("Little Planet local terrain scheduling", () => {
  it("limits elevation work to four concurrent requests", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const queue = new TileRequestQueue<number>(
      (address) =>
        new Promise((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve(address.x);
          });
        }),
      () => undefined,
      () => undefined,
    );
    queue.sync(
      Array.from({ length: 6 }, (_, x) => ({
        address: { z: 12, x, y: 1 },
        priority: x,
      })),
    );
    expect(queue.activeCount).toBe(4);
    expect(queue.queuedCount).toBe(2);
    expect(maximumActive).toBe(4);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.activeCount).toBe(4);
    expect(queue.queuedCount).toBe(1);
    for (const release of releases) release();
    queue.dispose();
  });

  it("aborts elevation work that leaves the active halo", async () => {
    let aborted = false;
    const failures: unknown[] = [];
    const queue = new TileRequestQueue<number>(
      (_address, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
      () => undefined,
      (_task, error) => failures.push(error),
      4,
    );
    queue.sync([
      {
        address: { z: 12, x: 1, y: 1 },
        priority: 0,
      },
    ]);
    queue.sync([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(true);
    expect(queue.activeCount).toBe(0);
    expect(failures).toEqual([]);
  });

  it("evicts decoded tiles at the 64-tile LRU limit", () => {
    expect(
      lruEvictionKeys(
        Array.from({ length: 66 }, (_, index) => ({
          key: `tile-${index}`,
          usedAt: index,
        })),
        LOCAL_HEIGHT_CACHE_LIMIT,
      ),
    ).toEqual(["tile-0", "tile-1"]);
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.set("c", 3).map((item) => item.key)).toEqual(["b"]);
    expect(cache.entries()).toEqual([
      ["a", 1],
      ["c", 3],
    ]);
  });

  it("restarts an address re-added while its aborted request settles", async () => {
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

  it("never exceeds the active 5 × 5 mesh-address ceiling", () => {
    for (const [latitude, longitude] of [
      [40, -4],
      [0, 179.99],
      [-70, -179.99],
    ] satisfies Array<[number, number]>) {
      const window = selectLocalTileWindow(latitude, longitude, 5);
      expect(window.active.length).toBe(LOCAL_WINDOW_SIZE ** 2);
      expect(new Set(window.active.map(mercatorTileKey)).size).toBe(25);
    }
  });

  it("keeps cache identities separate between terrain zoom levels", () => {
    expect(mercatorTileKey({ z: 5, x: 16, y: 12 })).not.toBe(
      mercatorTileKey({ z: 6, x: 16, y: 12 }),
    );
  });
});
