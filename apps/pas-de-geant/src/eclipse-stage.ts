import * as THREE from "three";
import type { EclipseViewPreset } from "./eclipse-types.js";

export interface EclipseStageTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  metresPerEarthRadius: number;
}

export interface EclipseStageFrame {
  moonPosition: THREE.Vector3;
  shadowAxis: THREE.Vector3;
}

export interface GripPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export interface OneGripGesture {
  controllerStart: THREE.Matrix4;
  stageStart: THREE.Matrix4;
}

export interface TwoGripGesture {
  midpointStart: THREE.Vector3;
  directionStart: THREE.Vector3;
  distanceStart: number;
  stageStart: EclipseStageTransform;
}

const PRESET_SCALE: Record<EclipseViewPreset, number> = {
  system: 0.09,
  earth: 0.75,
  moon: 2.4,
  shadow: 0.2,
};

const PRESET_ANCHOR: Record<EclipseViewPreset, THREE.Vector3> = {
  system: new THREE.Vector3(0, 1.35, -5.8),
  earth: new THREE.Vector3(0, 1.35, -3),
  moon: new THREE.Vector3(0, 1.35, -3),
  shadow: new THREE.Vector3(0, 1.35, -3.5),
};

export function presetFocus(
  preset: EclipseViewPreset,
  frame: EclipseStageFrame,
): THREE.Vector3 {
  if (preset === "earth") return new THREE.Vector3();
  if (preset === "moon") return frame.moonPosition.clone();
  if (preset === "shadow") return frame.moonPosition.clone().multiplyScalar(0.58);
  return frame.moonPosition.clone().multiplyScalar(0.5);
}

export function presetStageTransform(
  preset: EclipseViewPreset,
  frame: EclipseStageFrame,
): EclipseStageTransform {
  const scale = PRESET_SCALE[preset];
  const focus = presetFocus(preset, frame);
  return {
    position: PRESET_ANCHOR[preset].clone().addScaledVector(focus, -scale),
    quaternion: new THREE.Quaternion(),
    metresPerEarthRadius: scale,
  };
}

export function applyStageTransform(
  root: THREE.Object3D,
  transform: EclipseStageTransform,
): void {
  root.position.copy(transform.position);
  root.quaternion.copy(transform.quaternion);
  root.scale.setScalar(transform.metresPerEarthRadius);
  root.updateMatrix();
  root.updateMatrixWorld(true);
}

export function stageTransform(root: THREE.Object3D): EclipseStageTransform {
  return {
    position: root.position.clone(),
    quaternion: root.quaternion.clone(),
    metresPerEarthRadius: root.scale.x,
  };
}

export function beginOneGrip(
  grip: GripPose,
  stage: EclipseStageTransform,
): OneGripGesture {
  return {
    controllerStart: new THREE.Matrix4().compose(
      grip.position,
      grip.quaternion,
      new THREE.Vector3(1, 1, 1),
    ),
    stageStart: new THREE.Matrix4().compose(
      stage.position,
      stage.quaternion,
      new THREE.Vector3().setScalar(stage.metresPerEarthRadius),
    ),
  };
}

export function updateOneGrip(
  gesture: OneGripGesture,
  grip: GripPose,
): EclipseStageTransform {
  const controller = new THREE.Matrix4().compose(
    grip.position,
    grip.quaternion,
    new THREE.Vector3(1, 1, 1),
  );
  const matrix = controller
    .multiply(gesture.controllerStart.clone().invert())
    .multiply(gesture.stageStart);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return {
    position,
    quaternion: quaternion.normalize(),
    metresPerEarthRadius: scale.x,
  };
}

export function beginTwoGrip(
  first: GripPose,
  second: GripPose,
  stage: EclipseStageTransform,
): TwoGripGesture | null {
  const direction = second.position.clone().sub(first.position);
  const distance = direction.length();
  if (distance <= Number.EPSILON) return null;
  return {
    midpointStart: first.position.clone().add(second.position).multiplyScalar(0.5),
    directionStart: direction.divideScalar(distance),
    distanceStart: distance,
    stageStart: {
      position: stage.position.clone(),
      quaternion: stage.quaternion.clone(),
      metresPerEarthRadius: stage.metresPerEarthRadius,
    },
  };
}

export function updateTwoGrip(
  gesture: TwoGripGesture,
  first: GripPose,
  second: GripPose,
): EclipseStageTransform {
  const direction = second.position.clone().sub(first.position);
  const distance = direction.length();
  if (distance <= Number.EPSILON) return gesture.stageStart;
  direction.divideScalar(distance);
  const ratio = distance / gesture.distanceStart;
  const rotation = new THREE.Quaternion().setFromUnitVectors(
    gesture.directionStart,
    direction,
  );
  const midpoint = first.position.clone().add(second.position).multiplyScalar(0.5);
  const position = gesture.stageStart.position
    .clone()
    .sub(gesture.midpointStart)
    .multiplyScalar(ratio)
    .applyQuaternion(rotation)
    .add(midpoint);
  return {
    position,
    quaternion: rotation.clone().multiply(gesture.stageStart.quaternion).normalize(),
    metresPerEarthRadius:
      gesture.stageStart.metresPerEarthRadius * ratio,
  };
}
