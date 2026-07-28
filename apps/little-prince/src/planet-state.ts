import { Matrix4, Quaternion, Vector2, Vector3 } from "three";

export const EARTH_MEAN_RADIUS_KM = 6371.0088;
export const WGS84_A_KM = 6378.137;
export const WGS84_B_KM = 6356.752314245;
export const IBERIA_REFERENCE_WIDTH_KM = 1000;
export const INITIAL_IBERIA_WIDTH_M = 10;
export const INITIAL_DISPLAY_RADIUS_M =
  (EARTH_MEAN_RADIUS_KM / IBERIA_REFERENCE_WIDTH_KM) *
  INITIAL_IBERIA_WIDTH_M;
export const MIN_DISPLAY_RADIUS_M = 1;
export const MAX_DISPLAY_RADIUS_M =
  (EARTH_MEAN_RADIUS_KM / IBERIA_REFERENCE_WIDTH_KM) * 50;
export const MIN_RELIEF_EXAGGERATION = 0;
export const MAX_RELIEF_EXAGGERATION = 20;

const rotation = new Quaternion();
const movementAxis = new Vector3();
const tangent = new Vector3();
const matrix = new Matrix4();
const surfacePoint = new Vector3();
const rotatedSurface = new Vector3();

export interface ContactFrame {
  upEcef: Vector3;
  eastEcef: Vector3;
  northEcef: Vector3;
}

export type OceanMode = "surface" | "revealed";

export interface PlanetState {
  contact: ContactFrame;
  displayRadiusM: number;
  reliefExaggeration: number;
  oceanMode: OceanMode;
}

export interface PlanetPose {
  earthToWorld: Quaternion;
  centre: Vector3;
}

export function contactFrame(
  latitudeDegrees: number,
  longitudeDegrees: number,
): ContactFrame {
  const latitude = latitudeDegrees * Math.PI / 180;
  const longitude = longitudeDegrees * Math.PI / 180;
  const sineLatitude = Math.sin(latitude);
  const cosineLatitude = Math.cos(latitude);
  const sineLongitude = Math.sin(longitude);
  const cosineLongitude = Math.cos(longitude);
  return {
    upEcef: new Vector3(
      cosineLatitude * cosineLongitude,
      sineLatitude,
      -cosineLatitude * sineLongitude,
    ),
    eastEcef: new Vector3(-sineLongitude, 0, -cosineLongitude),
    northEcef: new Vector3(
      -sineLatitude * cosineLongitude,
      cosineLatitude,
      sineLatitude * sineLongitude,
    ),
  };
}

export function initialPlanetState(): PlanetState {
  return {
    contact: contactFrame(40, -4),
    displayRadiusM: INITIAL_DISPLAY_RADIUS_M,
    reliefExaggeration: 1,
    oceanMode: "surface",
  };
}

export function coordinatesForFrame(frame: ContactFrame): {
  latitudeDegrees: number;
  longitudeDegrees: number;
} {
  return {
    latitudeDegrees: Math.asin(
      Math.max(-1, Math.min(1, frame.upEcef.y)),
    ) * 180 / Math.PI,
    longitudeDegrees:
      Math.atan2(-frame.upEcef.z, frame.upEcef.x) * 180 / Math.PI,
  };
}

/**
 * Rolls a local tangent frame through the displayed surface displacement.
 * World +X is local east and world -Z is local north.
 */
export function rollContactFrame(
  frame: ContactFrame,
  displacementWorld: Vector2,
  displayRadiusM: number,
): ContactFrame {
  const distance = displacementWorld.length();
  if (distance === 0) {
    return {
      upEcef: frame.upEcef.clone(),
      eastEcef: frame.eastEcef.clone(),
      northEcef: frame.northEcef.clone(),
    };
  }
  tangent
    .copy(frame.eastEcef)
    .multiplyScalar(displacementWorld.x)
    .addScaledVector(frame.northEcef, -displacementWorld.y)
    .normalize();
  movementAxis
    .crossVectors(frame.upEcef, tangent)
    .normalize();
  rotation.setFromAxisAngle(movementAxis, distance / displayRadiusM);
  return {
    upEcef: frame.upEcef.clone().applyQuaternion(rotation).normalize(),
    eastEcef: frame.eastEcef.clone().applyQuaternion(rotation).normalize(),
    northEcef: frame.northEcef.clone().applyQuaternion(rotation).normalize(),
  };
}

export function earthToWorldQuaternion(frame: ContactFrame): Quaternion {
  matrix.set(
    frame.eastEcef.x,
    frame.eastEcef.y,
    frame.eastEcef.z,
    0,
    frame.upEcef.x,
    frame.upEcef.y,
    frame.upEcef.z,
    0,
    -frame.northEcef.x,
    -frame.northEcef.y,
    -frame.northEcef.z,
    0,
    0,
    0,
    0,
    1,
  );
  return new Quaternion().setFromRotationMatrix(matrix).normalize();
}

export function geodeticSurfaceEcefKm(
  latitudeDegrees: number,
  longitudeDegrees: number,
): Vector3 {
  const latitude = latitudeDegrees * Math.PI / 180;
  const longitude = longitudeDegrees * Math.PI / 180;
  const sineLatitude = Math.sin(latitude);
  const cosineLatitude = Math.cos(latitude);
  const eccentricitySquared =
    1 - (WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);
  const primeVerticalRadius =
    WGS84_A_KM /
    Math.sqrt(1 - eccentricitySquared * sineLatitude * sineLatitude);
  return new Vector3(
    primeVerticalRadius * cosineLatitude * Math.cos(longitude),
    primeVerticalRadius * (1 - eccentricitySquared) * sineLatitude,
    -primeVerticalRadius * cosineLatitude * Math.sin(longitude),
  );
}

export function solvePlanetPose(
  state: PlanetState,
  headsetFloorPosition: Vector2,
): PlanetPose {
  const coordinates = coordinatesForFrame(state.contact);
  const earthToWorld = earthToWorldQuaternion(state.contact);
  surfacePoint
    .copy(
      geodeticSurfaceEcefKm(
        coordinates.latitudeDegrees,
        coordinates.longitudeDegrees,
      ),
    )
    .multiplyScalar(state.displayRadiusM / EARTH_MEAN_RADIUS_KM);
  rotatedSurface.copy(surfacePoint).applyQuaternion(earthToWorld);
  return {
    earthToWorld,
    centre: new Vector3(
      headsetFloorPosition.x - rotatedSurface.x,
      -rotatedSurface.y,
      headsetFloorPosition.y - rotatedSurface.z,
    ),
  };
}

export function displayRadiusForIberiaWidth(widthM: number): number {
  return (EARTH_MEAN_RADIUS_KM / IBERIA_REFERENCE_WIDTH_KM) * widthM;
}

export function iberiaWidthForDisplayRadius(radiusM: number): number {
  return radiusM * IBERIA_REFERENCE_WIDTH_KM / EARTH_MEAN_RADIUS_KM;
}

export function applyLogarithmicScale(
  radiusM: number,
  axis: number,
  deltaSeconds: number,
  octavesPerSecond = 0.72,
): number {
  const next = radiusM * 2 ** (axis * octavesPerSecond * deltaSeconds);
  const clamped = Math.max(
    MIN_DISPLAY_RADIUS_M,
    Math.min(MAX_DISPLAY_RADIUS_M, next),
  );
  const detentDistance =
    Math.abs(Math.log2(clamped / INITIAL_DISPLAY_RADIUS_M));
  if (Math.abs(axis) < 0.12 && detentDistance < 0.035) {
    return INITIAL_DISPLAY_RADIUS_M;
  }
  return clamped;
}

export function applyReliefRate(
  exaggeration: number,
  axis: number,
  deltaSeconds: number,
  unitsPerSecond = 3,
): number {
  const next = Math.max(
    MIN_RELIEF_EXAGGERATION,
    Math.min(
      MAX_RELIEF_EXAGGERATION,
      exaggeration + axis * unitsPerSecond * deltaSeconds,
    ),
  );
  if (Math.abs(axis) < 0.12 && Math.abs(next - 1) < 0.08) return 1;
  return next;
}

export function apexError(
  state: PlanetState,
  pose: PlanetPose,
  headsetFloorPosition: Vector2,
): Vector3 {
  const coordinates = coordinatesForFrame(state.contact);
  return geodeticSurfaceEcefKm(
    coordinates.latitudeDegrees,
    coordinates.longitudeDegrees,
  )
    .multiplyScalar(state.displayRadiusM / EARTH_MEAN_RADIUS_KM)
    .applyQuaternion(pose.earthToWorld)
    .add(pose.centre)
    .sub(new Vector3(headsetFloorPosition.x, 0, headsetFloorPosition.y));
}

export function frameIsOrthonormal(frame: ContactFrame): boolean {
  return (
    Math.abs(frame.upEcef.length() - 1) < 1e-10 &&
    Math.abs(frame.eastEcef.length() - 1) < 1e-10 &&
    Math.abs(frame.northEcef.length() - 1) < 1e-10 &&
    Math.abs(frame.upEcef.dot(frame.eastEcef)) < 1e-10 &&
    Math.abs(frame.upEcef.dot(frame.northEcef)) < 1e-10 &&
    Math.abs(frame.eastEcef.dot(frame.northEcef)) < 1e-10 &&
    frame.eastEcef.clone().cross(frame.northEcef).dot(frame.upEcef) > 0.999999
  );
}
