import {
  tileIdentityKey,
  type ReplacementGroup,
  type TileIdentity,
} from "./tile-transition-planner.js";
import { EARTH_MEAN_RADIUS_KM, WGS84_B_KM } from "./planet-state.js";
import type { TileProjection } from "./tile-onion-core.js";
import {
  normalizedSurfaceLatitude,
  surfaceVisibilityHorizonRadians,
  type BodyLocalObserver,
  type SurfaceDisplacementBounds,
  type SurfaceVisibilityGeometry,
} from "./surface-visibility-geometry.js";

const MINIMUM_NORMALIZED_SURFACE_RADIUS = WGS84_B_KM / EARTH_MEAN_RADIUS_KM;

export interface TileHorizonView {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly displayRadiusM: number;
  readonly observerHeightWorldM: number;
  readonly projection?: TileProjection;
  readonly minimumNormalizedSurfaceRadius?: number;
  readonly surfaceGeometry?: SurfaceVisibilityGeometry;
  readonly displacementBounds?: SurfaceDisplacementBounds;
  readonly meshAngularMargin?: number;
  /** Body-local eye positions; orientation and frusta are deliberately absent. */
  readonly observerPositions?: readonly BodyLocalObserver[];
  /** Radius around each observer in body-local units, enclosing stereo eyes. */
  readonly observerRadius?: number;
}

export interface TileHorizonCullingInput {
  readonly revision: number;
  readonly committedTiles: readonly TileIdentity[];
  readonly replacementGroups: readonly ReplacementGroup[];
  readonly view: TileHorizonView;
}

export interface TileHorizonCullingMetrics {
  readonly horizonTileCount: number;
  readonly classificationTotal: number;
}

/** The planner is the sole source of tiles that horizon culling may inspect. */
export function plannerHorizonCandidates(
  committedTiles: readonly TileIdentity[],
  replacementGroups: readonly ReplacementGroup[],
): readonly TileIdentity[] {
  const candidates = new Map<string, TileIdentity>();
  for (const tile of committedTiles) {
    candidates.set(tileIdentityKey(tile), tile);
  }
  for (const group of replacementGroups) {
    for (const tile of group.after) {
      candidates.set(tileIdentityKey(tile), tile);
    }
  }
  return [...candidates.values()];
}

function inverseProjectedLatitude(
  y: number,
  projection: TileProjection,
): number {
  return projection === "geographic"
    ? Math.PI / 2 - y * Math.PI
    : Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
}

/** Minimum central angle from an observer to any point covered by a tile. */
export function minimumAngularDistanceToTile(
  tile: TileIdentity,
  latitudeRadians: number,
  longitudeRadians: number,
  projection: TileProjection = "web-mercator",
  geometry?: SurfaceVisibilityGeometry,
): number {
  const width = 2 ** tile.z;
  const west = tile.x / width * 2 * Math.PI - Math.PI;
  const east = west + 2 * Math.PI / width;
  // Wrap relative to the interval centre, so z0 and antimeridian tiles include
  // observers on either side of their western boundary.
  const observerLongitude = longitudeRadians + Math.round(
    ((west + east) / 2 - longitudeRadians) / (2 * Math.PI),
  ) * 2 * Math.PI;
  const longitude = Math.max(west, Math.min(east, observerLongitude));
  const deltaLongitude = longitude - observerLongitude;
  const latitudeForY = (y: number): number => {
    const latitude = inverseProjectedLatitude(y, projection);
    return geometry ? normalizedSurfaceLatitude(latitude, geometry) : latitude;
  };
  const north = latitudeForY(tile.y / width);
  const south = latitudeForY((tile.y + 1) / width);
  const optimumLatitude = Math.atan2(
    Math.sin(latitudeRadians),
    Math.cos(latitudeRadians) * Math.cos(deltaLongitude),
  );
  const latitude = Math.max(south, Math.min(north, optimumLatitude));
  const cosineDistance =
    Math.sin(latitudeRadians) * Math.sin(latitude) +
    Math.cos(latitudeRadians) * Math.cos(latitude) *
      Math.cos(deltaLongitude);
  return Math.acos(Math.max(-1, Math.min(1, cosineDistance)));
}

export function geometricHorizonRadians(
  displayRadiusM: number,
  observerHeightWorldM: number,
  minimumNormalizedSurfaceRadius = MINIMUM_NORMALIZED_SURFACE_RADIUS,
): number {
  const radius = Math.max(
    Number.MIN_VALUE,
    displayRadiusM * minimumNormalizedSurfaceRadius,
  );
  const height = Math.max(0, observerHeightWorldM);
  return Math.acos(radius / (radius + height));
}

export function classifyTilesWithinHorizon(
  tiles: readonly TileIdentity[],
  view: TileHorizonView,
): ReadonlySet<string> {
  if (view.surfaceGeometry) return classifyDisplacedTiles(tiles, view);
  const latitude = view.latitudeDegrees * Math.PI / 180;
  const longitude = view.longitudeDegrees * Math.PI / 180;
  const horizon = geometricHorizonRadians(
    view.displayRadiusM,
    view.observerHeightWorldM,
    view.minimumNormalizedSurfaceRadius,
  );
  const retained = new Set<string>();
  for (const tile of tiles) {
    if (
      minimumAngularDistanceToTile(
        tile,
        latitude,
        longitude,
        view.projection,
      ) <= horizon
    ) {
      retained.add(tileIdentityKey(tile));
    }
  }
  return retained;
}

/** Reference-surface fallback until a posed camera supplies actual eye positions. */
export function referenceObserverPosition(view: TileHorizonView): BodyLocalObserver {
  const geometry = view.surfaceGeometry!;
  const latitude = view.latitudeDegrees * Math.PI / 180;
  const longitude = view.longitudeDegrees * Math.PI / 180;
  const normalizedLatitude = normalizedSurfaceLatitude(latitude, geometry);
  const height = view.observerHeightWorldM / view.displayRadiusM;
  return {
    x: Math.cos(longitude) * (
      Math.cos(normalizedLatitude) / geometry.xzScale + Math.cos(latitude) * height
    ),
    y: Math.sin(normalizedLatitude) / geometry.yScale + Math.sin(latitude) * height,
    z: -Math.sin(longitude) * (
      Math.cos(normalizedLatitude) / geometry.xzScale + Math.cos(latitude) * height
    ),
  };
}

function classifyDisplacedTiles(
  tiles: readonly TileIdentity[],
  view: TileHorizonView,
): ReadonlySet<string> {
  const geometry = view.surfaceGeometry!;
  const observers = view.observerPositions ?? [referenceObserverPosition(view)];
  const retained = new Set<string>();
  for (const observer of observers) {
    const x = observer.x * geometry.xzScale;
    const y = observer.y * geometry.yScale;
    const z = observer.z * geometry.xzScale;
    const radius = Math.hypot(x, y, z);
    const eyeMargin = (view.observerRadius ?? 0) * geometry.maximumScale;
    if (!Number.isFinite(eyeMargin) || eyeMargin < 0 || eyeMargin >= radius ||
      radius - eyeMargin <= (view.displacementBounds?.innerRadius ?? Infinity)) {
      return new Set(tiles.map(tileIdentityKey));
    }
    const horizon = surfaceVisibilityHorizonRadians(radius + eyeMargin, view.displacementBounds);
    if (horizon === undefined) return new Set(tiles.map(tileIdentityKey));
    const latitude = Math.asin(Math.max(-1, Math.min(1, y / radius)));
    const longitude = Math.atan2(-z, x);
    for (const tile of tiles) {
      if (minimumAngularDistanceToTile(
        tile, latitude, longitude, view.projection, geometry,
      ) <= horizon + Math.asin(eyeMargin / radius) + (view.meshAngularMargin ?? 0)) {
        retained.add(tileIdentityKey(tile));
      }
    }
  }
  return retained;
}

function sameKeys(
  first: ReadonlySet<string>,
  second: ReadonlySet<string>,
): boolean {
  if (first.size !== second.size) return false;
  for (const key of first) if (!second.has(key)) return false;
  return true;
}

/**
 * Intersects planner-owned topology with the geometric surface horizon.
 * Head direction and camera frusta are deliberately absent.
 */
export class TileHorizonCulling {
  private retainedKeysValue = new Set<string>();
  private revisionValue: number | undefined;
  private classificationTotal = 0;

  get metrics(): TileHorizonCullingMetrics {
    return {
      horizonTileCount: this.retainedKeysValue.size,
      classificationTotal: this.classificationTotal,
    };
  }

  update(input: TileHorizonCullingInput): readonly TileIdentity[] | undefined {
    const candidates = plannerHorizonCandidates(
      input.committedTiles,
      input.replacementGroups,
    );
    const retained = classifyTilesWithinHorizon(candidates, input.view);
    this.classificationTotal += 1;
    if (
      this.revisionValue === input.revision &&
      sameKeys(this.retainedKeysValue, retained)
    ) return undefined;
    this.revisionValue = input.revision;
    this.retainedKeysValue = new Set(retained);
    return candidates.filter((tile) => retained.has(tileIdentityKey(tile)));
  }
}
