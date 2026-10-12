import { describe, expect, it, vi } from "vitest";
import { availableElevationAncestor, elevationAvailability } from "../packages/worlds/src/elevation-availability.js";
import { createXyzElevationTileProvider, elevationSourceMapping, type ImageTileResource } from "../packages/worlds/src/image-tile-provider.js";
import type { TileIdentity } from "../packages/worlds/src/tile-transition-planner.js";
import { elevationSource } from "../packages/worlds/src/surface-product.js";
import { celestialBody } from "../packages/worlds/src/solar-system.js";

const coverage = elevationAvailability({ globalMaximumZoom: 6, ranges: [
  [9, 280, 250, 282, 252], [14, 8975, 8001, 8976, 8003],
] }, 14);

describe("prepared elevation availability", () => {
  it("selects native detail, an available regional ancestor, and the global fallback", () => {
    expect(availableElevationAncestor({ z: 14, x: 8975, y: 8001 }, 14, coverage)).toEqual({ z: 14, x: 8975, y: 8001 });
    expect(availableElevationAncestor({ z: 14, x: 8974, y: 8000 }, 14, coverage)).toEqual({ z: 9, x: 280, y: 250 });
    expect(availableElevationAncestor({ z: 14, x: 12000, y: 8100 }, 14, coverage)).toEqual({ z: 6, x: 46, y: 31 });
  });

  it("keeps ancestor crop UVs correct when geometry overzooms detail or falls back", () => {
    expect(elevationSourceMapping({ z: 16, x: 35901, y: 32005 }, 14, coverage)).toEqual({
      sourceTile: { z: 14, x: 8975, y: 8001 }, sourceScale: 4, sourceOffsetX: 1, sourceOffsetY: 1,
    });
    const tile = { z: 14, x: 12000, y: 8100 };
    const mapping = elevationSourceMapping(tile, 14, coverage);
    expect((mapping.sourceTile.x + (mapping.sourceOffsetX + 0.5) / mapping.sourceScale) / 2 ** mapping.sourceTile.z)
      .toBe((tile.x + 0.5) / 2 ** tile.z);
    expect((mapping.sourceTile.y + (mapping.sourceOffsetY + 0.5) / mapping.sourceScale) / 2 ** mapping.sourceTile.z)
      .toBe((tile.y + 0.5) / 2 ** tile.z);
  });

  it("admits Terrarium without changing existing RG16 products and rejects malformed coverage", () => {
    const descriptor = { kind: "elevation-xyz", formatVersion: 2, identity: "a".repeat(64), target: "moon",
      grid: { formatVersion: 1, projection: "web-mercator", radiusMetres: 1737400 }, units: "metres",
      verticalDatum: { kind: "reference-surface", radiusMetres: 1737400 }, encoding: { kind: "terrarium" },
      tileSize: 512, maximumZoom: 14, availability: coverage,
      elevationBoundsMetres: { minimum: -9500, maximum: 11000 } };
    const admitted = elevationSource(descriptor, celestialBody("moon"));
    expect(admitted.heightEncoding).toEqual({ kind: "terrarium" });
    expect(admitted.availability).toEqual(coverage);
    for (const ranges of [[[14, 0, 0, 16384, 1]], [[6, 0, 0, 1, 1]], [[9, 2, 1, 1, 2]], [[9, 1.5, 1, 2, 2]]]) {
      expect(() => elevationSource({ ...descriptor, availability: { globalMaximumZoom: 6, ranges } }, celestialBody("moon"))).toThrow();
    }
    expect(() => elevationSource({ ...descriptor, encoding: { kind: "display-rgb" } }, celestialBody("moon"))).toThrow();
  });

  it("retains prepared height bytes across provider lifetimes and isolates changed products", async () => {
    class FixtureImage {
      readonly naturalWidth = 512;
      readonly naturalHeight = 512;
      onload?: () => void;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("Image", FixtureImage);
    const retained = new Map<string, Response>();
    const cacheStorage = { async open() { return {
      async match(url: RequestInfo | URL) { return retained.get(String(url))?.clone(); },
      async put(url: RequestInfo | URL, response: Response) { retained.set(String(url), response.clone()); },
      async delete(url: RequestInfo | URL) { return retained.delete(String(url)); },
    }; } };
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(new Uint8Array([13, 37]), {
      headers: { "content-type": "image/png", "cache-control": "max-age=0" },
    }));
    const metadata = { tilePixels: 512, maxSourceZoom: 14, attribution: "fixture" };
    const requested: TileIdentity = { z: 16, x: 35901, y: 32005 };
    const load = async (identity: string) => {
      const provider = createXyzElevationTileProvider(metadata, 14, { availability: coverage, cacheStorage, fetcher,
        urlTemplate: `https://tiles.test/{z}/{x}/{y}.png?surface-product=${identity}` });
      try {
        return await new Promise<ImageTileResource>((resolve, reject) => provider.request(requested, (result) => {
          if (result.phase === "response") resolve(result.resource);
          if (result.phase === "failure") reject(new Error(result.reason));
        }));
      } finally { provider.dispose(); }
    };
    try {
      const first = await load("first");
      expect(first.sourceTile).toEqual({ z: 14, x: 8975, y: 8001 });
      expect((await load("first")).cacheStatus).toBe("persistent-hit");
      expect(fetcher).toHaveBeenCalledOnce();
      await load("second");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0]![0]).toContain("/14/8975/8001.png");
    } finally { vi.unstubAllGlobals(); }
  });
});
