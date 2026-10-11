import * as THREE from "three";
import {
  headsetScaleFactorForDenominatorChange,
} from "@found-in-space/worlds/world-scale";

export const ECLIPSE_DEFAULT_SCALE_DENOMINATOR = 8_494_678.4;

export interface EclipseStageTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Physical metres represented by one headset metre. */
  scaleDenominator: number;
}

export interface GripPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** Applies an unbounded multiplicative scale rate. */
export function eclipseScaleAfterInput(
  scaleDenominator: number,
  axis: number,
  elapsedSeconds: number,
  octavesPerSecond = 1.2,
): number {
  return scaleDenominator * 2 ** (
    -axis * octavesPerSecond * elapsedSeconds
  );
}

/**
 * Re-expresses a headset point after changing the physical-to-headset
 * conversion. Physical body sizes and separations are not involved.
 */
export function headsetPointAfterScaleDenominatorChange(
  headsetPoint: THREE.Vector3,
  physicalOriginInHeadset: THREE.Vector3,
  oldScaleDenominator: number,
  newScaleDenominator: number,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target
    .copy(headsetPoint)
    .sub(physicalOriginInHeadset)
    .multiplyScalar(headsetScaleFactorForDenominatorChange(
      oldScaleDenominator,
      newScaleDenominator,
    ))
    .add(physicalOriginInHeadset);
}

export interface EclipseCameraDepthRange {
  nearM: number;
  farM: number;
}

/**
 * Keeps clipping planes compatible with the physical-to-headset conversion.
 * The fixed far distance contains the camera-centred sky and Sun proxy; the
 * scale-relative distance contains the physical Earth–Moon scene.
 */
export function eclipseCameraDepthRange(
  scaleDenominator: number,
  observerCentreDistanceM: number,
  systemExtentPhysicalM: number,
  defaultNearM = 0.02,
  fixedFarM = 1_200,
  nearFeaturePhysicalM = 127_420.176,
): EclipseCameraDepthRange {
  return {
    nearM: Math.min(
      defaultNearM,
      nearFeaturePhysicalM / scaleDenominator,
    ),
    farM: Math.max(
      fixedFarM,
      (observerCentreDistanceM +
        systemExtentPhysicalM / scaleDenominator) * 1.05,
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
