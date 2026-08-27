import { greatCircleDistanceKm } from "./location-pin.js";
import { EARTH_MEAN_RADIUS_KM } from "./planet-state.js";

export const UI_LONG_TRANSITION_THRESHOLD_M = 5;
export const UI_SHORT_TRANSITION_SECONDS = 1;
export const UI_LONG_TRANSITION_SECONDS = 2.5;
export const UI_SCALE_TRANSITION_SECONDS = 2.5;

interface Coordinates {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

interface NavigationState extends Coordinates {
  readonly displayRadiusM: number;
}

export function uiTransitionTimeForHeadsetDistance(
  distanceM: number,
): number {
  return distanceM > UI_LONG_TRANSITION_THRESHOLD_M
    ? UI_LONG_TRANSITION_SECONDS
    : UI_SHORT_TRANSITION_SECONDS;
}

export function uiWarpTransitionTime(
  current: NavigationState,
  target: Coordinates,
): number {
  const worldDistanceKm = greatCircleDistanceKm(
    current.latitudeDegrees,
    current.longitudeDegrees,
    target.latitudeDegrees,
    target.longitudeDegrees,
  );
  const headsetDistanceM =
    worldDistanceKm / EARTH_MEAN_RADIUS_KM * current.displayRadiusM;
  return uiTransitionTimeForHeadsetDistance(headsetDistanceM);
}
