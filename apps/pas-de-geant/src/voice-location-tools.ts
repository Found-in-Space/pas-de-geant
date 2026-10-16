export function parseLocationToolArguments(value: unknown): {
  latitudeDegrees: number;
  longitudeDegrees: number;
  time?: number;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Location arguments must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const latitudeDegrees = candidate.latitude_degrees;
  const longitudeDegrees = candidate.longitude_degrees;
  if (
    typeof latitudeDegrees !== "number" ||
    !Number.isFinite(latitudeDegrees) ||
    latitudeDegrees < -90 ||
    latitudeDegrees > 90
  ) {
    throw new Error("Latitude must be between -90 and 90 degrees.");
  }
  if (
    typeof longitudeDegrees !== "number" ||
    !Number.isFinite(longitudeDegrees) ||
    longitudeDegrees < -180 ||
    longitudeDegrees > 180
  ) {
    throw new Error("Longitude must be between -180 and 180 degrees.");
  }
  const time = candidate.time;
  if (
    time !== undefined &&
    (typeof time !== "number" || !Number.isFinite(time) || time < 0)
  ) {
    throw new Error("Transition time must be a nonnegative finite number.");
  }
  return {
    latitudeDegrees,
    longitudeDegrees,
    ...(time === undefined ? {} : { time }),
  };
}
