import * as THREE from "three";

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
