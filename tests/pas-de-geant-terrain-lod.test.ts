import { describe, expect, it, vi } from "vitest";
import {
  elevationSourceMapping,
  ImageTileProvider,
  MAPTERHORN_ELEVATION_PROVIDER_METADATA,
  type ImageTileResource,
} from "../apps/pas-de-geant/src/image-tile-provider.js";
import {
  elevationSourceZoomForTile,
  normalizeTerrainLodOptions,
  terrainSegmentsForZoom,
} from "../apps/pas-de-geant/src/terrain-lod.js";
import type { TileProviderResult } from "../apps/pas-de-geant/src/tile-provider.js";
import type { TileIdentity } from "../apps/pas-de-geant/src/tile-transition-planner.js";

describe("Terrain LOD configuration", () => {
  it("preserves the existing geometry tiers and provider-limited elevation mapping", () => {
    const options = normalizeTerrainLodOptions(
      MAPTERHORN_ELEVATION_PROVIDER_METADATA,
    );

    expect(MAPTERHORN_ELEVATION_PROVIDER_METADATA).toEqual({
      tilePixels: 512,
      maxSourceZoom: 12,
      attribution: "Mapterhorn · Terrarium elevation tiles",
      elevationBoundsMetres: {
        minimum: -32_768,
        maximum: 32_767 + 255 / 256,
      },
    });
    expect([
      terrainSegmentsForZoom(0, options.segmentTiers),
      terrainSegmentsForZoom(6, options.segmentTiers),
      terrainSegmentsForZoom(7, options.segmentTiers),
      terrainSegmentsForZoom(9, options.segmentTiers),
      terrainSegmentsForZoom(10, options.segmentTiers),
      terrainSegmentsForZoom(20, options.segmentTiers),
    ]).toEqual([16, 16, 32, 32, 64, 64]);
    expect(elevationSourceZoomForTile(
      { z: 4 },
      options.maxElevationSourceZoom,
    )).toBe(4);
    expect(elevationSourceZoomForTile(
      { z: 12 },
      options.maxElevationSourceZoom,
    )).toBe(12);
    expect(elevationSourceZoomForTile(
      { z: 15 },
      options.maxElevationSourceZoom,
    )).toBe(12);
  });

  it("keeps geometry tiers independent from elevation source selection", () => {
    const options = normalizeTerrainLodOptions(
      MAPTERHORN_ELEVATION_PROVIDER_METADATA,
      {
        segmentTiers: [{ minZoom: 0, segments: 48 }],
        maxElevationSourceZoom: 11,
      },
    );

    expect(terrainSegmentsForZoom(12, options.segmentTiers)).toBe(48);
    expect(elevationSourceZoomForTile(
      { z: 12 },
      options.maxElevationSourceZoom,
    )).toBe(11);
    expect(elevationSourceMapping(
      { z: 12, x: 95, y: 47 },
      options.maxElevationSourceZoom,
    )).toEqual({
      sourceTile: { z: 11, x: 47, y: 23 },
      sourceScale: 2,
      sourceOffsetX: 1,
      sourceOffsetY: 1,
    });
  });

  it("uses arbitrary provider maxima and validates explicit overrides", () => {
    const provider = { tilePixels: 256, maxSourceZoom: 14 };
    const defaults = normalizeTerrainLodOptions(provider);
    const lower = normalizeTerrainLodOptions(provider, {
      maxElevationSourceZoom: 8,
    });

    expect(defaults.maxElevationSourceZoom).toBe(14);
    expect(elevationSourceZoomForTile(
      { z: 20 },
      defaults.maxElevationSourceZoom,
    )).toBe(14);
    expect(elevationSourceZoomForTile(
      { z: 20 },
      lower.maxElevationSourceZoom,
    )).toBe(8);
    expect(() => normalizeTerrainLodOptions(provider, {
      maxElevationSourceZoom: 15,
    })).toThrow("exceeds the provider maximum z14");
  });

  it("validates segment tiers without imposing an artificial size cap", () => {
    expect(() => normalizeTerrainLodOptions(
      MAPTERHORN_ELEVATION_PROVIDER_METADATA,
      { segmentTiers: [] },
    )).toThrow("must not be empty");
    expect(() => normalizeTerrainLodOptions(
      MAPTERHORN_ELEVATION_PROVIDER_METADATA,
      { segmentTiers: [{ minZoom: 1, segments: 64 }] },
    )).toThrow("begin at zoom zero");
    expect(() => normalizeTerrainLodOptions(
      MAPTERHORN_ELEVATION_PROVIDER_METADATA,
      {
        segmentTiers: [
          { minZoom: 0, segments: 64 },
          { minZoom: 8, segments: 32 },
        ],
      },
    )).toThrow("must not decrease");
    expect(normalizeTerrainLodOptions(
      MAPTERHORN_ELEVATION_PROVIDER_METADATA,
      { segmentTiers: [{ minZoom: 0, segments: 1_024 }] },
    ).segmentTiers[0]!.segments).toBe(1_024);
  });

  it("crops and coalesces fine geometry children through the configured ancestor", async () => {
    const options = normalizeTerrainLodOptions(
      MAPTERHORN_ELEVATION_PROVIDER_METADATA,
    );
    const loadSource = vi.fn(async (_source: TileIdentity) => ({
      image: {} as HTMLImageElement,
      byteLength: 1_024,
      cacheStatus: "provider" as const,
    }));
    const provider = new ImageTileProvider({
      mode: "terrain",
      tilePixels: MAPTERHORN_ELEVATION_PROVIDER_METADATA.tilePixels,
      concurrency: 1,
      resolveSource: (tile) =>
        elevationSourceMapping(tile, options.maxElevationSourceZoom),
      loadSource,
    });
    const resources: ImageTileResource[] = [];
    const observe = (
      result: TileProviderResult<ImageTileResource>,
    ): void => {
      if (result.phase === "response") resources.push(result.resource);
    };

    provider.request({ z: 15, x: 80, y: 80 }, observe);
    provider.request({ z: 15, x: 81, y: 80 }, observe);
    await vi.waitFor(() => expect(resources).toHaveLength(2));

    expect(loadSource).toHaveBeenCalledOnce();
    expect(loadSource.mock.calls[0]![0]).toEqual({ z: 12, x: 10, y: 10 });
    expect(resources.map((resource) => ({
      sourceTile: resource.sourceTile,
      sourceScale: resource.sourceScale,
      sourceOffsetX: resource.sourceOffsetX,
      sourceOffsetY: resource.sourceOffsetY,
    }))).toEqual([
      {
        sourceTile: { z: 12, x: 10, y: 10 },
        sourceScale: 8,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
      },
      {
        sourceTile: { z: 12, x: 10, y: 10 },
        sourceScale: 8,
        sourceOffsetX: 1,
        sourceOffsetY: 0,
      },
    ]);
    provider.dispose();
  });
});
