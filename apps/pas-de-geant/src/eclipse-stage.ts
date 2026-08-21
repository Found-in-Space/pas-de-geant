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

const PRESET_SCALE: Record<EclipseViewPreset, number> = {
  system: 0.09,
  earth: 0.75,
  moon: 2.4,
  shadow: 0.2,
};

const PRESET_VIEW_DISTANCE: Record<EclipseViewPreset, number> = {
  system: 5.8,
  earth: 3,
  moon: 3,
  shadow: 3.5,
};

export function presetMetresPerEarthRadius(
  preset: EclipseViewPreset,
): number {
  return PRESET_SCALE[preset];
}

export function presetViewDistance(preset: EclipseViewPreset): number {
  return PRESET_VIEW_DISTANCE[preset];
}

export function presetFocus(
  preset: EclipseViewPreset,
  frame: EclipseStageFrame,
): THREE.Vector3 {
  if (preset === "earth") return new THREE.Vector3();
  if (preset === "moon") return frame.moonPosition.clone();
  if (preset === "shadow") return frame.moonPosition.clone().multiplyScalar(0.58);
  return frame.moonPosition.clone().multiplyScalar(0.5);
}
