import { describe, expect, it } from "vitest";
import {
  ImageryLoadQueue,
  fallbackUvTransform,
  imageryUvTransform,
  previewAddressForTile,
  selectTerrainTiles,
  terrainMaximumLevel,
} from "../apps/pas-de-geant/src/terrain-tiles.js";

describe("Pas de Géant terrain regressions", () => {
  it("maps fallback, preview, and exact imagery without seams", () => {
    const address = { z: 7, x: 78, y: 22 };
    const preview = previewAddressForTile(address);
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

  it("keeps Quest-scale tile selection bounded while refining the apex", () => {
    for (const radius of [1, 63.71, 318.55]) {
      const tiles = selectTerrainTiles(40, -104, radius);
      expect(tiles.length).toBeGreaterThanOrEqual(2);
      expect(tiles.length).toBeLessThan(180);
      expect(Math.max(...tiles.map((tile) => tile.z))).toBe(
        terrainMaximumLevel(radius, 40),
      );
    }
  });

  it("aborts stale imagery without reporting a network failure", async () => {
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
});
