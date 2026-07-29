import { describe, expect, it } from "vitest";
import {
  ImageryLoadQueue,
  adaptiveLandLuminance,
  adaptiveLandLight,
  boundsForTile,
  childrenForTile,
  fallbackUvTransform,
  imageryEvictionKeys,
  imageryLoadTasksForTiles,
  imageryRetryDelayMs,
  imageryUvTransform,
  imageryUrlForTile,
  previewAddressForTile,
  rawBoundsForTile,
  selectTerrainTiles,
  terrainBoundingExpansion,
  terrainHorizonDegrees,
  terrainMaximumLevel,
  terrainOccluderRadius,
  tileMatrixDimensions,
} from "../apps/little-prince/src/terrain-tiles.js";

describe("Little Planet terrain selection", () => {
  it("lifts dark shadows without increasing fully lit highlights", () => {
    expect(adaptiveLandLight(0.05, 0)).toBeCloseTo(0.64);
    expect(adaptiveLandLight(0.05, 0.5)).toBeCloseTo(0.91);
    expect(adaptiveLandLight(0.05, 1)).toBeCloseTo(1.18);
    expect(adaptiveLandLuminance(0.05, 0)).toBeGreaterThan(0.075);
    expect(adaptiveLandLuminance(0.05, 1)).toBeGreaterThan(0.055);
    expect(adaptiveLandLuminance(0.05, 0)).toBeGreaterThan(
      adaptiveLandLuminance(0.05, 1),
    );

    expect(adaptiveLandLight(0.7, 0)).toBeCloseTo(0.46);
    expect(adaptiveLandLight(0.7, 0.5)).toBeCloseTo(0.82);
    expect(adaptiveLandLight(0.7, 1)).toBeCloseTo(1.18);
    expect(adaptiveLandLuminance(0.7, 0)).toBeCloseTo(0.7);
    expect(adaptiveLandLuminance(0.7, 1)).toBeCloseTo(0.7);
  });

  it("uses the clipped native GIBS geographic grid", () => {
    expect(tileMatrixDimensions(0)).toEqual({ columns: 2, rows: 1 });
    expect(tileMatrixDimensions(1)).toEqual({ columns: 3, rows: 2 });
    expect(tileMatrixDimensions(7)).toEqual({ columns: 160, rows: 80 });
    expect(boundsForTile({ z: 0, x: 0, y: 0 })).toEqual({
      west: -180,
      east: 108,
      north: 90,
      south: -90,
    });
    expect(boundsForTile({ z: 0, x: 1, y: 0 })).toEqual({
      west: 108,
      east: 180,
      north: 90,
      south: -90,
    });
    expect(rawBoundsForTile({ z: 0, x: 1, y: 0 })).toEqual({
      west: 108,
      east: 396,
      north: 90,
      south: -198,
    });
    expect(childrenForTile({ z: 0, x: 1, y: 0 })).toEqual([
      { z: 1, x: 2, y: 0 },
      { z: 1, x: 2, y: 1 },
    ]);
  });

  it("requests cacheable NASA WMTS tiles directly", () => {
    const url = new URL(imageryUrlForTile({ z: 6, x: 39, y: 11 }));
    expect(url.hostname).toBe("gibs.earthdata.nasa.gov");
    expect(url.pathname).toBe(
      "/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/" +
        "default/500m/6/11/39.jpeg",
    );
    expect(url.search).toBe("");
  });

  it("maps the fallback, preview, and exact imagery without edge seams", () => {
    const address = { z: 7, x: 78, y: 22 };
    const preview = previewAddressForTile(address);
    expect(preview).toEqual({ z: 5, x: 19, y: 5 });
    expect(imageryUvTransform(address, preview)).toEqual({
      scaleX: 0.25,
      scaleY: 0.25,
      offsetX: 0.5,
      offsetY: 0.5,
    });
    expect(imageryUvTransform(address, address)).toEqual({
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
    });
    expect(fallbackUvTransform({ z: 0, x: 1, y: 0 })).toEqual({
      scaleX: 0.8,
      scaleY: 1.6,
      offsetX: 0.8,
      offsetY: 0,
    });
  });

  it("keeps Quest-scale tile counts bounded while refining the apex", () => {
    for (const radius of [1, 63.71, 318.55]) {
      const tiles = selectTerrainTiles(40, -4, radius);
      expect(tiles.length).toBeGreaterThan(2);
      expect(tiles.length, `radius ${radius}`).toBeLessThan(180);
      expect(Math.max(...tiles.map((tile) => tile.z))).toBeGreaterThanOrEqual(
        2,
      );
    }
  });

  it("changes the global terrain and imagery level with planet scale", () => {
    const initialRadius = 63.710088;
    expect(terrainMaximumLevel(initialRadius / 8)).toBe(3);
    expect(terrainMaximumLevel(initialRadius / 4)).toBe(4);
    expect(terrainMaximumLevel(initialRadius / 2)).toBe(5);
    expect(terrainMaximumLevel(initialRadius)).toBe(6);
    expect(terrainMaximumLevel(initialRadius * 1.5)).toBe(7);
    expect(terrainMaximumLevel(initialRadius * 5)).toBe(7);
  });

  it("keeps an inner depth shell behind every terrain elevation", () => {
    const shallow = terrainOccluderRadius(63.710088, 0, 0);
    const deep = terrainOccluderRadius(63.710088, 10_444, 20);
    expect(shallow).toBeLessThan(1);
    expect(deep).toBeGreaterThan(0.9);
    expect(deep).toBeLessThan(shallow);
    expect(terrainOccluderRadius(318.55044, 0, 0)).toBeGreaterThan(
      shallow,
    );
  });

  it("extends visibility and displaced bounds for radial terrain", () => {
    const radius = 63.710088;
    expect(terrainHorizonDegrees(radius, 20)).toBeGreaterThan(
      terrainHorizonDegrees(radius, 1),
    );
    expect(
      terrainBoundingExpansion(10_444, radius, 20),
    ).toBeGreaterThan(
      terrainBoundingExpansion(10_444, radius, 1),
    );
    expect(selectTerrainTiles(40, -4, radius, 20).length).toBeGreaterThanOrEqual(
      selectTerrainTiles(40, -4, radius, 1).length,
    );
    expect(selectTerrainTiles(40, -4, 318.55, 20).length).toBeLessThan(400);
  });
});

describe("Little Planet imagery scheduling", () => {
  it("retries imagery quickly before settling on a bounded delay", () => {
    expect(imageryRetryDelayMs(0)).toBe(1_000);
    expect(imageryRetryDelayMs(1)).toBe(1_000);
    expect(imageryRetryDelayMs(2)).toBe(5_000);
    expect(imageryRetryDelayMs(3)).toBe(30_000);
    expect(imageryRetryDelayMs(99)).toBe(30_000);
  });

  it("deduplicates shared previews and prioritizes them before exact tiles", () => {
    const tasks = imageryLoadTasksForTiles([
      { z: 7, x: 78, y: 22 },
      { z: 7, x: 79, y: 22 },
      { z: 7, x: 90, y: 20 },
    ]);
    expect(tasks.map((task) => task.address)).toEqual([
      { z: 5, x: 19, y: 5 },
      { z: 5, x: 22, y: 5 },
      { z: 7, x: 78, y: 22 },
      { z: 7, x: 79, y: 22 },
      { z: 7, x: 90, y: 20 },
    ]);
    expect(tasks.slice(0, 2).every((task) => task.priority < 1_000)).toBe(
      true,
    );
    expect(tasks.slice(2).every((task) => task.priority >= 1_000)).toBe(true);
  });

  it("caps concurrent requests at six and starts the next queued tile", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const queue = new ImageryLoadQueue<number>(
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
      Array.from({ length: 7 }, (_, x) => ({
        address: { z: 3, x, y: 0 },
        priority: x,
      })),
    );
    expect(queue.activeCount).toBe(6);
    expect(queue.queuedCount).toBe(1);
    expect(maximumActive).toBe(6);

    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.activeCount).toBe(6);
    expect(queue.queuedCount).toBe(0);
    expect(maximumActive).toBe(6);
    for (const release of releases) release();
    queue.dispose();
  });

  it("aborts stale work without reporting it as a failed request", async () => {
    let aborted = false;
    const failures: unknown[] = [];
    const queue = new ImageryLoadQueue<number>(
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
    );
    queue.sync([
      {
        address: { z: 3, x: 1, y: 1 },
        priority: 0,
      },
    ]);
    queue.sync([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(true);
    expect(queue.activeCount).toBe(0);
    expect(failures).toEqual([]);
  });

  it("evicts the oldest unpinned textures at the 48-texture ceiling", () => {
    const items = Array.from({ length: 50 }, (_, index) => ({
      key: `tile-${index}`,
      usedAt: index,
    }));
    expect(imageryEvictionKeys(items, new Set(["tile-0"]))).toEqual([
      "tile-1",
      "tile-2",
    ]);
  });
});
