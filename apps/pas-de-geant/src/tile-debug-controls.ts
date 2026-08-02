import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";

export type TileDebugTarget = "terrain" | "textures" | "both";

export const DEFAULT_TERRAIN_SCREEN_PIXELS_PER_SOURCE_PIXEL = 2;
export const DEFAULT_TEXTURE_SCREEN_PIXELS_PER_SOURCE_PIXEL = 1;

export interface TilePipelineDebugControls {
  readonly screenPixelsPerSourcePixel: number;
  readonly maxZoom: number | null;
  readonly viewDistanceEnabled: boolean;
  readonly deltaZoomCap: number | null;
  readonly recalculationEnabled: boolean;
}

export interface TileDebugControls {
  readonly terrain: TilePipelineDebugControls;
  readonly textures: TilePipelineDebugControls;
  readonly overheadPercent: number;
}

export interface TileDebugControlsReadback {
  readonly terrain: {
    readonly screen_pixels_per_source_pixel: number;
    readonly max_zoom: number | null;
    readonly view_distance_enabled: boolean;
    readonly delta_zoom_cap: number | null;
    readonly recalculation_enabled: boolean;
    readonly effective_target_zoom: number;
  };
  readonly textures: {
    readonly screen_pixels_per_source_pixel: number;
    readonly max_zoom: number | null;
    readonly view_distance_enabled: boolean;
    readonly delta_zoom_cap: number | null;
    readonly recalculation_enabled: boolean;
    readonly effective_target_zoom: number;
  };
  readonly view_overhead_percent: number;
}

const DEFAULT_TERRAIN_CONTROLS: TilePipelineDebugControls = Object.freeze({
  screenPixelsPerSourcePixel: DEFAULT_TERRAIN_SCREEN_PIXELS_PER_SOURCE_PIXEL,
  maxZoom: null,
  viewDistanceEnabled: true,
  deltaZoomCap: null,
  recalculationEnabled: true,
});

const DEFAULT_TEXTURE_CONTROLS: TilePipelineDebugControls = Object.freeze({
  screenPixelsPerSourcePixel: DEFAULT_TEXTURE_SCREEN_PIXELS_PER_SOURCE_PIXEL,
  maxZoom: null,
  viewDistanceEnabled: true,
  deltaZoomCap: null,
  recalculationEnabled: true,
});

export const DEFAULT_TILE_DEBUG_CONTROLS: TileDebugControls = Object.freeze({
  terrain: DEFAULT_TERRAIN_CONTROLS,
  textures: DEFAULT_TEXTURE_CONTROLS,
  overheadPercent: 25,
});

export function createTileDebugControls(): TileDebugControls {
  return {
    terrain: { ...DEFAULT_TERRAIN_CONTROLS },
    textures: { ...DEFAULT_TEXTURE_CONTROLS },
    overheadPercent: DEFAULT_TILE_DEBUG_CONTROLS.overheadPercent,
  };
}

/** Residency-only controls must not disturb normal imagery zoom hysteresis. */
export function tileTopologySelectionChanged(
  previous: TilePipelineDebugControls,
  next: TilePipelineDebugControls,
): boolean {
  return previous.screenPixelsPerSourcePixel !==
      next.screenPixelsPerSourcePixel ||
    previous.maxZoom !== next.maxZoom;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object.");
  }
  return value as Record<string, unknown>;
}

function target(value: unknown): TileDebugTarget {
  if (value !== "terrain" && value !== "textures" && value !== "both") {
    throw new Error("Target must be terrain, textures, or both.");
  }
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, name: string): number {
  const parsed = finiteNumber(value, name);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }
  return parsed;
}

export interface TilePixelRatioArguments {
  readonly target: TileDebugTarget;
  readonly screenPixelsPerSourcePixel: number;
}

export function parseTilePixelRatioArguments(
  value: unknown,
): TilePixelRatioArguments {
  const argumentsValue = record(value);
  const ratio = finiteNumber(
    argumentsValue.screen_pixels_per_source_pixel,
    "screen_pixels_per_source_pixel",
  );
  if (ratio <= 0) {
    throw new Error("screen_pixels_per_source_pixel must be positive.");
  }
  return {
    target: target(argumentsValue.target),
    screenPixelsPerSourcePixel: ratio,
  };
}

export interface TileOptionalZoomArguments {
  readonly target: TileDebugTarget;
  readonly value: number | null;
}

function parseOptionalZoom(
  value: unknown,
  property: "max_zoom" | "delta_zoom",
): TileOptionalZoomArguments {
  const argumentsValue = record(value);
  const enabled = boolean(argumentsValue.enabled, "enabled");
  return {
    target: target(argumentsValue.target),
    value: enabled
      ? nonnegativeInteger(argumentsValue[property], property)
      : null,
  };
}

export function parseTileMaxZoomArguments(
  value: unknown,
): TileOptionalZoomArguments {
  return parseOptionalZoom(value, "max_zoom");
}

export function parseTileDeltaZoomCapArguments(
  value: unknown,
): TileOptionalZoomArguments {
  return parseOptionalZoom(value, "delta_zoom");
}

export interface TileViewDistanceArguments {
  readonly target: TileDebugTarget;
  readonly enabled: boolean;
}

export function parseTileViewDistanceArguments(
  value: unknown,
): TileViewDistanceArguments {
  const argumentsValue = record(value);
  return {
    target: target(argumentsValue.target),
    enabled: boolean(argumentsValue.enabled, "enabled"),
  };
}

export function parseTileViewOverheadArguments(value: unknown): number {
  const overhead = finiteNumber(
    record(value).overhead_percent,
    "overhead_percent",
  );
  if (overhead < 0) throw new Error("overhead_percent must be nonnegative.");
  return overhead;
}

export function parseTileRecalculationArguments(
  value: unknown,
): TileViewDistanceArguments {
  const argumentsValue = record(value);
  return {
    target: target(argumentsValue.target),
    enabled: boolean(argumentsValue.enabled, "enabled"),
  };
}

function updateTargets(
  controls: TileDebugControls,
  selectedTarget: TileDebugTarget,
  update: (
    pipeline: TilePipelineDebugControls,
  ) => TilePipelineDebugControls,
): TileDebugControls {
  return {
    ...controls,
    terrain: selectedTarget === "textures"
      ? controls.terrain
      : update(controls.terrain),
    textures: selectedTarget === "terrain"
      ? controls.textures
      : update(controls.textures),
  };
}

export function withTilePixelRatio(
  controls: TileDebugControls,
  argumentsValue: TilePixelRatioArguments,
): TileDebugControls {
  return updateTargets(controls, argumentsValue.target, (pipeline) => ({
    ...pipeline,
    screenPixelsPerSourcePixel: argumentsValue.screenPixelsPerSourcePixel,
  }));
}

export function withTileMaxZoom(
  controls: TileDebugControls,
  argumentsValue: TileOptionalZoomArguments,
): TileDebugControls {
  return updateTargets(controls, argumentsValue.target, (pipeline) => ({
    ...pipeline,
    maxZoom: argumentsValue.value,
  }));
}

export function withTileViewDistance(
  controls: TileDebugControls,
  argumentsValue: TileViewDistanceArguments,
): TileDebugControls {
  return updateTargets(controls, argumentsValue.target, (pipeline) => ({
    ...pipeline,
    viewDistanceEnabled: argumentsValue.enabled,
  }));
}

export function withTileDeltaZoomCap(
  controls: TileDebugControls,
  argumentsValue: TileOptionalZoomArguments,
): TileDebugControls {
  return updateTargets(controls, argumentsValue.target, (pipeline) => ({
    ...pipeline,
    deltaZoomCap: argumentsValue.value,
  }));
}

export function withTileRecalculation(
  controls: TileDebugControls,
  argumentsValue: TileViewDistanceArguments,
): TileDebugControls {
  return updateTargets(controls, argumentsValue.target, (pipeline) => ({
    ...pipeline,
    recalculationEnabled: argumentsValue.enabled,
  }));
}

export function eligiblePayloadTiles(
  tiles: readonly TileIdentity[],
  finestTargetZoom: number,
  deltaZoomCap: number | null,
): TileIdentity[] {
  if (deltaZoomCap === null) return [...tiles];
  const minimumZoom = finestTargetZoom - deltaZoomCap;
  return tiles.filter(
    (tile) => tile.z <= finestTargetZoom && tile.z >= minimumZoom,
  );
}

export function demandedPayloadTiles(
  tiles: readonly TileIdentity[],
  finestTargetZoom: number,
  deltaZoomCap: number | null,
  viewDistanceEnabled: boolean,
  warmKeys: ReadonlySet<string>,
): TileIdentity[] {
  const eligible = eligiblePayloadTiles(
    tiles,
    finestTargetZoom,
    deltaZoomCap,
  );
  if (!viewDistanceEnabled) return eligible;
  return eligible.filter((tile) =>
    warmKeys.has(tileIdentityKey(tile))
  );
}

export function tileDebugControlsReadback(
  controls: TileDebugControls,
  effectiveTerrainTargetZoom: number,
  effectiveTextureTargetZoom: number,
): TileDebugControlsReadback {
  const pipeline = (
    value: TilePipelineDebugControls,
    effectiveTargetZoom: number,
  ) => ({
    screen_pixels_per_source_pixel: value.screenPixelsPerSourcePixel,
    max_zoom: value.maxZoom,
    view_distance_enabled: value.viewDistanceEnabled,
    delta_zoom_cap: value.deltaZoomCap,
    recalculation_enabled: value.recalculationEnabled,
    effective_target_zoom: effectiveTargetZoom,
  });
  return {
    terrain: pipeline(controls.terrain, effectiveTerrainTargetZoom),
    textures: pipeline(controls.textures, effectiveTextureTargetZoom),
    view_overhead_percent: controls.overheadPercent,
  };
}
