import * as THREE from "three";
import type { GripPose } from "./eclipse-stage.js";

export interface EclipseObserverTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export interface ObserverTwoGripGesture {
  observerStart: THREE.Matrix4;
  midpointStart: THREE.Vector3;
  directionStart: THREE.Vector3;
}

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

function targetOrbitRotation(
  headWorldPosition: THREE.Vector3,
  headWorldQuaternion: THREE.Quaternion,
  targetWorldPosition: THREE.Vector3,
  horizontalRadians: number,
  verticalRadians: number,
): THREE.Quaternion {
  const angle = Math.hypot(horizontalRadians, verticalRadians);
  if (angle === 0) return new THREE.Quaternion();
  const radial = headWorldPosition.clone().sub(targetWorldPosition).normalize();
  const screenRight = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(headWorldQuaternion);
  screenRight.addScaledVector(radial, -screenRight.dot(radial));
  const screenUp = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(headWorldQuaternion);
  screenUp.addScaledVector(radial, -screenUp.dot(radial));
  if (screenRight.lengthSq() > Number.EPSILON) screenRight.normalize();
  if (screenUp.lengthSq() > Number.EPSILON) screenUp.normalize();
  const tangent = screenRight.multiplyScalar(horizontalRadians)
    .addScaledVector(screenUp, verticalRadians);
  if (tangent.lengthSq() <= Number.EPSILON) return new THREE.Quaternion();
  const axis = radial.clone().cross(tangent.normalize()).normalize();
  return new THREE.Quaternion().setFromAxisAngle(axis, angle);
}

function observerMatrix(observer: EclipseObserverTransform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    observer.position,
    observer.quaternion,
    UNIT_SCALE,
  );
}

function observerTransform(matrix: THREE.Matrix4): EclipseObserverTransform {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, quaternion: quaternion.normalize() };
}

/** Translates the navigation rig so the live tracked head reaches a world point. */
export function observerTranslatedForHeadPosition(
  observer: EclipseObserverTransform,
  headWorldPosition: THREE.Vector3,
  desiredHeadWorldPosition: THREE.Vector3,
): EclipseObserverTransform {
  return {
    position: observer.position.clone().add(
      desiredHeadWorldPosition.clone().sub(headWorldPosition),
    ),
    quaternion: observer.quaternion.clone(),
  };
}

/**
 * Rigidly moves the complete observer around Earth in live headset-relative
 * screen directions. Applying the same rotation to the rig position and
 * orientation keeps Earth fixed in headset space.
 */
export function updateObserverEarthOrbit(
  observer: EclipseObserverTransform,
  headWorldPosition: THREE.Vector3,
  headWorldQuaternion: THREE.Quaternion,
  earthWorldPosition: THREE.Vector3,
  horizontalRadians: number,
  verticalRadians: number,
): EclipseObserverTransform {
  const rotation = targetOrbitRotation(
    headWorldPosition,
    headWorldQuaternion,
    earthWorldPosition,
    horizontalRadians,
    verticalRadians,
  );
  return {
    position: observer.position.clone()
      .sub(earthWorldPosition)
      .applyQuaternion(rotation)
      .add(earthWorldPosition),
    quaternion: rotation.clone().multiply(observer.quaternion).normalize(),
  };
}

/**
 * Moves a target-locked observer by rotating the rendered system oppositely.
 * The tracked XR space stays stable while the point beneath the observer moves.
 */
export function updateTargetLockedOrbitFrame(
  systemFrameQuaternion: THREE.Quaternion,
  headWorldPosition: THREE.Vector3,
  headWorldQuaternion: THREE.Quaternion,
  targetWorldPosition: THREE.Vector3,
  horizontalRadians: number,
  verticalRadians: number,
): THREE.Quaternion {
  return targetOrbitRotation(
    headWorldPosition,
    headWorldQuaternion,
    targetWorldPosition,
    horizontalRadians,
    verticalRadians,
  ).invert().multiply(systemFrameQuaternion).normalize();
}

/** Projects a candidate tracked-head position onto an Earth-centred sphere. */
export function observerProjectedToEarthRadius(
  observer: EclipseObserverTransform,
  headWorldPosition: THREE.Vector3,
  earthWorldPosition: THREE.Vector3,
  radiusM: number,
): EclipseObserverTransform {
  const desiredHeadPosition = headWorldPosition.clone()
    .sub(earthWorldPosition)
    .setLength(radiusM)
    .add(earthWorldPosition);
  return observerTranslatedForHeadPosition(
    observer,
    headWorldPosition,
    desiredHeadPosition,
  );
}

export function beginObserverTwoGrip(
  first: GripPose,
  second: GripPose,
  observer: EclipseObserverTransform,
): ObserverTwoGripGesture | null {
  const directionStart = second.position.clone().sub(first.position);
  if (directionStart.lengthSq() <= Number.EPSILON) return null;
  return {
    observerStart: observerMatrix(observer),
    midpointStart: first.position.clone().add(second.position).multiplyScalar(0.5),
    directionStart: directionStart.normalize(),
  };
}

export function updateObserverTwoGrip(
  gesture: ObserverTwoGripGesture,
  first: GripPose,
  second: GripPose,
): EclipseObserverTransform {
  const direction = second.position.clone().sub(first.position);
  if (direction.lengthSq() <= Number.EPSILON) {
    return observerTransform(gesture.observerStart);
  }
  direction.normalize();
  const midpoint = first.position.clone().add(second.position).multiplyScalar(0.5);
  const rotation = new THREE.Quaternion().setFromUnitVectors(
    direction,
    gesture.directionStart,
  );
  const currentToStart = new THREE.Matrix4()
    .makeTranslation(
      gesture.midpointStart.x,
      gesture.midpointStart.y,
      gesture.midpointStart.z,
    )
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rotation))
    .multiply(new THREE.Matrix4().makeTranslation(
      -midpoint.x,
      -midpoint.y,
      -midpoint.z,
    ));
  return observerTransform(
    gesture.observerStart.clone().multiply(currentToStart),
  );
}
