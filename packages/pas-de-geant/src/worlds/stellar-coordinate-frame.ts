import {
  SPATIAL_Z_UP_TO_Y_UP, applySpatialQuaternion, multiplySpatialQuaternions,
  invertSpatialQuaternion, subtractSpatialVectors,
} from "@found-in-space/spatial";
import * as THREE from "three";
import type { Vector3d } from "./solar-system.js";
import { translatedObserverJ2000M } from "./world-navigation.js";


/**
 * Combines the app-authored rendered-system orientation with the single fixed
 * raw-J2000-to-Three axis conversion. The result maps catalogue coordinates
 * directly from J2000 into world space.
 */
export function j2000ToWorldQuaternion(
  renderedSystemToWorld: THREE.Quaternion,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  const value = multiplySpatialQuaternions(renderedSystemToWorld, SPATIAL_Z_UP_TO_Y_UP);
  return target.set(value.x, value.y, value.z, value.w);
}

export function j2000VectorToRenderAxes(
  value: THREE.Vector3,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const rotated = applySpatialQuaternion(value, SPATIAL_Z_UP_TO_Y_UP);
  return target.set(rotated.x, rotated.y, rotated.z);
}

/** Physical tracked-space translation with authored observer-rig motion removed. */
export function trackingRoomOffsetWorld(
  currentTrackingLocal: THREE.Vector3,
  trackingOriginLocal: THREE.Vector3,
  observerRigToWorld: THREE.Quaternion,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const offset = applySpatialQuaternion(
    subtractSpatialVectors(currentTrackingLocal, trackingOriginLocal), observerRigToWorld,
  );
  return target.set(offset.x, offset.y, offset.z);
}

/** Rebase a rendered world point without changing its physical J2000 pose. */
export function j2000ObserverAtWorldPoint(
  originJ2000M: Vector3d,
  originWorld: THREE.Vector3,
  pointWorld: THREE.Vector3,
  renderedSystemToWorld: THREE.Quaternion,
  scaleDenominator: number,
): Vector3d {
  const offset = applySpatialQuaternion(
    subtractSpatialVectors(pointWorld, originWorld), invertSpatialQuaternion(renderedSystemToWorld),
  );
  return translatedObserverJ2000M(originJ2000M, offset, scaleDenominator);
}
