import { describe, expect, it, vi } from "vitest";
import { ScheduledImageryProvider } from "@found-in-space/worlds/imagery";
import type { ImageryProvider } from "@found-in-space/worlds/imagery-provider";
import { SparseImageryProvider } from "@found-in-space/worlds/sparse-imagery-provider";
import type { TileIdentity } from "@found-in-space/worlds/tile-transition-planner";
import { lunarImageryProviders, type LunarImageryTileProduct } from "../apps/pas-de-geant/src/lunar-imagery-providers.js";

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

  it("loads one prepared Apollo XYZ tile through the ordinary provider", async () => {
    const product: LunarImageryTileProduct = {
      kind: "sparse-opaque-xyz", formatVersion: 1, identity: "fixture", tileSize: 512,
      sources: [{ id: "landing", attribution: "NAC", priority: 200,
        minimumZoom: 3, maximumZoom: 3, pathTemplate: "landing/{z}/{x}/{y}.png",
        levels: [{ zoom: 3, tiles: [[4, 3]] }] }],
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _options?: RequestInit) =>
      new Response(new Blob(["tile"], { type: "image/png" })));
    vi.stubGlobal("fetch", fetcher);
    try {
      const provider = lunarImageryProviders({ ...source("global", 2), grid: { formatVersion: 1, projection: "geographic", radiusMetres: 1_737_400 } }, product, "https://tiles.example/runtime/product.json");
      const tile = provider.resolveSource!({ z: 5, x: 17, y: 13 });
      await provider.load(tile, new AbortController().signal);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const requested = new URL(String(fetcher.mock.calls[0]![0]), "https://local.test");
      expect(requested.pathname).toBe("/runtime/landing/3/4/3.png");
      expect(requested.searchParams.get("surface-product")).toBe("geographic-xyz-v1-r1737400:fixture");
    } finally { vi.unstubAllGlobals(); }
  });
});
