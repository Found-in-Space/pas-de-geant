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

function cross(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalize(
  value: readonly [number, number, number],
): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function interpolateCoordinates(
  from: NavigationCoordinates,
  to: NavigationCoordinates,
  progress: number,
): NavigationCoordinates {
  if (progress <= 0) return from;
  if (progress >= 1) return to;

  const start = coordinatesVector(from);
  const end = coordinatesVector(to);
  const dot = clampUnit(
    start[0] * end[0] + start[1] * end[1] + start[2] * end[2],
  );
  const angle = Math.acos(dot);
  if (angle < 1e-10) return from;

  let axis = cross(start, end);
  if (Math.hypot(axis[0], axis[1], axis[2]) < 1e-10) {
    const reference: readonly [number, number, number] =
      Math.abs(start[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    axis = cross(start, reference);
  }
  axis = normalize(axis);

  const step = angle * progress;
  const cosine = Math.cos(step);
  const sine = Math.sin(step);
  const axisCrossStart = cross(axis, start);
  const axisDotStart =
    axis[0] * start[0] + axis[1] * start[1] + axis[2] * start[2];
  const interpolated: [number, number, number] = [
    start[0] * cosine + axisCrossStart[0] * sine +
      axis[0] * axisDotStart * (1 - cosine),
    start[1] * cosine + axisCrossStart[1] * sine +
      axis[1] * axisDotStart * (1 - cosine),
    start[2] * cosine + axisCrossStart[2] * sine +
      axis[2] * axisDotStart * (1 - cosine),
  ];

  return {
    latitudeDegrees: Math.asin(clampUnit(interpolated[1])) *
      RADIANS_TO_DEGREES,
    longitudeDegrees: Math.atan2(-interpolated[2], interpolated[0]) *
      RADIANS_TO_DEGREES,
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
