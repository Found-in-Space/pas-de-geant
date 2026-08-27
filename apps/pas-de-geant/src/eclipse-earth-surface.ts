import {
  ecefToGeodetic,
  geodeticToEcef,
} from "@found-in-space/shadowline";
import * as THREE from "three";

export interface EclipseEarthSurfaceObservation {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  /** Observer head position in Earth-fixed physical metres. */
  readonly headPoint: THREE.Vector3;
  /** Nearest point on the WGS84 ellipsoid in Earth-fixed physical metres. */
  readonly surfacePoint: THREE.Vector3;
  /** Outward WGS84 normal at the nearest point, in Earth-fixed display axes. */
  readonly surfaceNormal: THREE.Vector3;
  /** Physical distance from the headset to that ellipsoid point. */
  readonly headDistancePhysicalM: number;
  /** Signed distance along the surface normal; negative only below WGS84. */
  readonly signedHeadHeightPhysicalM: number;
  /** Non-normal residual of the head-to-surface vector. */
  readonly nearestPointResidualPhysicalM: number;
}

function physicalPointToEcefKm(point: THREE.Vector3): {
  x: number;
  y: number;
  z: number;
} {
  return {
    x: point.x / 1_000,
    y: -point.z / 1_000,
    z: point.y / 1_000,
  };
}

function ecefKmToPhysicalPoint(point: {
  x: number;
  y: number;
  z: number;
}): THREE.Vector3 {
  return new THREE.Vector3(
    point.x * 1_000,
    point.z * 1_000,
    -point.y * 1_000,
  );
}

/** Midpoint of current XR eye poses composed through the navigation rig. */
export function trackedHeadWorldPosition(
  eyeReferenceSpacePositions: readonly THREE.Vector3[],
  referenceSpaceToWorld: THREE.Matrix4,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  if (eyeReferenceSpacePositions.length === 0) {
    throw new Error("At least one XR eye pose is required.");
  }
  target.set(0, 0, 0);
  for (const eyePosition of eyeReferenceSpacePositions) {
    target.add(eyePosition);
  }
  return target
    .multiplyScalar(1 / eyeReferenceSpacePositions.length)
    .applyMatrix4(referenceSpaceToWorld);
}

/** Current tracked-head orientation composed through the navigation rig. */
export function trackedHeadWorldQuaternion(
  headReferenceSpaceQuaternion: THREE.Quaternion,
  referenceSpaceWorldQuaternion: THREE.Quaternion,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  return target
    .copy(referenceSpaceWorldQuaternion)
    .multiply(headReferenceSpaceQuaternion)
    .normalize();
}

/**
 * Projects an Earth-fixed physical-metre headset position onto WGS84.
 */
export function eclipseEarthSurfaceObservation(
  headEarthFixed: THREE.Vector3,
): EclipseEarthSurfaceObservation {
  const geodetic = ecefToGeodetic(physicalPointToEcefKm(headEarthFixed));
  const surfacePoint = ecefKmToPhysicalPoint(geodeticToEcef(geodetic));
  const latitude = THREE.MathUtils.degToRad(geodetic.latitudeDeg);
  const longitude = THREE.MathUtils.degToRad(geodetic.longitudeDeg);
  const surfaceNormal = new THREE.Vector3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.sin(latitude),
    -Math.cos(latitude) * Math.sin(longitude),
  ).normalize();
  const headFromSurface = headEarthFixed.clone().sub(surfacePoint);
  const signedHeadHeightPhysicalM = headFromSurface.dot(surfaceNormal);
  const nearestPointResidualPhysicalM = headFromSurface
    .addScaledVector(surfaceNormal, -signedHeadHeightPhysicalM)
    .length();
  return {
    latitudeDegrees: geodetic.latitudeDeg,
    longitudeDegrees: geodetic.longitudeDeg,
    headPoint: headEarthFixed.clone(),
    surfacePoint,
    surfaceNormal,
    headDistancePhysicalM: headEarthFixed.distanceTo(surfacePoint),
    signedHeadHeightPhysicalM,
    nearestPointResidualPhysicalM,
  };
}

/** The currently rendered topographic surface point in physical metres. */
export function eclipseTopographicSurfacePoint(
  observation: EclipseEarthSurfaceObservation,
  elevationMetres: number,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target.copy(observation.surfacePoint).addScaledVector(
    observation.surfaceNormal,
    elevationMetres,
  );
}

/** Earth-centred physical-metre radius of the WGS84-plus-terrain surface. */
export function eclipseTopographicSurfaceRadius(
  observation: EclipseEarthSurfaceObservation,
  elevationMetres: number,
): number {
  return eclipseTopographicSurfacePoint(observation, elevationMetres).length();
}

/** Radial clearance above rendered terrain in physical Earth metres. */
export function eclipseTopographicAltitudeMetres(
  observation: EclipseEarthSurfaceObservation,
  elevationMetres: number,
): number {
  return observation.headPoint.length() -
    eclipseTopographicSurfaceRadius(observation, elevationMetres);
}
