import {
  AU_KM,
  MOON_RADIUS_KM,
  SUN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
  add,
  dot,
  magnitude,
  normalize,
  scale,
  subtract,
} from "./math.js";
import {
  GEOMETRY_RESIDUAL_TOLERANCE_KM,
  ROOT_ITERATIONS,
  chordDistanceKm,
  coneMarginKm,
  cross,
  daylightResidualKm,
  ellipsoidNormal,
  intersectConeGenerator,
  pointOnEllipsoidFromNormal,
  surfaceFrame,
  surfacePoint,
  type ShadowConeKind,
  type ShadowGeometryState,
} from "./ecef-geometry.js";
import type {
  CartesianVector,
  EarthFixedEphemeris,
  SurfacePoint,
} from "./types.js";

export type ShadowCone = ShadowConeKind;

const DEFAULT_ENVELOPE_AZIMUTH_STEP_DEGREES = 10;
const LIMB_ARC_TOLERANCE_KM = 1e-6;

export interface AxisIntersection extends ShadowGeometryState {
  axisIntersectsEarth: boolean;
  point: SurfacePoint;
  axisDistanceFromMoonKm: number;
  signedUmbraRadiusKm: number;
}

export interface ShadowEnvelopePoint {
  azimuthRad: number;
  point: SurfacePoint;
  side: "positive-cross-track" | "negative-cross-track";
  stationaryResidualKm: number;
}

export interface ShadowLimbPoint {
  angleDeg: number;
  point: SurfacePoint;
}

export interface ShadowLimbMaximum extends ShadowLimbPoint {
  marginKm: number;
}

function axisEllipsoidIntersections(
  origin: CartesianVector,
  direction: CartesianVector,
): number[] {
  const a2 = WGS84_A_KM * WGS84_A_KM;
  const b2 = WGS84_B_KM * WGS84_B_KM;
  const quadraticA =
    (direction.x * direction.x + direction.y * direction.y) / a2 +
    (direction.z * direction.z) / b2;
  const quadraticB =
    (2 * (origin.x * direction.x + origin.y * direction.y)) / a2 +
    (2 * origin.z * direction.z) / b2;
  const quadraticC =
    (origin.x * origin.x + origin.y * origin.y) / a2 +
    (origin.z * origin.z) / b2 -
    1;
  const discriminant =
    quadraticB * quadraticB - 4 * quadraticA * quadraticC;
  if (discriminant < 0) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [
    (-quadraticB - root) / (2 * quadraticA),
    (-quadraticB + root) / (2 * quadraticA),
  ]
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
}

export function shadowSurfaceState(
  provider: EarthFixedEphemeris,
  atUtc: string,
): AxisIntersection {
  const sunKm = scale(
    provider.stateVector(
      "sun",
      atUtc,
      "geocentric-earth-fixed",
    ).positionAu,
    AU_KM,
  );
  const moonKm = scale(
    provider.stateVector(
      "moon",
      atUtc,
      "geocentric-earth-fixed",
    ).positionAu,
    AU_KM,
  );
  const direction = normalize(subtract(moonKm, sunKm));
  const roots = axisEllipsoidIntersections(moonKm, direction);
  const axisIntersectsEarth = roots.length > 0;
  const closestDistanceKm = -dot(moonKm, direction);
  const closestPoint = add(
    moonKm,
    scale(direction, closestDistanceKm),
  );
  const a2 = WGS84_A_KM * WGS84_A_KM;
  const b2 = WGS84_B_KM * WGS84_B_KM;
  const projectedScale =
    1 /
    Math.sqrt(
      (closestPoint.x * closestPoint.x +
        closestPoint.y * closestPoint.y) /
        a2 +
        (closestPoint.z * closestPoint.z) / b2,
    );
  const axisDistanceFromMoonKm = axisIntersectsEarth
    ? roots[0]!
    : closestDistanceKm;
  const pointEcefKm = axisIntersectsEarth
    ? add(moonKm, scale(direction, axisDistanceFromMoonKm))
    : scale(closestPoint, projectedScale);
  const sunMoonDistanceKm = magnitude(subtract(moonKm, sunKm));
  const signedUmbraRadiusKm =
    MOON_RADIUS_KM -
    (axisDistanceFromMoonKm * (SUN_RADIUS_KM - MOON_RADIUS_KM)) /
      sunMoonDistanceKm;

  return {
    atUtc,
    axisIntersectsEarth,
    point: surfacePoint(pointEcefKm),
    sunEcefKm: sunKm,
    moonEcefKm: moonKm,
    direction,
    sunDistanceKm: magnitude(sunKm),
    sunMoonDistanceKm,
    axisDistanceFromMoonKm,
    signedUmbraRadiusKm,
  };
}

export function axisIntersection(
  provider: EarthFixedEphemeris,
  atUtc: string,
): AxisIntersection | null {
  const state = shadowSurfaceState(provider, atUtc);
  return state.axisIntersectsEarth ? state : null;
}

export function shadowMarginAtSurfaceKm(
  axis: AxisIntersection,
  point: SurfacePoint | CartesianVector,
  cone: ShadowCone = "central",
): number {
  return coneMarginKm(
    axis,
    "ecefKm" in point ? point.ecefKm : point,
    cone,
  );
}

export function solarLimbMarginAtSurfaceKm(
  axis: AxisIntersection,
  point: SurfacePoint | CartesianVector,
): number {
  const ecefKm = "ecefKm" in point ? point.ecefKm : point;
  return (
    (WGS84_A_KM * daylightResidualKm(axis, ecefKm)) /
    axis.sunDistanceKm
  );
}

export function visibleShadowMarginAtSurfaceKm(
  axis: AxisIntersection,
  point: SurfacePoint | CartesianVector,
  cone: ShadowCone = "central",
): number {
  return Math.min(
    shadowMarginAtSurfaceKm(axis, point, cone),
    solarLimbMarginAtSurfaceKm(axis, point),
  );
}

/**
 * Returns a point on the geometric solar limb without introducing a
 * geographic tangent frame.
 */
function solarLimbSurface(
  axis: AxisIntersection,
  angleDeg: number,
): SurfacePoint {
  const sunDirection = normalize(axis.sunEcefKm);
  const reference =
    Math.abs(sunDirection.z) < 0.8
      ? { x: 0, y: 0, z: 1 }
      : { x: 1, y: 0, z: 0 };
  const first = normalize(cross(sunDirection, reference));
  const second = normalize(cross(sunDirection, first));
  const angle = (angleDeg * Math.PI) / 180;
  const base = add(
    scale(first, Math.cos(angle)),
    scale(second, Math.sin(angle)),
  );
  const normalAtTilt = (tilt: number) =>
    normalize(
      add(
        scale(base, Math.cos(tilt)),
        scale(sunDirection, Math.sin(tilt)),
      ),
    );
  const residualAtTilt = (tilt: number) => {
    const normal = normalAtTilt(tilt);
    const point = pointOnEllipsoidFromNormal(normal);
    return dot(normal, subtract(axis.sunEcefKm, point));
  };

  let nightTilt = -0.01;
  let dayTilt = 0.01;
  for (let iteration = 0; iteration < ROOT_ITERATIONS; iteration += 1) {
    if (
      (dayTilt - nightTilt) * WGS84_A_KM <=
      LIMB_ARC_TOLERANCE_KM
    ) {
      break;
    }
    const middle = (nightTilt + dayTilt) / 2;
    if (residualAtTilt(middle) > 0) dayTilt = middle;
    else nightTilt = middle;
  }
  return surfacePoint(
    pointOnEllipsoidFromNormal(
      normalAtTilt((nightTilt + dayTilt) / 2),
    ),
  );
}

export function solarLimbPoint(
  axis: AxisIntersection,
  angleDeg: number,
): SurfacePoint {
  return solarLimbSurface(axis, angleDeg);
}

function shadowLimbMargin(
  axis: AxisIntersection,
  cone: ShadowCone,
  angleDeg: number,
): ShadowLimbMaximum {
  const point = solarLimbSurface(axis, angleDeg);
  return {
    angleDeg: ((angleDeg % 360) + 360) % 360,
    marginKm: shadowMarginAtSurfaceKm(axis, point, cone),
    point,
  };
}

export function maximumShadowMarginOnSolarLimb(
  axis: AxisIntersection,
  cone: ShadowCone,
  angleStepDegrees = 2,
): ShadowLimbMaximum {
  if (
    !Number.isFinite(angleStepDegrees) ||
    angleStepDegrees <= 0 ||
    angleStepDegrees > 30
  ) {
    throw new RangeError(
      "Solar-limb angle step must be above 0 and at most 30 degrees.",
    );
  }
  let best = shadowLimbMargin(axis, cone, 0);
  for (
    let angleDeg = angleStepDegrees;
    angleDeg < 360;
    angleDeg += angleStepDegrees
  ) {
    const candidate = shadowLimbMargin(axis, cone, angleDeg);
    if (candidate.marginKm > best.marginKm) best = candidate;
  }

  let low = best.angleDeg - angleStepDegrees;
  let high = best.angleDeg + angleStepDegrees;
  const ratio = (Math.sqrt(5) - 1) / 2;
  let left = high - ratio * (high - low);
  let right = low + ratio * (high - low);
  let leftValue = shadowLimbMargin(axis, cone, left).marginKm;
  let rightValue = shadowLimbMargin(axis, cone, right).marginKm;
  for (let iteration = 0; iteration < ROOT_ITERATIONS; iteration += 1) {
    if (
      ((high - low) * Math.PI * WGS84_A_KM) / 180 <=
      LIMB_ARC_TOLERANCE_KM
    ) {
      break;
    }
    if (leftValue < rightValue) {
      low = left;
      left = right;
      leftValue = rightValue;
      right = low + ratio * (high - low);
      rightValue = shadowLimbMargin(axis, cone, right).marginKm;
    } else {
      high = right;
      right = left;
      rightValue = leftValue;
      left = high - ratio * (high - low);
      leftValue = shadowLimbMargin(axis, cone, left).marginKm;
    }
  }
  return shadowLimbMargin(axis, cone, (low + high) / 2);
}

export function shadowSolarLimbIntersections(
  axis: AxisIntersection,
  cone: ShadowCone,
  angleStepDegrees = 1,
): ShadowLimbPoint[] {
  if (
    !Number.isFinite(angleStepDegrees) ||
    angleStepDegrees <= 0 ||
    angleStepDegrees > 30
  ) {
    throw new RangeError(
      "Solar-limb angle step must be above 0 and at most 30 degrees.",
    );
  }
  const roots: ShadowLimbPoint[] = [];
  let previousAngle = 0;
  let previous = shadowLimbMargin(axis, cone, previousAngle);
  for (
    let angleDeg = angleStepDegrees;
    angleDeg <= 360 + 1e-12;
    angleDeg += angleStepDegrees
  ) {
    const currentAngle = Math.min(angleDeg, 360);
    const current = shadowLimbMargin(
      axis,
      cone,
      currentAngle % 360,
    );
    if (previous.marginKm * current.marginKm <= 0) {
      let low = previousAngle;
      let high = currentAngle;
      let lowMargin = previous.marginKm;
      for (let iteration = 0; iteration < ROOT_ITERATIONS; iteration += 1) {
        const middle = (low + high) / 2;
        const middleMargin = shadowLimbMargin(
          axis,
          cone,
          middle,
        ).marginKm;
        if (lowMargin * middleMargin <= 0) high = middle;
        else {
          low = middle;
          lowMargin = middleMargin;
        }
      }
      const rootAngle = (low + high) / 2;
      const normalized = ((rootAngle % 360) + 360) % 360;
      if (
        !roots.some((root) => {
          const difference = Math.abs(root.angleDeg - normalized);
          return Math.min(difference, 360 - difference) < 1e-6;
        })
      ) {
        roots.push({
          angleDeg: normalized,
          point: solarLimbSurface(axis, rootAngle),
        });
      }
    }
    previousAngle = currentAngle;
    previous = current;
  }
  return roots;
}

function boundaryPointAtAzimuth(
  axis: AxisIntersection,
  cone: ShadowCone,
  azimuthRad: number,
  clipToSunlitLimb: boolean,
  basisRotationRad = 0,
): SurfacePoint | null {
  const intersections = intersectConeGenerator(
    axis,
    cone,
    azimuthRad,
    basisRotationRad,
  );
  const candidates = clipToSunlitLimb
    ? intersections.filter(
        (point) =>
          solarLimbMarginAtSurfaceKm(axis, point) >=
          -GEOMETRY_RESIDUAL_TOLERANCE_KM,
      )
    : intersections;
  return (
    candidates
      .slice()
      .sort(
        (left, right) =>
          left.generatorDistanceKm - right.generatorDistanceKm,
      )[0] ?? null
  );
}

export function shadowBoundaryAtAzimuth(
  axis: AxisIntersection,
  azimuthRad: number,
  cone: ShadowCone = "central",
  clipToSunlitLimb = true,
  basisRotationRad = 0,
): SurfacePoint | null {
  return boundaryPointAtAzimuth(
    axis,
    cone,
    azimuthRad,
    clipToSunlitLimb,
    basisRotationRad,
  );
}

interface EnvelopeEvaluation {
  azimuthRad: number;
  value: number;
  point: SurfacePoint;
}

function refineEnvelopeRoot(
  evaluate: (angle: number) => EnvelopeEvaluation | null,
  lowAngle: number,
  highAngle: number,
  lowValue: number,
): EnvelopeEvaluation | null {
  let low = lowAngle;
  let high = highAngle;
  let value = lowValue;
  for (let iteration = 0; iteration < ROOT_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2;
    const evaluation = evaluate(middle);
    if (!evaluation) return null;
    if (value * evaluation.value <= 0) high = middle;
    else {
      low = middle;
      value = evaluation.value;
    }
  }
  return evaluate((low + high) / 2);
}

function minimizeStationaryResidual(
  evaluate: (angle: number) => EnvelopeEvaluation | null,
  lowAngle: number,
  highAngle: number,
): EnvelopeEvaluation | null {
  let low = lowAngle;
  let high = highAngle;
  const ratio = (Math.sqrt(5) - 1) / 2;
  for (let iteration = 0; iteration < ROOT_ITERATIONS; iteration += 1) {
    const left = high - ratio * (high - low);
    const right = low + ratio * (high - low);
    const leftEvaluation = evaluate(left);
    const rightEvaluation = evaluate(right);
    if (!leftEvaluation || !rightEvaluation) return null;
    if (
      Math.abs(leftEvaluation.value) <=
      Math.abs(rightEvaluation.value)
    ) {
      high = right;
    } else {
      low = left;
    }
  }
  return evaluate((low + high) / 2);
}

/**
 * Finds roots of C(x,t)=0 and ∂C/∂t=0 using exact cone/ellipsoid
 * intersections. No longitude, latitude, bearing, or map distance enters the
 * calculation.
 */
export function visibleShadowEnvelopePoints(
  previous: AxisIntersection,
  axis: AxisIntersection,
  next: AxisIntersection,
  cone: ShadowCone = "central",
  azimuthStepDegrees = DEFAULT_ENVELOPE_AZIMUTH_STEP_DEGREES,
  includeSecondaryRoots = false,
  clipToSunlitLimb = true,
  basisRotationRad = 0,
): ShadowEnvelopePoint[] {
  const evaluate = (azimuthRad: number): EnvelopeEvaluation | null => {
    const normalized =
      ((azimuthRad % (2 * Math.PI)) + 2 * Math.PI) %
      (2 * Math.PI);
    const point = boundaryPointAtAzimuth(
      axis,
      cone,
      normalized,
      clipToSunlitLimb,
      basisRotationRad,
    );
    if (!point) return null;
    return {
      azimuthRad: normalized,
      value:
        shadowMarginAtSurfaceKm(next, point, cone) -
        shadowMarginAtSurfaceKm(previous, point, cone),
      point,
    };
  };

  const step = (azimuthStepDegrees * Math.PI) / 180;
  const samples: Array<EnvelopeEvaluation | null> = [];
  for (let angle = 0; angle < 2 * Math.PI - step / 2; angle += step) {
    samples.push(evaluate(angle));
  }
  const roots: EnvelopeEvaluation[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const previousEvaluation = samples[index]!;
    const nextEvaluation = samples[(index + 1) % samples.length]!;
    if (!previousEvaluation || !nextEvaluation) continue;
    const low = index * step;
    const high = (index + 1) * step;
    let root: EnvelopeEvaluation | null = null;
    if (previousEvaluation.value * nextEvaluation.value <= 0) {
      root = refineEnvelopeRoot(
        evaluate,
        low,
        high,
        previousEvaluation.value,
      );
    } else {
      const middle = evaluate((low + high) / 2);
      if (
        middle &&
        Math.abs(middle.value) <
          Math.min(
            Math.abs(previousEvaluation.value),
            Math.abs(nextEvaluation.value),
          )
      ) {
        const minimum = minimizeStationaryResidual(evaluate, low, high);
        if (
          minimum &&
          Math.abs(minimum.value) <=
            GEOMETRY_RESIDUAL_TOLERANCE_KM
        ) {
          root = minimum;
        }
      }
    }
    if (
      root &&
      !roots.some(
        (candidate) =>
          chordDistanceKm(candidate.point.ecefKm, root!.point.ecefKm) <
          0.01,
      )
    ) {
      roots.push(root);
    }
  }

  const deltaSeconds = Math.max(
    1e-3,
    (new Date(next.atUtc).getTime() -
      new Date(previous.atUtc).getTime()) /
      1000,
  );
  const velocity = scale(
    subtract(next.point.ecefKm, previous.point.ecefKm),
    1 / deltaSeconds,
  );
  const frame = surfaceFrame(axis.point.ecefKm, velocity);
  const classified = roots.map((root) => {
    const signedCrossTrack = dot(
      subtract(root.point.ecefKm, axis.point.ecefKm),
      frame.positiveCrossTrack,
    );
    return {
      azimuthRad: root.azimuthRad,
      point: root.point,
      side:
        signedCrossTrack >= 0
          ? ("positive-cross-track" as const)
          : ("negative-cross-track" as const),
      signedCrossTrack,
      stationaryResidualKm: root.value,
    };
  });
  if (includeSecondaryRoots) {
    return classified
      .sort(
        (left, right) =>
          Math.abs(right.signedCrossTrack) -
          Math.abs(left.signedCrossTrack),
      )
      .map(({ signedCrossTrack: _signed, ...root }) => root);
  }
  const strongest = (
    side: ShadowEnvelopePoint["side"],
  ): ShadowEnvelopePoint | undefined => {
    const candidate = classified
      .filter((root) => root.side === side)
      .sort(
        (left, right) =>
          Math.abs(right.signedCrossTrack) -
          Math.abs(left.signedCrossTrack),
      )[0];
    if (!candidate) return undefined;
    const { signedCrossTrack: _signed, ...root } = candidate;
    return root;
  };
  return [
    strongest("positive-cross-track"),
    strongest("negative-cross-track"),
  ].filter((root): root is ShadowEnvelopePoint => Boolean(root));
}

export function envelopeResidualKm(
  previous: AxisIntersection,
  next: AxisIntersection,
  point: SurfacePoint,
  cone: ShadowCone,
): number {
  return (
    shadowMarginAtSurfaceKm(next, point, cone) -
    shadowMarginAtSurfaceKm(previous, point, cone)
  );
}

export function daylightNormal(
  point: SurfacePoint,
): CartesianVector {
  return ellipsoidNormal(point.ecefKm);
}
