import { tileIdentityKey, type TileIdentity } from "./tile-transition-planner.js";

export interface GeographicPoint {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export interface ViewResidencyInput {
  readonly underfoot: GeographicPoint;
  readonly footprint: readonly GeographicPoint[];
}

export interface ViewResidencySets {
  readonly hot: ReadonlySet<string>;
  readonly warm: ReadonlySet<string>;
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

/**
 * Intersects a ray with an axis-aligned ellipsoid. A miss returns the closest
 * nonnegative point radially projected onto the ellipsoid, which is the cheap
 * tangent-horizon approximation used by view residency.
 */
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
  let distance = Math.max(0, -halfB / a);
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
  target.x = origin.x + direction.x * distance;
  target.y = origin.y + direction.y * distance;
  target.z = origin.z + direction.z * distance;
  if (!hit) {
    const radialScale = 1 / Math.sqrt(
      (target.x * target.x + target.z * target.z) *
        inverseEquatorialSquared +
      target.y * target.y * inversePolarSquared,
    );
    target.x *= radialScale;
    target.y *= radialScale;
    target.z *= radialScale;
  }
  return hit;
}

interface MercatorEnvelope {
  readonly referenceX: number;
  readonly minimumX: number;
  readonly maximumX: number;
  readonly minimumY: number;
  readonly maximumY: number;
}

function normalizedMercatorPoint(point: GeographicPoint): {
  x: number;
  y: number;
} {
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

function footprintEnvelope(input: ViewResidencyInput): MercatorEnvelope {
  const underfoot = normalizedMercatorPoint(input.underfoot);
  let minimumX = underfoot.x;
  let maximumX = underfoot.x;
  let minimumY = underfoot.y;
  let maximumY = underfoot.y;
  for (const point of input.footprint) {
    const mercator = normalizedMercatorPoint(point);
    const x = unwrapX(mercator.x, underfoot.x);
    minimumX = Math.min(minimumX, x);
    maximumX = Math.max(maximumX, x);
    minimumY = Math.min(minimumY, mercator.y);
    maximumY = Math.max(maximumY, mercator.y);
  }
  return {
    referenceX: underfoot.x,
    minimumX,
    maximumX,
    minimumY,
    maximumY,
  };
}

function intersectsExpandedFootprint(
  tile: TileIdentity,
  envelope: MercatorEnvelope,
  guard: number,
): boolean {
  const width = 2 ** tile.z;
  const tileSpan = 1 / width;
  const centreX = unwrapX((tile.x + 0.5) / width, envelope.referenceX);
  const west = centreX - tileSpan * 0.5;
  const east = centreX + tileSpan * 0.5;
  const north = tile.y / width;
  const south = (tile.y + 1) / width;
  return east >= envelope.minimumX - guard &&
    west <= envelope.maximumX + guard &&
    south >= envelope.minimumY - guard &&
    north <= envelope.maximumY + guard;
}

/**
 * Classifies only the current mixed-LOD cut. The footprint is deliberately a
 * conservative geographic envelope: it includes the underfoot point and all
 * sampled centre/corner rays, so inclined views retain the intervening ground.
 */
export function classifyViewResidency(
  cut: readonly TileIdentity[],
  input: ViewResidencyInput,
  previousWarm: ReadonlySet<string> = new Set(),
): ViewResidencySets {
  const hot = new Set<string>();
  const warm = new Set<string>();
  const envelope = footprintEnvelope(input);
  const maximumZoom = cut.reduce(
    (maximum, tile) => Math.max(maximum, tile.z),
    0,
  );
  const finestTileSpan = 1 / 2 ** maximumZoom;
  for (const tile of cut) {
    const key = tileIdentityKey(tile);
    if (intersectsExpandedFootprint(tile, envelope, finestTileSpan)) hot.add(key);
    if (
      intersectsExpandedFootprint(tile, envelope, finestTileSpan * 3) ||
      (previousWarm.has(key) &&
        intersectsExpandedFootprint(tile, envelope, finestTileSpan * 4))
    ) {
      warm.add(key);
    }
  }
  return { hot, warm };
}

/** Changes only when the sampled footprint crosses a half-tile boundary. */
export function viewResidencySignature(
  zoom: number,
  input: ViewResidencyInput,
): number {
  const width = 2 ** Math.max(0, zoom + 1);
  let signature = 2_166_136_261;
  for (let index = -1; index < input.footprint.length; index += 1) {
    const point = index < 0 ? input.underfoot : input.footprint[index]!;
    const longitude = ((point.longitudeDegrees + 180) % 360 + 360) % 360;
    const latitude = Math.max(
      -85.05112878,
      Math.min(85.05112878, point.latitudeDegrees),
    ) * Math.PI / 180;
    const x = Math.floor(longitude / 360 * width);
    const y = Math.floor(
      (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) *
      0.5 * width,
    );
    signature = Math.imul(signature ^ x, 16_777_619);
    signature = Math.imul(signature ^ y, 16_777_619);
  }
  return signature >>> 0;
}
