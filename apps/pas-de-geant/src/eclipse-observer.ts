import * as THREE from "three";
import type { GripPose } from "./eclipse-stage.js";

export interface EclipseObserverTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export interface ObserverOneGripGesture {
  observerStart: THREE.Matrix4;
  gripStart: THREE.Matrix4;
}

export interface ObserverTwoGripGesture {
  observerStart: THREE.Matrix4;
  midpointStart: THREE.Vector3;
  directionStart: THREE.Vector3;
}

export interface ObserverFlightInput {
  flightAxis: number;
  rollAxis: number;
  elapsedSeconds: number;
  metresPerSecond?: number;
  rollRadiansPerSecond?: number;
}

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

function poseMatrix(pose: GripPose): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    pose.position,
    pose.quaternion,
    UNIT_SCALE,
  );
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

export function observerPositionForView(
  focusWorld: THREE.Vector3,
  distanceM: number,
  trackedHeadPosition: THREE.Vector3,
  trackedHeadQuaternion: THREE.Quaternion,
  observerQuaternion: THREE.Quaternion,
): THREE.Vector3 {
  const worldForward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(trackedHeadQuaternion)
    .applyQuaternion(observerQuaternion)
    .normalize();
  const desiredHeadPosition = focusWorld.clone().addScaledVector(
    worldForward,
    -distanceM,
  );
  const trackedHeadOffset = trackedHeadPosition
    .clone()
    .applyQuaternion(observerQuaternion);
  return desiredHeadPosition.sub(trackedHeadOffset);
}

export function beginObserverOneGrip(
  gripInReferenceSpace: GripPose,
  observer: EclipseObserverTransform,
): ObserverOneGripGesture {
  return {
    observerStart: observerMatrix(observer),
    gripStart: poseMatrix(gripInReferenceSpace),
  };
}

export function updateObserverOneGrip(
  gesture: ObserverOneGripGesture,
  gripInReferenceSpace: GripPose,
): EclipseObserverTransform {
  return observerTransform(
    gesture.observerStart
      .clone()
      .multiply(gesture.gripStart)
      .multiply(poseMatrix(gripInReferenceSpace).invert()),
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

/**
 * Flies along the live headset gaze and rolls the observer around that gaze.
 * Rolling pivots around the tracked head so it changes orientation without
 * introducing an incidental translation.
 */
export function updateObserverHeadRelativeFlight(
  observer: EclipseObserverTransform,
  headWorldPosition: THREE.Vector3,
  headWorldQuaternion: THREE.Quaternion,
  input: ObserverFlightInput,
): EclipseObserverTransform {
  const metresPerSecond = input.metresPerSecond ?? 1.8;
  const rollRadiansPerSecond = input.rollRadiansPerSecond ?? 1.35;
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(headWorldQuaternion)
    .normalize();
  const next = {
    position: observer.position.clone(),
    quaternion: observer.quaternion.clone(),
  };
  if (input.rollAxis !== 0) {
    const roll = new THREE.Quaternion().setFromAxisAngle(
      forward,
      input.rollAxis * rollRadiansPerSecond * input.elapsedSeconds,
    );
    next.position
      .sub(headWorldPosition)
      .applyQuaternion(roll)
      .add(headWorldPosition);
    next.quaternion.premultiply(roll).normalize();
  }
  if (input.flightAxis !== 0) {
    next.position.addScaledVector(
      forward,
      input.flightAxis * metresPerSecond * input.elapsedSeconds,
    );
  }
  return next;
}
