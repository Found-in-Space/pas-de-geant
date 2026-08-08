import {
  tileIdentityKey,
  type ReplacementGroup,
  type TileIdentity,
} from "./tile-transition-planner.js";
import { EARTH_MEAN_RADIUS_KM, WGS84_B_KM } from "./planet-state.js";

const MINIMUM_NORMALIZED_SURFACE_RADIUS = WGS84_B_KM / EARTH_MEAN_RADIUS_KM;

export interface TileHorizonView {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly displayRadiusM: number;
  readonly observerHeightWorldM: number;
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

function inverseMercatorLatitude(y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
}

function unwrapLongitude(longitude: number, reference: number): number {
  const turns = (longitude - reference) / (2 * Math.PI);
  return longitude - Math.round(turns) * 2 * Math.PI;
}

/** Minimum central angle from an observer to any point covered by a tile. */
export function minimumAngularDistanceToTile(
  tile: TileIdentity,
  latitudeRadians: number,
  longitudeRadians: number,
): number {
  const width = 2 ** tile.z;
  const west = unwrapLongitude(
    tile.x / width * 2 * Math.PI - Math.PI,
    longitudeRadians,
  );
  const east = west + 2 * Math.PI / width;
  const longitude = Math.max(west, Math.min(east, longitudeRadians));
  const deltaLongitude = longitude - longitudeRadians;
  const north = inverseMercatorLatitude(tile.y / width);
  const south = inverseMercatorLatitude((tile.y + 1) / width);
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
): number {
  const radius = Math.max(
    Number.MIN_VALUE,
    displayRadiusM * MINIMUM_NORMALIZED_SURFACE_RADIUS,
  );
  const height = Math.max(0, observerHeightWorldM);
  return Math.acos(radius / (radius + height));
}

export function classifyTilesWithinHorizon(
  tiles: readonly TileIdentity[],
  view: TileHorizonView,
): ReadonlySet<string> {
  const latitude = view.latitudeDegrees * Math.PI / 180;
  const longitude = view.longitudeDegrees * Math.PI / 180;
  const horizon = geometricHorizonRadians(
    view.displayRadiusM,
    view.observerHeightWorldM,
  );
  const retained = new Set<string>();
  for (const tile of tiles) {
    if (minimumAngularDistanceToTile(tile, latitude, longitude) <= horizon) {
      retained.add(tileIdentityKey(tile));
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
