import { celestialBody, type Vector3d } from "../worlds/solar-system.js";
import { validScaleDenominator } from "../worlds/world-scale.js";
import type { WorldNavigationState, NavigationMode } from "../worlds/world-navigation.js";



export function initialWorldNavigationState(
  latitudeDegrees: number,
  longitudeDegrees: number,
  scaleDenominator: number,
  earthSystemPositionM: Vector3d = { x: 0, y: 0, z: 0 },
): WorldNavigationState {
  return {
    mode: "surface",
    focusBodyId: "earth",
    scaleDenominator: validScaleDenominator(scaleDenominator),
    surfaceLocations: {
      earth: {
        latitudeDegrees,
        longitudeDegrees,
        altitudeM: 0,
        headingDegrees: 0,
      },
      moon: {
        latitudeDegrees: 0,
        longitudeDegrees: 0,
        altitudeM: 0,
        headingDegrees: 0,
      },
    },
    observerSystemPositionM: { ...earthSystemPositionM },
  };
}


/** Space travel stays useful at toy, room, and interplanetary display scales. */
export function spaceTravelSpeedHeadsetMPerSecond(
  mode: Exclude<NavigationMode, "surface">,
  displayRadiusM: number,
  focusDistanceHeadsetM: number,
  boosted: boolean,
): number {
  if (!Number.isFinite(displayRadiusM) || displayRadiusM <= 0) {
    throw new RangeError("Display radius must be positive and finite.");
  }
  const focusRelativeSpeed = mode === "free"
    ? Math.max(displayRadiusM * 0.5, Math.max(0, focusDistanceHeadsetM) * 0.15)
    : displayRadiusM * 0.5;
  return Math.max(1.35, focusRelativeSpeed) * (boosted ? 4 : 1);
}


/** Gives orbital controls fine precision near centre without limiting full input. */
export function shapedOrbitalAxis(axis: number): number {
  const finiteAxis = Number.isFinite(axis) ? Math.max(-1, Math.min(1, axis)) : 0;
  return finiteAxis * finiteAxis * finiteAxis;
}


/** Calm target-centred angular travel, expressed as radians for one frame. */
export function orbitalAngularStepRadians(
  axis: number,
  deltaSeconds: number,
  boosted: boolean,
  degreesPerSecond = 20,
): number {
  return shapedOrbitalAxis(axis) * degreesPerSecond * Math.PI / 180 *
    Math.max(0, deltaSeconds) * (boosted ? 2 : 1);
}


/**
 * Maps one pointer pixel to a target-centred orbit angle. Near the surface the
 * same screen drag covers a smaller physical arc; far away it retains the
 * established maximum angular response.
 */
export function orbitalDragRadiansPerPixel(
  focusDistanceM: number,
  displayRadiusM: number,
  focalLengthPixels: number,
  maximumRadiansPerPixel: number,
): number {
  for (const [name, value] of [
    ["Focus distance", focusDistanceM],
    ["Display radius", displayRadiusM],
    ["Focal length", focalLengthPixels],
    ["Maximum drag rate", maximumRadiansPerPixel],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be positive and finite.`);
    }
  }
  const observerHeightM = Math.max(0, focusDistanceM - displayRadiusM);
  return Math.min(
    maximumRadiansPerPixel,
    observerHeightM / (displayRadiusM * focalLengthPixels),
  );
}


/** Unbounded proportional altitude/scale response: full input doubles in 4 s. */
export function orbitalLogarithmicValue(
  value: number,
  axis: number,
  deltaSeconds: number,
  boosted: boolean,
  octavesPerSecond = 0.25,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Orbital value must be positive and finite.");
  }
  return value * 2 ** (
    shapedOrbitalAxis(axis) * octavesPerSecond * Math.max(0, deltaSeconds) *
    (boosted ? 2 : 1)
  );
}
export const DEFAULT_SCALE_DENOMINATOR = 60_000;


/** Larger positive input enlarges the model, so it reduces the denominator. */
export function scaleDenominatorAfterInput(
  scaleDenominator: number,
  axis: number,
  deltaSeconds: number,
  octavesPerSecond = 0.72,
  detent = DEFAULT_SCALE_DENOMINATOR,
): number {
  const next = validScaleDenominator(scaleDenominator) *
    2 ** (-axis * octavesPerSecond * deltaSeconds);
  const detentDistance = Math.abs(Math.log2(next / detent));
  if (Math.abs(axis) < 0.12 && detentDistance < 0.035) return detent;
  return next;
}


const SCALE_NUMBER_FORMAT = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 0,
});


/** Displays scale in decade-sensitive steps, with a minimum step of one. */
export function scaleDenominatorForDisplay(scaleDenominator: number): number {
  const denominator = validScaleDenominator(scaleDenominator);
  return denominator < 100
    ? Math.round(denominator)
    : Number(denominator.toPrecision(2));
}


export function formatScaleRatio(scaleDenominator: number): string {
  return `1 : ${SCALE_NUMBER_FORMAT.format(
    scaleDenominatorForDisplay(scaleDenominator),
  )}`;
}


export function applyTerrainMultiplierRate(
  multiplier: number,
  axis: number,
  deltaSeconds: number,
  unitsPerSecond = 3,
): number {
  const next = multiplier + axis * unitsPerSecond * deltaSeconds;
  if (Math.abs(axis) < 0.12 && Math.abs(next - 1) < 0.08) return 1;
  return Math.max(0, next);
}
