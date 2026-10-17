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

/** A host-owned label for input conditions. It does not select a model. */
export type NavigationMode = string;

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
