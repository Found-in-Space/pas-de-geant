import {
  EARTH_MEAN_RADIUS_KM,
  ecefToGeodetic,
  geodeticToEcef,
} from "@found-in-space/shadowline";
import * as THREE from "three";

export interface EclipseEarthSurfaceObservation {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  /** Headset position in Earth-fixed display coordinates. */
  readonly headPoint: THREE.Vector3;
  /** Nearest point on the WGS84 ellipsoid in Earth-fixed display coordinates. */
  readonly surfacePoint: THREE.Vector3;
  /** Outward WGS84 normal at the nearest point, in Earth-fixed display axes. */
  readonly surfaceNormal: THREE.Vector3;
  /** Room-space distance from the headset to that ellipsoid point. */
  readonly headDistanceWorldM: number;
  /** Signed distance along the surface normal; negative only below WGS84. */
  readonly signedHeadHeightWorldM: number;
  /** Non-normal residual of the head-to-surface vector. */
  readonly nearestPointResidualWorldM: number;
}

function displayPointToEcefKm(point: THREE.Vector3): {
  x: number;
  y: number;
  z: number;
} {
  return {
    x: point.x * EARTH_MEAN_RADIUS_KM,
    y: -point.z * EARTH_MEAN_RADIUS_KM,
    z: point.y * EARTH_MEAN_RADIUS_KM,
  };
}

function ecefKmToDisplayPoint(point: {
  x: number;
  y: number;
  z: number;
}): THREE.Vector3 {
  return new THREE.Vector3(
    point.x / EARTH_MEAN_RADIUS_KM,
    point.z / EARTH_MEAN_RADIUS_KM,
    -point.y / EARTH_MEAN_RADIUS_KM,
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
 * Projects an Earth-fixed headset position onto WGS84. The returned distance
 * uses the observatory's uniform room-metres-per-Earth-radius scale.
 */
export function eclipseEarthSurfaceObservation(
  headEarthFixed: THREE.Vector3,
  metresPerEarthRadius: number,
): EclipseEarthSurfaceObservation {
  const geodetic = ecefToGeodetic(displayPointToEcefKm(headEarthFixed));
  const surfacePoint = ecefKmToDisplayPoint(geodeticToEcef(geodetic));
  const latitude = THREE.MathUtils.degToRad(geodetic.latitudeDeg);
  const longitude = THREE.MathUtils.degToRad(geodetic.longitudeDeg);
  const surfaceNormal = new THREE.Vector3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.sin(latitude),
    -Math.cos(latitude) * Math.sin(longitude),
  ).normalize();
  const headFromSurface = headEarthFixed.clone().sub(surfacePoint);
  const signedHeadHeightEarthRadii = headFromSurface.dot(surfaceNormal);
  const nearestPointResidualEarthRadii = headFromSurface
    .addScaledVector(surfaceNormal, -signedHeadHeightEarthRadii)
    .length();
  return {
    latitudeDegrees: geodetic.latitudeDeg,
    longitudeDegrees: geodetic.longitudeDeg,
    headPoint: headEarthFixed.clone(),
    surfacePoint,
    surfaceNormal,
    headDistanceWorldM: headEarthFixed.distanceTo(surfacePoint) *
      metresPerEarthRadius,
    signedHeadHeightWorldM:
      signedHeadHeightEarthRadii * metresPerEarthRadius,
    nearestPointResidualWorldM:
      nearestPointResidualEarthRadii * metresPerEarthRadius,
  };
}
