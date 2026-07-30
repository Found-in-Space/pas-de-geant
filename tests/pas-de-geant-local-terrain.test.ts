import { describe, expect, it } from "vitest";
import {
  LOCAL_HEIGHT_CACHE_LIMIT,
  LOCAL_RING_LEVELS,
  LOCAL_RING_OUTER_TILES,
  LOCAL_TILE_COARSEN_WIDTH_M,
  LOCAL_TILE_REFINE_WIDTH_M,
  LOCAL_TILE_SIZE,
  LOCAL_TILE_TARGET_WIDTH_M,
  LOCAL_UNDERFOOT_MESH_SEGMENTS,
  TileRequestQueue,
  buildHeightGrid513,
  clampOceanSurfaceOffsetM,
  decodeTerrariumPixels,
  interpolateOceanSurfaceOffsetM,
  interpolateTerrainOffsetM,
  isOceanOnlyHeightTile,
  localDetailEdgeFadeWeight,
  meshSegmentsForRing,
  mercatorTileKey,
  nativeTerrainPlanAnchorKey,
  renderedMercatorTileWidthM,
  resolveLocalElevation,
  sampleRegularHeightGrid,
  selectNativeTerrainPlan,
  selectNativeTerrainZoom,
  terrainEdgeInterpolation,
} from "../apps/pas-de-geant/src/local-terrain-core.js";
import {
  MAPTERHORN_ELEVATION_CACHE_NAME,
  deleteCachedElevation,
  loadCachedElevation,
  type ElevationCacheStorage,
} from "../apps/pas-de-geant/src/elevation-cache.js";

describe("Pas de Géant native terrain rings", () => {
  it("samples the rendered height grid continuously underfoot", () => {
    const heights = new Float32Array([
      0, 10,
      20, 30,
    ]);
    expect(sampleRegularHeightGrid(heights, 1, 0.25, 0.75)).toBeCloseTo(
      17.5,
    );
    expect(sampleRegularHeightGrid(heights, 1, 1, 1)).toBe(30);
  });

  it("keeps enough decoded tiles for the complete three-level stencil", () => {
    const completeStencilTiles =
      LOCAL_RING_OUTER_TILES ** 2 +
      (LOCAL_RING_OUTER_TILES ** 2 - 4 ** 2) *
        (LOCAL_RING_LEVELS - 1);
    expect(completeStencilTiles).toBe(160);
    expect(LOCAL_HEIGHT_CACHE_LIMIT).toBeGreaterThan(completeStencilTiles);
  });

  it("selects zoom solely from native tile width in render space", () => {
    const radiusForTargetAtZoomFive =
      LOCAL_TILE_TARGET_WIDTH_M * 2 ** 5 / (2 * Math.PI);
    expect(
      renderedMercatorTileWidthM(0, radiusForTargetAtZoomFive, 5),
    ).toBeCloseTo(LOCAL_TILE_TARGET_WIDTH_M);
    expect(
      selectNativeTerrainZoom(0, radiusForTargetAtZoomFive),
    ).toBe(5);

    const radiusAtUpper =
      LOCAL_TILE_REFINE_WIDTH_M * 2 ** 5 / (2 * Math.PI);
    expect(selectNativeTerrainZoom(0, radiusAtUpper * 0.99, 5)).toBe(5);
    expect(selectNativeTerrainZoom(0, radiusAtUpper * 1.01, 5)).toBe(6);

    const radiusAtLower =
      LOCAL_TILE_COARSEN_WIDTH_M * 2 ** 5 / (2 * Math.PI);
    expect(selectNativeTerrainZoom(0, radiusAtLower * 1.01, 5)).toBe(5);
    expect(selectNativeTerrainZoom(0, radiusAtLower * 0.99, 5)).toBe(4);
  });

  it("builds one 8x8 cap and two identical two-tile-wide parent rings", () => {
    const radiusForZoomSix =
      LOCAL_TILE_TARGET_WIDTH_M * 2 ** 6 / (2 * Math.PI);
    const plan = selectNativeTerrainPlan({
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      displayRadiusM: radiusForZoomSix,
    });

    expect(plan.finestZoom).toBe(6);
    expect(plan.minZoom).toBe(4);
    expect(plan.active).toHaveLength(160);
    expect(plan.active.filter((tile) => tile.ring === 0)).toHaveLength(64);
    expect(plan.active.filter((tile) => tile.ring === 1)).toHaveLength(48);
    expect(plan.active.filter((tile) => tile.ring === 2)).toHaveLength(48);
    expect(
      plan.active.filter(
        (tile) => tile.meshSegments === LOCAL_UNDERFOOT_MESH_SEGMENTS,
      ),
    ).toHaveLength(4);
    expect(new Set(plan.active.map(mercatorTileKey)).size).toBe(160);
    expect(plan.required).toHaveLength(225);
    expect(new Set(plan.required.map(mercatorTileKey)).size).toBe(225);

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

  it("keeps the stencil fixed until its quadtree-aligned anchor shifts", () => {
    const radiusForZoomSix =
      LOCAL_TILE_TARGET_WIDTH_M * 2 ** 6 / (2 * Math.PI);
    const first = selectNativeTerrainPlan({
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      displayRadiusM: radiusForZoomSix,
    });
    const nearby = selectNativeTerrainPlan({
      latitudeDegrees: 0,
      longitudeDegrees: 1,
      displayRadiusM: radiusForZoomSix,
      previousBaseZoom: first.baseZoom,
    });
    const shifted = selectNativeTerrainPlan({
      latitudeDegrees: 0,
      longitudeDegrees: 30,
      displayRadiusM: radiusForZoomSix,
      previousBaseZoom: first.baseZoom,
    });

    expect(nearby.signature).toBe(first.signature);
    expect(shifted.signature).not.toBe(first.signature);
    expect(
      nativeTerrainPlanAnchorKey(0, 1, first.finestZoom),
    ).toBe(nativeTerrainPlanAnchorKey(0, 0, first.finestZoom));
  });

  it("changes the geometry signature when an overlapping boundary cell becomes interior", () => {
    const radius =
      LOCAL_TILE_TARGET_WIDTH_M * 2 ** 8 / (2 * Math.PI);
    const first = selectNativeTerrainPlan({
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      displayRadiusM: radius,
    });
    const shifted = selectNativeTerrainPlan({
      latitudeDegrees: 0,
      longitudeDegrees: 6,
      displayRadiusM: radius,
      previousBaseZoom: first.baseZoom,
    });
    const firstByKey = new Map(
      first.active.map((tile) => [mercatorTileKey(tile), tile]),
    );
    const changedOverlap = shifted.active.find((tile) => {
      const previous = firstByKey.get(mercatorTileKey(tile));
      return (
        previous !== undefined &&
        previous.geometrySignature !== tile.geometrySignature
      );
    });
    expect(changedOverlap).toBeDefined();
  });

  it("leaves low source zooms to the immutable globe", () => {
    for (const zoom of [0, 1, 2, 3, 4]) {
      const radius =
        LOCAL_TILE_TARGET_WIDTH_M * 2 ** zoom / (2 * Math.PI);
      const plan = selectNativeTerrainPlan({
        latitudeDegrees: 0,
        longitudeDegrees: 179.99,
        displayRadiusM: radius,
      });
      expect(plan.finestZoom).toBe(zoom);
      expect(plan.active).toHaveLength(0);
      expect(plan.required).toHaveLength(0);
    }
  });

  it("assigns full source density underfoot and fixed densities outside", () => {
    expect(meshSegmentsForRing(0)).toBe(128);
    expect(meshSegmentsForRing(1)).toBe(64);
    expect(meshSegmentsForRing(2)).toBe(32);

    const radiusForZoomSix =
      LOCAL_TILE_TARGET_WIDTH_M * 2 ** 6 / (2 * Math.PI);
    const plan = selectNativeTerrainPlan({
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      displayRadiusM: radiusForZoomSix,
    });
    const underfoot = plan.active.filter(
      (tile) => tile.meshSegments === LOCAL_UNDERFOOT_MESH_SEGMENTS,
    );
    expect(underfoot).toHaveLength(4);
    for (const tile of underfoot) {
      expect(
        Object.values(tile.skirtEdges).filter((edge) => edge > 0),
      ).toHaveLength(2);
      expect(Object.keys(tile.edgeConstraints)).toHaveLength(2);
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

  it("evicts an empty cached elevation tile and refetches it", async () => {
    const deleted: string[] = [];
    const stored = new Map<string, Response>();
    let fetchCalls = 0;
    const cacheStorage: ElevationCacheStorage = {
      async open() {
        return {
          async match() {
            return new Response(new Uint8Array(), { status: 200 });
          },
          async put(request, response) {
            stored.set(String(request), response.clone());
          },
          async delete(request) {
            deleted.push(String(request));
            return true;
          },
        };
      },
    };
    const fetcher = (async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
    }) as typeof fetch;

    const result = await loadCachedElevation(
      { z: 12, x: 2_031, y: 1_377 },
      new AbortController().signal,
      { cacheStorage, fetcher },
    );

    expect(deleted).toHaveLength(1);
    expect(fetchCalls).toBe(1);
    expect(result.cacheStatus).toBe("stored");
    expect([...new Uint8Array(result.bytes)]).toEqual([9, 8, 7]);
    expect(stored.size).toBe(1);
  });

  it("uses the network when the Cache API fails", async () => {
    const cacheStorage: ElevationCacheStorage = {
      async open() {
        throw new Error("Cache storage is unavailable.");
      },
    };
    let fetchCalls = 0;
    const fetcher = (async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    }) as typeof fetch;

    const result = await loadCachedElevation(
      { z: 12, x: 2_031, y: 1_377 },
      new AbortController().signal,
      { cacheStorage, fetcher },
    );

    expect(fetchCalls).toBe(1);
    expect(result.cacheStatus).toBe("error");
    expect([...new Uint8Array(result.bytes)]).toEqual([4, 5, 6]);
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

  it("maps detailed seam vertices onto the coarse edge intervals exactly", () => {
    const coarseSegments = 16;
    const step = LOCAL_TILE_SIZE / coarseSegments;
    const coarseHeight = (pixel: number): number =>
      300 + 1_700 * Math.sin(pixel / LOCAL_TILE_SIZE * Math.PI * 3.5);
    for (let pixel = 0; pixel <= LOCAL_TILE_SIZE; pixel += 1) {
      const interpolation = terrainEdgeInterpolation(
        coarseSegments,
        pixel,
      );
      expect(interpolation.firstPixel % step).toBe(0);
      expect(interpolation.secondPixel % step).toBe(0);
      expect(interpolation.secondPixel - interpolation.firstPixel).toBe(step);
      expect(interpolation.fraction).toBeGreaterThanOrEqual(0);
      expect(interpolation.fraction).toBeLessThanOrEqual(1);
      const reconstructed =
        interpolation.firstPixel +
        (interpolation.secondPixel - interpolation.firstPixel) *
          interpolation.fraction;
      expect(reconstructed).toBeCloseTo(pixel, 10);
      const conformedHeight =
        coarseHeight(interpolation.firstPixel) +
        (coarseHeight(interpolation.secondPixel) -
          coarseHeight(interpolation.firstPixel)) *
          interpolation.fraction;
      if (pixel % step === 0) {
        expect(conformedHeight).toBeCloseTo(coarseHeight(pixel), 10);
      }
    }
  });

  it("clamps coastline endpoints before interpolating a conformed seam", () => {
    const underwaterOffset = [-300, -30, 3] as const;
    const landOffset = [350, 35, -3.5] as const;
    const fraction = 0.5;
    const conformedOceanOffset = interpolateOceanSurfaceOffsetM(
      -300,
      underwaterOffset,
      350,
      landOffset,
      fraction,
    );

    expect(conformedOceanOffset).toEqual([175, 17.5, -1.75]);
    expect(conformedOceanOffset).toEqual(
      interpolateTerrainOffsetM(
        clampOceanSurfaceOffsetM(-300, underwaterOffset),
        clampOceanSurfaceOffsetM(350, landOffset),
        fraction,
      ),
    );
    expect(conformedOceanOffset).not.toEqual(
      clampOceanSurfaceOffsetM(
        25,
        interpolateTerrainOffsetM(
          underwaterOffset,
          landOffset,
          fraction,
        ),
      ),
    );
  });

  it("fades only selected patch boundaries back to global relief", () => {
    const noEdges = { north: 0, east: 0, south: 0, west: 0 };
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

  it("holds queue slots until asynchronous decode processing finishes", async () => {
    let loads = 0;
    const releases: Array<() => void> = [];
    const queue = new TileRequestQueue<number>(
      async () => ++loads,
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
      () => undefined,
      2,
    );
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      address: { z: 5, x: index, y: 1 },
      priority: index,
    }));

    queue.sync(tasks);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loads).toBe(2);
    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loads).toBe(3);
    queue.dispose();
    for (const release of releases) release();
  });

  it("aborts stale work and starts the replacement without callbacks", async () => {
    const pending = new Map<
      string,
      { resolve: (value: number) => void; signal: AbortSignal }
    >();
    const loaded: string[] = [];
    const failed: string[] = [];
    const queue = new TileRequestQueue<number>(
      (address, signal) =>
        new Promise<number>((resolve) => {
          pending.set(mercatorTileKey(address), { resolve, signal });
        }),
      (task) => {
        loaded.push(mercatorTileKey(task.address));
      },
      (task) => {
        failed.push(mercatorTileKey(task.address));
      },
      1,
    );
    const stale = { address: { z: 5, x: 1, y: 1 }, priority: 0 };
    const replacement = {
      address: { z: 5, x: 2, y: 1 },
      priority: 0,
    };
    const staleKey = mercatorTileKey(stale.address);
    const replacementKey = mercatorTileKey(replacement.address);

    queue.sync([stale]);
    queue.sync([replacement]);
    expect(pending.get(staleKey)?.signal.aborted).toBe(true);
    pending.get(staleKey)?.resolve(1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pending.has(replacementKey)).toBe(true);
    pending.get(replacementKey)?.resolve(2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loaded).toEqual([replacementKey]);
    expect(failed).toEqual([]);
    queue.dispose();
  });

  it("continues loading after a queued request fails", async () => {
    const loaded: string[] = [];
    const failed: string[] = [];
    const queue = new TileRequestQueue<number>(
      async (address) => {
        if (address.x === 1) throw new Error("Synthetic network failure.");
        return address.x;
      },
      (task) => {
        loaded.push(mercatorTileKey(task.address));
      },
      (task) => {
        failed.push(mercatorTileKey(task.address));
      },
      1,
    );
    const first = { address: { z: 5, x: 1, y: 1 }, priority: 0 };
    const second = { address: { z: 5, x: 2, y: 1 }, priority: 1 };

    queue.sync([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(failed).toEqual([mercatorTileKey(first.address)]);
    expect(loaded).toEqual([mercatorTileKey(second.address)]);
    expect(queue.activeCount).toBe(0);
    queue.dispose();
  });
});
