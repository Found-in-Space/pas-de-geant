import { describe, expect, it, vi } from "vitest";
import { ScheduledImageryProvider } from "../packages/pas-de-geant/src/worlds/imagery.js";
import type { ImageryProvider } from "../packages/pas-de-geant/src/worlds/imagery-provider.js";
import { SparseImageryProvider } from "../packages/pas-de-geant/src/worlds/sparse-imagery-provider.js";
import type { TileIdentity } from "../packages/pas-de-geant/src/worlds/tile-transition-planner.js";

function source(id: string, maxZoom: number): ImageryProvider {
  return { id, attribution: id, tileSize: 512, minZoom: 0, maxZoom,
    load: vi.fn(async () => new Blob([id], { type: "image/png" })) };
}

function sparse(provider: ImageryProvider, tiles: TileIdentity[], priority: number) {
  return { provider, priority, hasTile: (tile: TileIdentity) => tiles.some(
    (candidate) => candidate.z === tile.z && candidate.x === tile.x && candidate.y === tile.y) };
}

describe("available imagery source selection", () => {
  it("chooses resolution, then priority, and dispatches only the selected tile", async () => {
    const global = source("global", 1);
    const context = source("context", 3);
    const detail = source("detail", 4);
    const parent = { z: 3, x: 4, y: 3 };
    const provider = new SparseImageryProvider(global, [
      sparse(context, [parent], 0), sparse(detail, [parent], 100),
    ]);
    const requested = { z: 5, x: 17, y: 13 };
    expect(provider.resolveSource(requested)).toEqual(parent);
    expect(provider.resolveSource(parent)).toEqual(parent);
    expect(await (await provider.load(parent, new AbortController().signal)).text()).toBe("detail");
    expect(detail.load).toHaveBeenCalledWith(parent, expect.any(AbortSignal));
    expect(context.load).not.toHaveBeenCalled();
    expect(global.load).not.toHaveBeenCalled();

    const finer = new SparseImageryProvider(global, [
      sparse(context, [parent], 0), sparse(detail, [{ z: 2, x: 2, y: 1 }], 100),
    ]);
    expect(finer.resolveSource(requested)).toEqual(parent);
    expect(await (await finer.load(parent, new AbortController().signal)).text()).toBe("context");
  });

  it("uses the available sparse parent in a hole and the global cap outside coverage", () => {
    const global = source("global", 2);
    const detail = source("detail", 5);
    const provider = new SparseImageryProvider(global, [
      sparse(detail, [{ z: 3, x: 4, y: 3 }], 100),
    ]);
    expect(provider.resolveSource({ z: 6, x: 33, y: 25 })).toEqual({ z: 3, x: 4, y: 3 });
    expect(provider.resolveSource({ z: 6, x: 1, y: 1 })).toEqual({ z: 2, x: 0, y: 0 });
  });

  it("shares acquisition and decoding of a selected parent through the existing queue", async () => {
    const global = source("global", 2);
    const detail = source("detail", 3);
    const provider = new SparseImageryProvider(global, [
      sparse(detail, [{ z: 3, x: 4, y: 3 }], 100),
    ]);
    const decode = vi.fn(async () => new Uint8Array([10, 20, 30, 255]));
    const scheduled = new ScheduledImageryProvider(provider, decode);
    const requested = [{ z: 5, x: 16, y: 12 }, { z: 5, x: 17, y: 13 }];
    const resources = await Promise.all(requested.map((tile) => new Promise<any>((resolve, reject) => {
      scheduled.request(tile, (event) => {
        if (event.phase === "response") resolve(event.resource);
        if (event.phase === "failure") reject(new Error(event.reason));
      });
    })));
    expect(resources.map((resource) => resource.tile)).toEqual(requested);
    expect(resources.every((resource) => resource.sourceTile.z === 3)).toBe(true);
    expect(detail.load).toHaveBeenCalledTimes(1);
    expect(global.load).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledTimes(1);
    scheduled.dispose();
  });

  it("preserves the selected provider's separate cache and network stages", async () => {
    const global = source("global", 2);
    const detail = source("detail", 3);
    detail.loadFromCache = vi.fn(async () => new Blob(["cached"], { type: "image/png" }));
    detail.loadFromNetwork = vi.fn();
    const parent = { z: 3, x: 4, y: 3 };
    const provider = new SparseImageryProvider(global, [sparse(detail, [parent], 100)]);
    const scheduled = new ScheduledImageryProvider(provider);
    await new Promise<void>((resolve, reject) => {
      scheduled.request({ z: 5, x: 17, y: 13 }, (event) => {
        if (event.phase === "response") resolve();
        if (event.phase === "failure") reject(new Error(event.reason));
      });
    });
    expect(detail.loadFromCache).toHaveBeenCalledWith(parent, expect.any(AbortSignal));
    expect(detail.loadFromNetwork).not.toHaveBeenCalled();
    expect(detail.load).not.toHaveBeenCalled();
    scheduled.dispose();
  });

});
