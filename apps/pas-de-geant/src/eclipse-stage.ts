import * as THREE from "three";

export interface EclipseStageTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  metresPerEarthRadius: number;
}

export interface GripPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** Applies an unbounded multiplicative scale rate. */
export function eclipseScaleAfterInput(
  metresPerEarthRadius: number,
  axis: number,
  elapsedSeconds: number,
  octavesPerSecond = 1.2,
): number {
  return metresPerEarthRadius * 2 ** (
    axis * octavesPerSecond * elapsedSeconds
  );
}

/** Applies the same unbounded multiplicative rate to an Earth-centred distance. */
export function eclipseRadialDistanceAfterInput(
  distanceM: number,
  axis: number,
  elapsedSeconds: number,
  octavesPerSecond = 1.2,
): number {
  return distanceM * 2 ** (
    axis * octavesPerSecond * elapsedSeconds
  );
}
