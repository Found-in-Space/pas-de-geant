import { tileIdentityKey, type TileIdentity } from "./tile-transition-planner.js";

export interface GeographicPoint {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export interface ViewVisibilityInput {
  readonly footprint: readonly GeographicPoint[];
}

export function sameTileKeys(
  first: ReadonlySet<string>,
  second: ReadonlySet<string>,
): boolean {
  if (first.size !== second.size) return false;
  for (const key of first) if (!second.has(key)) return false;
  return true;
}

export interface CartesianPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MutableCartesianPoint {
  x: number;
  y: number;
  z: number;
}

/** Intersects a ray with an axis-aligned ellipsoid. */
export function intersectEllipsoidRay(
  origin: CartesianPoint,
  direction: CartesianPoint,
  equatorialRadius: number,
  polarRadius: number,
  target: MutableCartesianPoint,
): boolean {
  const inverseEquatorialSquared =
    1 / (equatorialRadius * equatorialRadius);
  const inversePolarSquared = 1 / (polarRadius * polarRadius);
  const a =
    (direction.x * direction.x + direction.z * direction.z) *
      inverseEquatorialSquared +
    direction.y * direction.y * inversePolarSquared;
  const halfB =
    (origin.x * direction.x + origin.z * direction.z) *
      inverseEquatorialSquared +
    origin.y * direction.y * inversePolarSquared;
  const c =
    (origin.x * origin.x + origin.z * origin.z) *
      inverseEquatorialSquared +
    origin.y * origin.y * inversePolarSquared -
    1;
  const discriminant = halfB * halfB - a * c;
  let distance = 0;
  let hit = false;
  if (discriminant >= 0) {
    const root = Math.sqrt(discriminant);
    const near = (-halfB - root) / a;
    const far = (-halfB + root) / a;
    if (near >= 0) {
      distance = near;
      hit = true;
    } else if (far >= 0) {
      distance = far;
      hit = true;
    }
  }
  if (!hit) return false;
  target.x = origin.x + direction.x * distance;
  target.y = origin.y + direction.y * distance;
  target.z = origin.z + direction.z * distance;
  return true;
}

interface MercatorPoint {
  readonly x: number;
  readonly y: number;
}

function normalizedMercatorPoint(point: GeographicPoint): MercatorPoint {
  const x = ((((point.longitudeDegrees + 180) % 360) + 360) % 360) / 360;
  const latitude = Math.max(
    -85.05112878,
    Math.min(85.05112878, point.latitudeDegrees),
  ) * Math.PI / 180;
  return {
    x,
    y:
      (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) /
      2,
  };
}

function unwrapX(x: number, reference: number): number {
  return reference + ((((x - reference) % 1) + 1.5) % 1 - 0.5);
}

function cross(
  origin: MercatorPoint,
  first: MercatorPoint,
  second: MercatorPoint,
): number {
  return (first.x - origin.x) * (second.y - origin.y) -
    (first.y - origin.y) * (second.x - origin.x);
}

function convexHull(points: readonly MercatorPoint[]): readonly MercatorPoint[] {
  if (points.length <= 1) return points;
  const sorted = [...points].sort(
    (first, second) => first.x - second.x || first.y - second.y,
  );
  const unique = sorted.filter((point, index) =>
    index === 0 || point.x !== sorted[index - 1]!.x ||
      point.y !== sorted[index - 1]!.y
  );
  if (unique.length <= 2) return unique;
  const lower: MercatorPoint[] = [];
  for (const point of unique) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0
    ) lower.pop();
    lower.push(point);
  }
  const upper: MercatorPoint[] = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index]!;
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0
    ) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function pointInRectangle(
  point: MercatorPoint,
  west: number,
  east: number,
  north: number,
  south: number,
): boolean {
  return point.x >= west && point.x <= east &&
    point.y >= north && point.y <= south;
}

function pointOnSegment(
  point: MercatorPoint,
  start: MercatorPoint,
  end: MercatorPoint,
): boolean {
  return cross(start, end, point) === 0 &&
    point.x >= Math.min(start.x, end.x) &&
    point.x <= Math.max(start.x, end.x) &&
    point.y >= Math.min(start.y, end.y) &&
    point.y <= Math.max(start.y, end.y);
}

function segmentsIntersect(
  firstStart: MercatorPoint,
  firstEnd: MercatorPoint,
  secondStart: MercatorPoint,
  secondEnd: MercatorPoint,
): boolean {
  const firstSideStart = cross(firstStart, firstEnd, secondStart);
  const firstSideEnd = cross(firstStart, firstEnd, secondEnd);
  const secondSideStart = cross(secondStart, secondEnd, firstStart);
  const secondSideEnd = cross(secondStart, secondEnd, firstEnd);
  if (
    ((firstSideStart > 0 && firstSideEnd < 0) ||
      (firstSideStart < 0 && firstSideEnd > 0)) &&
    ((secondSideStart > 0 && secondSideEnd < 0) ||
      (secondSideStart < 0 && secondSideEnd > 0))
  ) return true;
  return (firstSideStart === 0 &&
      pointOnSegment(secondStart, firstStart, firstEnd)) ||
    (firstSideEnd === 0 && pointOnSegment(secondEnd, firstStart, firstEnd)) ||
    (secondSideStart === 0 &&
      pointOnSegment(firstStart, secondStart, secondEnd)) ||
    (secondSideEnd === 0 && pointOnSegment(firstEnd, secondStart, secondEnd));
}

function pointInPolygon(
  point: MercatorPoint,
  polygon: readonly MercatorPoint[],
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length;
    previous = index, index += 1) {
    const start = polygon[previous]!;
    const end = polygon[index]!;
    if (pointOnSegment(point, start, end)) return true;
    if (
      (start.y > point.y) !== (end.y > point.y) &&
      point.x < (end.x - start.x) * (point.y - start.y) /
          (end.y - start.y) + start.x
    ) inside = !inside;
  }
  return inside;
}

function tileIntersectsFootprint(
  tile: TileIdentity,
  footprint: readonly MercatorPoint[],
  referenceX: number,
): boolean {
  const width = 2 ** tile.z;
  const centreX = unwrapX((tile.x + 0.5) / width, referenceX);
  const halfSpan = 0.5 / width;
  const west = centreX - halfSpan;
  const east = centreX + halfSpan;
  const north = tile.y / width;
  const south = (tile.y + 1) / width;
  if (footprint.length === 1) {
    return pointInRectangle(footprint[0]!, west, east, north, south);
  }
  const corners = [
    { x: west, y: north },
    { x: east, y: north },
    { x: east, y: south },
    { x: west, y: south },
  ];
  if (footprint.some((point) =>
    pointInRectangle(point, west, east, north, south)
  )) return true;
  if (footprint.length >= 3 && corners.some((point) =>
    pointInPolygon(point, footprint)
  )) return true;
  const footprintEdgeCount = footprint.length === 2
    ? 1
    : footprint.length;
  for (let footprintIndex = 0; footprintIndex < footprintEdgeCount;
    footprintIndex += 1) {
    const start = footprint[footprintIndex]!;
    const end = footprint[(footprintIndex + 1) % footprint.length]!;
    for (let cornerIndex = 0; cornerIndex < corners.length; cornerIndex += 1) {
      if (segmentsIntersect(
        start,
        end,
        corners[cornerIndex]!,
        corners[(cornerIndex + 1) % corners.length]!,
      )) return true;
    }
  }
  return false;
}

/**
 * Classifies only planner candidates intersecting the current successful
 * surface-ray footprint. No underfoot, horizon, or neighboring guard is added.
 */
export function classifyVisibleTiles(
  cut: readonly TileIdentity[],
  input: ViewVisibilityInput,
): ReadonlySet<string> {
  const visible = new Set<string>();
  if (input.footprint.length === 0) return visible;
  const first = normalizedMercatorPoint(input.footprint[0]!);
  const footprint = convexHull(input.footprint.map((point) => {
    const mercator = normalizedMercatorPoint(point);
    return { x: unwrapX(mercator.x, first.x), y: mercator.y };
  }));
  for (const tile of cut) {
    if (tileIntersectsFootprint(tile, footprint, first.x)) {
      visible.add(tileIdentityKey(tile));
    }
  }
  return visible;
}
