import {
  SPATIAL_Z_UP_TO_Y_UP, invertSpatialQuaternion, transformSpatialDisplacement,
  addSpatialVectors, scaleSpatialVector, type SpatialCoordinateSpace,
} from "@found-in-space/spatial";
import {
  celestialBody,
  type SolarSystemBodyId,
  type Vector3d,
} from "./solar-system.js";
import {
  displayRadiusMetres,
  validScaleDenominator,
} from "./world-scale.js";

/** Heliocentric origin, equatorial J2000 axes; ephemerides are evaluated by the caller. */
export const WORLD_J2000_METRES: SpatialCoordinateSpace = Object.freeze({ frameId: "worlds:heliocentric-j2000", metersPerUnit: 1 });
/** The same origin with x/z/-y axes, before presentation scale or room transforms. */
export const WORLD_Y_UP_METRES: SpatialCoordinateSpace = Object.freeze({ frameId: "worlds:heliocentric-y-up", metersPerUnit: 1 });

export type NavigationMode = "surface" | "orbit" | "free";

export interface SurfaceLocation {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly altitudeM: number;
  readonly headingDegrees: number;
}

export interface WorldNavigationState {
  readonly mode: NavigationMode;
  readonly focusBodyId: SolarSystemBodyId;
  /** The single authoritative 1:N conversion applied to all physical geometry. */
  readonly scaleDenominator: number;
  readonly surfaceLocations: Readonly<Partial<Record<SolarSystemBodyId, SurfaceLocation>>>;
  readonly observerSystemPositionM: Vector3d;
}

export function displayRadiusForScale(
  bodyId: SolarSystemBodyId,
  scaleDenominator: number,
): number {
  return displayRadiusMetres(
    celestialBody(bodyId).referenceRadiusM,
    scaleDenominator,
  );
}

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

export function withScaleDenominator(
  state: WorldNavigationState,
  scaleDenominator: number,
): WorldNavigationState {
  return {
    ...state,
    scaleDenominator: validScaleDenominator(scaleDenominator),
  };
}

export function withNavigationTarget(
  state: WorldNavigationState,
  focusBodyId: SolarSystemBodyId,
  mode: NavigationMode,
): WorldNavigationState {
  if (mode === "surface" && celestialBody(focusBodyId).surface === null) {
    throw new RangeError(`${celestialBody(focusBodyId).name} has no surface experience.`);
  }
  return { ...state, focusBodyId, mode };
}

/** Converts an authoritative relative J2000 vector to Three's Y-up axes. */
export function relativeJ2000MetresToRender(
  relativeM: Vector3d,
  scaleDenominator: number,
): Vector3d {
  const axes = transformSpatialDisplacement({
    from: WORLD_J2000_METRES, to: WORLD_Y_UP_METRES, rotation: SPATIAL_Z_UP_TO_Y_UP,
  }, relativeM);
  return scaleSpatialVector(axes, 1 / validScaleDenominator(scaleDenominator));
}

/** Inverse of the render-axis mapping, used to move a rebased observer. */
export function translatedObserverJ2000M(
  observerM: Vector3d,
  renderTravelM: Vector3d,
  scaleDenominator: number,
): Vector3d {
  const offset = transformSpatialDisplacement({
    from: WORLD_Y_UP_METRES, to: WORLD_J2000_METRES, rotation: invertSpatialQuaternion(SPATIAL_Z_UP_TO_Y_UP),
  }, scaleSpatialVector(renderTravelM, validScaleDenominator(scaleDenominator)));
  return addSpatialVectors(observerM, offset);
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
