import { interpolateSpatialDirections, subtractSpatialVectors, scaleSpatialVector, dotSpatialVectors } from "@found-in-space/spatial";

export interface NavigationCoordinates {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export interface TimedTransition<T> {
  readonly from: T;
  readonly to: T;
  readonly startedAtMs: number;
  readonly durationSeconds: number;
}

export interface TransitionSample<T> {
  readonly value: T;
  readonly complete: boolean;
}

const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function easedProgress(transition: TimedTransition<unknown>, nowMs: number): {
  progress: number;
  complete: boolean;
} {
  const linear = transition.durationSeconds <= 0
    ? 1
    : Math.max(
      0,
      Math.min(
        1,
        (nowMs - transition.startedAtMs) / 1_000 /
          transition.durationSeconds,
      ),
    );
  return {
    progress: linear * linear * (3 - 2 * linear),
    complete: linear >= 1,
  };
}

function coordinatesVector(
  coordinates: NavigationCoordinates,
): readonly [number, number, number] {
  const latitude = coordinates.latitudeDegrees * DEGREES_TO_RADIANS;
  const longitude = coordinates.longitudeDegrees * DEGREES_TO_RADIANS;
  const cosineLatitude = Math.cos(latitude);
  return [
    cosineLatitude * Math.cos(longitude),
    Math.sin(latitude),
    -cosineLatitude * Math.sin(longitude),
  ];
}

function interpolateCoordinates(
  from: NavigationCoordinates,
  to: NavigationCoordinates,
  progress: number,
): NavigationCoordinates {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  const a = coordinatesVector(from);
  const b = coordinatesVector(to);
  const start = { x: a[0], y: a[1], z: a[2] };
  const reference = Math.abs(start.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const tangent = subtractSpatialVectors(reference, scaleSpatialVector(start, dotSpatialVectors(start, reference)));
  const direction = interpolateSpatialDirections(start, { x: b[0], y: b[1], z: b[2] }, progress, {
    antipodalTangent: tangent, antipodalCosineThreshold: -1 + Number.EPSILON,
  });
  return {
    latitudeDegrees: Math.asin(clampUnit(direction.y)) * RADIANS_TO_DEGREES,
    longitudeDegrees: Math.atan2(-direction.z, direction.x) * RADIANS_TO_DEGREES,
  };
}

export function sampleWarpTransition(
  transition: TimedTransition<NavigationCoordinates>,
  nowMs: number,
): TransitionSample<NavigationCoordinates> {
  const { progress, complete } = easedProgress(transition, nowMs);
  return {
    value: interpolateCoordinates(transition.from, transition.to, progress),
    complete,
  };
}

export function sampleScaleTransition(
  transition: TimedTransition<number>,
  nowMs: number,
): TransitionSample<number> {
  const { progress, complete } = easedProgress(transition, nowMs);
  if (complete) return { value: transition.to, complete: true };
  if (progress <= 0) return { value: transition.from, complete: false };
  return {
    value: Math.exp(
      Math.log(transition.from) +
        (Math.log(transition.to) - Math.log(transition.from)) * progress,
    ),
    complete,
  };
}

function normalizeAngleRadians(radians: number): number {
  const turn = Math.PI * 2;
  return ((radians + Math.PI) % turn + turn) % turn - Math.PI;
}

export function sampleAngleTransition(
  transition: TimedTransition<number>,
  nowMs: number,
): TransitionSample<number> {
  const { progress, complete } = easedProgress(transition, nowMs);
  if (complete) return { value: transition.to, complete: true };
  if (progress <= 0) return { value: transition.from, complete: false };
  const shortestDelta = normalizeAngleRadians(transition.to - transition.from);
  return {
    value: normalizeAngleRadians(transition.from + shortestDelta * progress),
    complete: false,
  };
}
