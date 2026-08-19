import type { TileIdentity } from "./tile-transition-planner.js";

export interface ElevationSourceConstraints {
  readonly tilePixels: number;
  readonly maxSourceZoom: number;
}

export interface TerrainSegmentTier {
  readonly minZoom: number;
  readonly segments: number;
}

export interface TerrainLodOptions {
  readonly segmentTiers?: readonly TerrainSegmentTier[];
  readonly maxElevationSourceZoom?: number;
}

export interface NormalizedTerrainLodOptions {
  readonly segmentTiers: readonly TerrainSegmentTier[];
  readonly maxElevationSourceZoom: number;
}

export const DEFAULT_TERRAIN_SEGMENT_TIERS: readonly TerrainSegmentTier[] =
  Object.freeze([
    Object.freeze({ minZoom: 0, segments: 16 }),
    Object.freeze({ minZoom: 7, segments: 32 }),
    Object.freeze({ minZoom: 10, segments: 64 }),
  ]);

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative integer.`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

export function normalizeTerrainSegmentTiers(
  tiers: readonly TerrainSegmentTier[] = DEFAULT_TERRAIN_SEGMENT_TIERS,
): readonly TerrainSegmentTier[] {
  if (tiers.length === 0) {
    throw new RangeError("Terrain segment tiers must not be empty.");
  }
  const normalized = tiers.map((tier, index) =>
    Object.freeze({
      minZoom: nonnegativeInteger(
        tier.minZoom,
        `Terrain segment tier ${index} minimum zoom`,
      ),
      segments: positiveInteger(
        tier.segments,
        `Terrain segment tier ${index} segments`,
      ),
    })
  );
  if (normalized[0]!.minZoom !== 0) {
    throw new RangeError(
      "The first terrain segment tier must begin at zoom zero.",
    );
  }
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]!;
    const current = normalized[index]!;
    if (current.minZoom <= previous.minZoom) {
      throw new RangeError(
        "Terrain segment tier minimum zooms must increase strictly.",
      );
    }
    if (current.segments < previous.segments) {
      throw new RangeError(
        "Terrain segment counts must not decrease at finer zooms.",
      );
    }
  }
  return Object.freeze(normalized);
}

export function normalizeTerrainLodOptions(
  source: ElevationSourceConstraints,
  options: TerrainLodOptions = {},
): NormalizedTerrainLodOptions {
  positiveInteger(source.tilePixels, "Elevation provider tile pixels");
  const providerMaximum = nonnegativeInteger(
    source.maxSourceZoom,
    "Elevation provider maximum source zoom",
  );
  const configuredMaximum = options.maxElevationSourceZoom === undefined
    ? providerMaximum
    : nonnegativeInteger(
      options.maxElevationSourceZoom,
      "Maximum elevation source zoom",
    );
  if (configuredMaximum > providerMaximum) {
    throw new RangeError(
      `Maximum elevation source zoom z${configuredMaximum} exceeds the provider maximum z${providerMaximum}.`,
    );
  }
  return Object.freeze({
    segmentTiers: normalizeTerrainSegmentTiers(options.segmentTiers),
    maxElevationSourceZoom: configuredMaximum,
  });
}

export function terrainSegmentsForZoom(
  zoom: number,
  tiers: readonly TerrainSegmentTier[] = DEFAULT_TERRAIN_SEGMENT_TIERS,
): number {
  const normalizedZoom = nonnegativeInteger(zoom, "Terrain geometry zoom");
  let selected = tiers[0];
  if (!selected) throw new RangeError("Terrain segment tiers must not be empty.");
  for (const tier of tiers) {
    if (tier.minZoom > normalizedZoom) break;
    selected = tier;
  }
  return selected.segments;
}

export function elevationSourceZoomForTile(
  tile: Pick<TileIdentity, "z">,
  maxElevationSourceZoom: number,
): number {
  return Math.min(
    nonnegativeInteger(tile.z, "Terrain geometry zoom"),
    nonnegativeInteger(
      maxElevationSourceZoom,
      "Maximum elevation source zoom",
    ),
  );
}
