import * as THREE from "three";

export interface EclipseStageTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Headset metres per simulation unit; one simulation unit is 1 R⊕. */
  metresPerEarthRadius: number;
}

export interface GripPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** Applies an unbounded multiplicative scale rate. */
export function eclipseScaleAfterInput(
  headsetMetresPerSimulationUnit: number,
  axis: number,
  elapsedSeconds: number,
  octavesPerSecond = 1.2,
): number {
  return headsetMetresPerSimulationUnit * 2 ** (
    axis * octavesPerSecond * elapsedSeconds
  );
}

/**
 * Re-expresses a headset point after changing the simulation-to-headset
 * conversion. Simulation-space body sizes and separations are not involved.
 */
export function headsetPointAfterSimulationScaleChange(
  headsetPoint: THREE.Vector3,
  simulationOriginInHeadset: THREE.Vector3,
  oldHeadsetMetresPerSimulationUnit: number,
  newHeadsetMetresPerSimulationUnit: number,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target
    .copy(headsetPoint)
    .sub(simulationOriginInHeadset)
    .multiplyScalar(
      newHeadsetMetresPerSimulationUnit /
        oldHeadsetMetresPerSimulationUnit,
    )
    .add(simulationOriginInHeadset);
}

export interface EclipseCameraDepthRange {
  nearM: number;
  farM: number;
}

/**
 * Keeps clipping planes compatible with the simulation-to-headset conversion.
 * The fixed far distance contains the camera-centred sky and Sun proxy; the
 * scale-relative distance contains the physical Earth–Moon scene.
 */
export function eclipseCameraDepthRange(
  headsetMetresPerSimulationUnit: number,
  observerCentreDistanceM: number,
  systemExtentSimulationUnits: number,
  defaultNearM = 0.02,
  fixedFarM = 1_200,
): EclipseCameraDepthRange {
  return {
    nearM: Math.min(
      defaultNearM,
      headsetMetresPerSimulationUnit * 0.02,
    ),
    farM: Math.max(
      fixedFarM,
      (observerCentreDistanceM +
        systemExtentSimulationUnits * headsetMetresPerSimulationUnit) * 1.05,
    ),
  };
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
