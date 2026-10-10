import * as THREE from "three";
import type { Vector3d } from "./solar-system.js";
import { translatedObserverJ2000M } from "./world-navigation.js";

/** Raw equatorial J2000 axes (x,y,z) to Pas de Géant's Three.js Y-up axes. */
const J2000_TO_RENDER_AXES = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);

/**
 * Combines the app-authored rendered-system orientation with the single fixed
 * raw-J2000-to-Three axis conversion. The result maps catalogue coordinates
 * directly from J2000 into world space.
 */
export function j2000ToWorldQuaternion(
  renderedSystemToWorld: THREE.Quaternion,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  return target.copy(renderedSystemToWorld)
    .multiply(J2000_TO_RENDER_AXES)
    .normalize();
}

export function j2000VectorToRenderAxes(
  value: THREE.Vector3,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target.copy(value).applyQuaternion(J2000_TO_RENDER_AXES);
}

/** Physical tracked-space translation with authored observer-rig motion removed. */
export function trackingRoomOffsetWorld(
  currentTrackingLocal: THREE.Vector3,
  trackingOriginLocal: THREE.Vector3,
  observerRigToWorld: THREE.Quaternion,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target.copy(currentTrackingLocal)
    .sub(trackingOriginLocal)
    .applyQuaternion(observerRigToWorld);
}

/** Rebase a rendered world point without changing its physical J2000 pose. */
export function j2000ObserverAtWorldPoint(
  originJ2000M: Vector3d,
  originWorld: THREE.Vector3,
  pointWorld: THREE.Vector3,
  renderedSystemToWorld: THREE.Quaternion,
  scaleDenominator: number,
): Vector3d {
  const renderOffset = pointWorld.clone()
    .sub(originWorld)
    .applyQuaternion(renderedSystemToWorld.clone().invert());
  return translatedObserverJ2000M(
    originJ2000M,
    renderOffset,
    scaleDenominator,
  );
}
