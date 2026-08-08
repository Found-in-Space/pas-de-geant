import { describe, expect, it, vi } from "vitest";
import { ElevationTileProvider } from "../apps/pas-de-geant/src/elevation-tile-provider.js";
import type {
  ImageTileProvider,
  ImageTileResource,
} from "../apps/pas-de-geant/src/image-tile-provider.js";
import type { TileProviderResult } from "../apps/pas-de-geant/src/tile-provider.js";
import { TileTransitionScheduler } from "../apps/pas-de-geant/src/tile-transition-scheduler.js";
import { tileIdentityKey, type TileIdentity } from "../apps/pas-de-geant/src/tile-transition-planner.js";

function provider() {
  let observer: ((result: TileProviderResult<never>) => void) | undefined;
  return {
    tilePixels: 512,
    request: (
      _tile: unknown,
      next: (result: TileProviderResult<never>) => void,
    ) => {
      observer = next;
      return { requestId: 1, cancel() {} };
    },
    dispose() {},
    deliver(result: TileProviderResult<never>) {
      observer!(result);
    },
  };
}

describe("Elevation tile provider", () => {
  it("forwards demand and retry admission to the cache-first provider", () => {
    const images = {
      tilePixels: 512,
      updateDemand: vi.fn(),
      resumeDeferred: vi.fn(),
    } as unknown as ImageTileProvider;
    const surface = new ElevationTileProvider(images);
    const demand = [{ z: 3, x: 4, y: 2 }];

    surface.updateDemand(demand);
    surface.resumeDeferred();

    expect(images.updateDemand).toHaveBeenCalledWith(demand);
    expect(images.resumeDeferred).toHaveBeenCalledOnce();
  });

  it("commits elevation without waiting for any imagery work", () => {
    const elevation = provider();
    const surface = new ElevationTileProvider(
      elevation as unknown as ImageTileProvider,
    );
    const results: TileProviderResult<unknown>[] = [];
    surface.request({ z: 0, x: 0, y: 0 }, (result) => results.push(result));

    const elevationResource: ImageTileResource = {
      kind: "image",
      mode: "terrain",
      tile: { z: 0, x: 0, y: 0 },
      sourceTile: { z: 0, x: 0, y: 0 },
      image: {} as HTMLImageElement,
      tilePixels: 512,
      sourceScale: 1,
      sourceOffsetX: 0,
      sourceOffsetY: 0,
      cacheStatus: "memory",
      loadDurationMs: 0,
      byteLength: 0,
    };
    elevation.deliver({
      phase: "response",
      resource: elevationResource as never,
    });

    expect(results).toEqual([
      {
        phase: "response",
        resource: {
          kind: "elevation",
          tile: { z: 0, x: 0, y: 0 },
          elevation: elevationResource,
        },
      },
    ]);
  });

  it("treats only an explicit elevation 404 as a flat terrain response", () => {
    const elevation = provider();
    const surface = new ElevationTileProvider(
      elevation as unknown as ImageTileProvider,
    );
    const results: TileProviderResult<unknown>[] = [];
    surface.request({ z: 1, x: 0, y: 0 }, (result) => results.push(result));

    elevation.deliver({ phase: "failure", reason: "anything", status: 404 });
    expect(results[0]).toEqual({
      phase: "response",
      resource: { kind: "elevation", tile: { z: 1, x: 0, y: 0 } },
    });
  });

  it("keeps non-404 elevation failures retryable", () => {
    const elevation = provider();
    const surface = new ElevationTileProvider(
      elevation as unknown as ImageTileProvider,
    );
    const results: TileProviderResult<unknown>[] = [];
    surface.request({ z: 1, x: 0, y: 0 }, (result) => results.push(result));

    elevation.deliver({ phase: "failure", reason: "unavailable", status: 503 });

    expect(results).toEqual([
      { phase: "failure", reason: "unavailable", status: 503 },
    ]);
  });

  it("lets an atomic sibling group commit when one elevation cell is a 404", () => {
    let nextRequestId = 1;
    const observers = new Map<
      string,
      (result: TileProviderResult<ImageTileResource>) => void
    >();
    const images = {
      tilePixels: 512,
      request: (
        tile: TileIdentity,
        observer: (result: TileProviderResult<ImageTileResource>) => void,
      ) => {
        observers.set(tileIdentityKey(tile), observer);
        return { requestId: nextRequestId++, cancel() {} };
      },
      dispose() {},
    } as unknown as ImageTileProvider;
    const parent = [{ z: 0, x: 0, y: 0 }];
    const children = [
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ];
    const layout = {
      calculate(target: "parent" | "children") {
        return target === "parent" ? parent : children;
      },
    };
    const scheduler = new TileTransitionScheduler(
      "parent" as "parent" | "children",
      layout,
      new ElevationTileProvider(images),
    );

    scheduler.updateTarget("children");
    for (const tile of children) {
      const key = tileIdentityKey(tile);
      if (key === "1/1/0") {
        observers.get(key)!({ phase: "failure", reason: "missing", status: 404 });
      } else {
        observers.get(key)!({
          phase: "response",
          resource: {
            kind: "image",
            mode: "terrain",
            tile,
            sourceTile: tile,
            image: {} as HTMLImageElement,
            tilePixels: 512,
            sourceScale: 1,
            sourceOffsetX: 0,
            sourceOffsetY: 0,
            cacheStatus: "memory",
            loadDurationMs: 0,
            byteLength: 0,
          },
        });
      }
    }

    expect(scheduler.snapshot.committedCut).toEqual(children);
    expect(scheduler.committedResource({ z: 1, x: 1, y: 0 })).toEqual({
      kind: "elevation",
      tile: { z: 1, x: 1, y: 0 },
    });
  });
});
