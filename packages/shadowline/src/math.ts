import type {
  CartesianVector,
  GeographicPoint,
  Position,
} from "./types.js";

export const AU_KM = 149_597_870.700;
export const WGS84_A_KM = 6378.137;
export const WGS84_FLATTENING = 1 / 298.257223563;
export const WGS84_B_KM = WGS84_A_KM * (1 - WGS84_FLATTENING);
export const EARTH_MEAN_RADIUS_KM = 6371.0088;
export const SUN_RADIUS_KM = 695_700;
export const MOON_RADIUS_KM = 1737.4;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export function add(a: CartesianVector, b: CartesianVector): CartesianVector {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtract(
  a: CartesianVector,
  b: CartesianVector,
): CartesianVector {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: CartesianVector, factor: number): CartesianVector {
  return { x: a.x * factor, y: a.y * factor, z: a.z * factor };
}

export function dot(a: CartesianVector, b: CartesianVector): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function magnitude(a: CartesianVector): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: CartesianVector): CartesianVector {
  const length = magnitude(a);
  if (length === 0) {
    throw new RangeError("Cannot normalize a zero-length vector.");
  }
  return scale(a, 1 / length);
}

export function normalizeLongitude(longitudeDeg: number): number {
  const normalized = ((longitudeDeg + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

export function geodeticToEcef(point: GeographicPoint): CartesianVector {
  const latitude = point.latitudeDeg * DEG;
  const longitude = point.longitudeDeg * DEG;
  const e2 =
    1 - (WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);
  const sinLatitude = Math.sin(latitude);
  const n = WGS84_A_KM / Math.sqrt(1 - e2 * sinLatitude * sinLatitude);
  const cosLatitude = Math.cos(latitude);
  return {
    x: n * cosLatitude * Math.cos(longitude),
    y: n * cosLatitude * Math.sin(longitude),
    z: n * (1 - e2) * sinLatitude,
  };
}

export function ecefToGeodetic(vectorKm: CartesianVector): GeographicPoint {
  const e2 =
    1 - (WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);
  const p = Math.hypot(vectorKm.x, vectorKm.y);
  if (p < 1e-12) {
    return {
      latitudeDeg: vectorKm.z >= 0 ? 90 : -90,
      longitudeDeg: 0,
    };
  }

  let latitude = Math.atan2(vectorKm.z, p * (1 - e2));
  for (let index = 0; index < 8; index += 1) {
    const sinLatitude = Math.sin(latitude);
    const n = WGS84_A_KM / Math.sqrt(1 - e2 * sinLatitude * sinLatitude);
    latitude = Math.atan2(vectorKm.z + e2 * n * sinLatitude, p);
  }

  return {
    latitudeDeg: latitude * RAD,
    longitudeDeg: normalizeLongitude(Math.atan2(vectorKm.y, vectorKm.x) * RAD),
  };
}

export function haversineDistanceKm(a: Position, b: Position): number {
  const latitude1 = a[1] * DEG;
  const latitude2 = b[1] * DEG;
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = normalizeLongitude(b[0] - a[0]) * DEG;
  const value =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(deltaLongitude / 2) ** 2;
  return (
    2 *
    EARTH_MEAN_RADIUS_KM *
    Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
  );
}

export function toIsoUtc(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(`Invalid UTC instant: ${String(value)}`);
  }
  return date.toISOString().replace(".000Z", "Z");
}

export function addSeconds(utc: string, seconds: number): string {
  return toIsoUtc(new Date(utc).getTime() + seconds * 1000);
}

export function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
