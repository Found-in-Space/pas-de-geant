import {
  MOON_RADIUS_KM,
  SUN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
  add,
  dot,
  ecefToGeodetic,
  magnitude,
  normalize,
  scale,
  subtract,
} from "./math.js";
import type {
  CartesianVector,
  SurfacePoint,
} from "./types.js";

export const GEOMETRY_RESIDUAL_TOLERANCE_KM = 1e-3;
export const CONTACT_TIME_TOLERANCE_MS = 1;
export const ROOT_ITERATIONS = 32;

const A2 = WGS84_A_KM * WGS84_A_KM;
const B2 = WGS84_B_KM * WGS84_B_KM;
const BASIS_EPSILON = 1e-12;

export type ShadowConeKind = "central" | "penumbra";

export interface ShadowGeometryState {
  atUtc: string;
  sunEcefKm: CartesianVector;
  moonEcefKm: CartesianVector;
  /** Unit vector from the Sun through the Moon toward the Earth. */
  direction: CartesianVector;
  sunDistanceKm: number;
  sunMoonDistanceKm: number;
}

export interface ConeBasis {
  axis: CartesianVector;
  first: CartesianVector;
  second: CartesianVector;
}

export interface ConeSurfaceIntersection extends SurfacePoint {
  cone: ShadowConeKind;
  azimuthRad: number;
  generatorDistanceKm: number;
}

export interface RotationQuaternion {
  w: number;
  x: number;
  y: number;
  z: number;
}

export interface SurfaceFrame {
  normal: CartesianVector;
  tangent: CartesianVector;
  positiveCrossTrack: CartesianVector;
}

export function cross(
  left: CartesianVector,
  right: CartesianVector,
): CartesianVector {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

export function chordDistanceKm(
  left: CartesianVector,
  right: CartesianVector,
): number {
  return magnitude(subtract(left, right));
}

export function ellipsoidEquation(pointEcefKm: CartesianVector): number {
  return (
    (pointEcefKm.x * pointEcefKm.x +
      pointEcefKm.y * pointEcefKm.y) /
      A2 +
    (pointEcefKm.z * pointEcefKm.z) / B2 -
    1
  );
}

export function ellipsoidGradient(
  pointEcefKm: CartesianVector,
): CartesianVector {
  return {
    x: (2 * pointEcefKm.x) / A2,
    y: (2 * pointEcefKm.y) / A2,
    z: (2 * pointEcefKm.z) / B2,
  };
}

export function ellipsoidResidualKm(
  pointEcefKm: CartesianVector,
): number {
  return ellipsoidEquation(pointEcefKm) / magnitude(
    ellipsoidGradient(pointEcefKm),
  );
}

export function ellipsoidNormal(
  pointEcefKm: CartesianVector,
): CartesianVector {
  return normalize(ellipsoidGradient(pointEcefKm));
}

export function surfacePoint(ecefKm: CartesianVector): SurfacePoint {
  return {
    ecefKm: { ...ecefKm },
    geographic: ecefToGeodetic(ecefKm),
  };
}

export function pointOnEllipsoidFromNormal(
  normal: CartesianVector,
): CartesianVector {
  const unit = normalize(normal);
  const support = Math.sqrt(
    A2 * (unit.x * unit.x + unit.y * unit.y) +
      B2 * unit.z * unit.z,
  );
  return {
    x: (A2 * unit.x) / support,
    y: (A2 * unit.y) / support,
    z: (B2 * unit.z) / support,
  };
}

/**
 * Builds a deterministic perpendicular basis. `rotationRad` exists to verify
 * that physical results do not depend on the otherwise arbitrary basis.
 */
export function coneBasis(
  axis: CartesianVector,
  rotationRad = 0,
): ConeBasis {
  const d = normalize(axis);
  const reference =
    Math.abs(d.z) < 0.8
      ? { x: 0, y: 0, z: 1 }
      : { x: 0, y: 1, z: 0 };
  const baseFirst = normalize(cross(d, reference));
  const baseSecond = normalize(cross(d, baseFirst));
  const cosine = Math.cos(rotationRad);
  const sine = Math.sin(rotationRad);
  return {
    axis: d,
    first: add(
      scale(baseFirst, cosine),
      scale(baseSecond, sine),
    ),
    second: add(
      scale(baseFirst, -sine),
      scale(baseSecond, cosine),
    ),
  };
}

export function coneRadialSlope(
  state: ShadowGeometryState,
  cone: ShadowConeKind,
): number {
  return cone === "central"
    ? -(SUN_RADIUS_KM - MOON_RADIUS_KM) / state.sunMoonDistanceKm
    : (SUN_RADIUS_KM + MOON_RADIUS_KM) / state.sunMoonDistanceKm;
}

export function coneRadiusKm(
  state: ShadowGeometryState,
  cone: ShadowConeKind,
  alongAxisKm: number,
): number {
  return MOON_RADIUS_KM + coneRadialSlope(state, cone) * alongAxisKm;
}

export function coneMarginKm(
  state: ShadowGeometryState,
  pointEcefKm: CartesianVector,
  cone: ShadowConeKind,
): number {
  const fromMoon = subtract(pointEcefKm, state.moonEcefKm);
  const alongAxisKm = dot(fromMoon, state.direction);
  const perpendicular = subtract(
    fromMoon,
    scale(state.direction, alongAxisKm),
  );
  return (
    Math.abs(coneRadiusKm(state, cone, alongAxisKm)) -
    magnitude(perpendicular)
  );
}

export function coneResidualKm(
  state: ShadowGeometryState,
  pointEcefKm: CartesianVector,
  cone: ShadowConeKind,
): number {
  return -coneMarginKm(state, pointEcefKm, cone);
}

export function daylightResidualKm(
  state: ShadowGeometryState,
  pointEcefKm: CartesianVector,
): number {
  return dot(
    ellipsoidNormal(pointEcefKm),
    subtract(state.sunEcefKm, pointEcefKm),
  );
}

function quadraticRoots(
  quadraticA: number,
  quadraticB: number,
  quadraticC: number,
): number[] {
  const discriminant =
    quadraticB * quadraticB - 4 * quadraticA * quadraticC;
  if (discriminant < 0 || !Number.isFinite(discriminant)) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  if (root === 0) return [-quadraticB / (2 * quadraticA)];
  const q = -0.5 * (quadraticB + Math.sign(quadraticB || 1) * root);
  const first = q / quadraticA;
  const second = quadraticC / q;
  return first <= second ? [first, second] : [second, first];
}

/**
 * Intersects one exact shadow-cone generator with the WGS 84 ellipsoid:
 *
 * x(s,φ) = m + r₀w(φ) + s(d + kw(φ)).
 */
export function intersectConeGenerator(
  state: ShadowGeometryState,
  cone: ShadowConeKind,
  azimuthRad: number,
  basisRotationRad = 0,
): ConeSurfaceIntersection[] {
  const basis = coneBasis(state.direction, basisRotationRad);
  const w = add(
    scale(basis.first, Math.cos(azimuthRad)),
    scale(basis.second, Math.sin(azimuthRad)),
  );
  const origin = add(state.moonEcefKm, scale(w, MOON_RADIUS_KM));
  const generator = add(
    state.direction,
    scale(w, coneRadialSlope(state, cone)),
  );
  const quadraticA =
    (generator.x * generator.x + generator.y * generator.y) / A2 +
    (generator.z * generator.z) / B2;
  const quadraticB =
    (2 * (origin.x * generator.x + origin.y * generator.y)) / A2 +
    (2 * origin.z * generator.z) / B2;
  const quadraticC =
    (origin.x * origin.x + origin.y * origin.y) / A2 +
    (origin.z * origin.z) / B2 -
    1;
  return quadraticRoots(quadraticA, quadraticB, quadraticC)
    .filter((distance) => distance > 0)
    .map((generatorDistanceKm) => {
      const ecefKm = add(
        origin,
        scale(generator, generatorDistanceKm),
      );
      return {
        ...surfacePoint(ecefKm),
        cone,
        azimuthRad,
        generatorDistanceKm,
      };
    });
}

export function minimalRotation(
  from: CartesianVector,
  to: CartesianVector,
): RotationQuaternion {
  const first = normalize(from);
  const second = normalize(to);
  const cosine = Math.max(-1, Math.min(1, dot(first, second)));
  if (cosine > 1 - BASIS_EPSILON) {
    return { w: 1, x: 0, y: 0, z: 0 };
  }
  if (cosine < -1 + BASIS_EPSILON) {
    const basis = coneBasis(first);
    return {
      w: 0,
      x: basis.first.x,
      y: basis.first.y,
      z: basis.first.z,
    };
  }
  const vector = cross(first, second);
  const factor = Math.sqrt(2 * (1 + cosine));
  return {
    w: factor / 2,
    x: vector.x / factor,
    y: vector.y / factor,
    z: vector.z / factor,
  };
}

export function rotateVector(
  quaternion: RotationQuaternion,
  vector: CartesianVector,
): CartesianVector {
  const q = {
    x: quaternion.x,
    y: quaternion.y,
    z: quaternion.z,
  };
  const twiceCross = scale(cross(q, vector), 2);
  return add(
    vector,
    add(
      scale(twiceCross, quaternion.w),
      cross(q, twiceCross),
    ),
  );
}

/**
 * Rotation-minimizing surface frame. At stationary samples callers pass the
 * preceding frame and it is continued without inventing a geographic east.
 */
export function surfaceFrame(
  pointEcefKm: CartesianVector,
  velocityEcefKmPerSecond: CartesianVector,
  previous?: SurfaceFrame,
): SurfaceFrame {
  const normal = ellipsoidNormal(pointEcefKm);
  const tangentialVelocity = subtract(
    velocityEcefKmPerSecond,
    scale(normal, dot(velocityEcefKmPerSecond, normal)),
  );
  if (magnitude(tangentialVelocity) < 1e-9) {
    if (!previous) {
      const basis = coneBasis(normal);
      const tangent = basis.first;
      return {
        normal,
        tangent,
        positiveCrossTrack: normalize(cross(normal, tangent)),
      };
    }
    const rotation = minimalRotation(previous.normal, normal);
    const tangentCandidate = rotateVector(rotation, previous.tangent);
    const tangent = normalize(
      subtract(
        tangentCandidate,
        scale(normal, dot(tangentCandidate, normal)),
      ),
    );
    return {
      normal,
      tangent,
      positiveCrossTrack: normalize(cross(normal, tangent)),
    };
  }
  const tangent = normalize(tangentialVelocity);
  let positiveCrossTrack = normalize(cross(normal, tangent));
  if (
    previous &&
    dot(positiveCrossTrack, previous.positiveCrossTrack) < 0
  ) {
    positiveCrossTrack = scale(positiveCrossTrack, -1);
  }
  return { normal, tangent, positiveCrossTrack };
}
