import {
  celestialBody,
  type SolarSystemBodyId,
  type Vector3d,
} from "./solar-system.js";

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
  /** The single authoritative conversion applied to all physical geometry. */
  readonly roomMetresPerPhysicalMetre: number;
  readonly surfaceLocations: Readonly<Partial<Record<SolarSystemBodyId, SurfaceLocation>>>;
  readonly observerSystemPositionM: Vector3d;
}

export function roomScaleForDisplayRadius(
  bodyId: SolarSystemBodyId,
  displayRadiusM: number,
): number {
  if (!Number.isFinite(displayRadiusM) || displayRadiusM <= 0) {
    throw new RangeError("Display radius must be positive and finite.");
  }
  return displayRadiusM / celestialBody(bodyId).referenceRadiusM;
}

export function displayRadiusForRoomScale(
  bodyId: SolarSystemBodyId,
  roomMetresPerPhysicalMetre: number,
): number {
  if (
    !Number.isFinite(roomMetresPerPhysicalMetre) ||
    roomMetresPerPhysicalMetre <= 0
  ) {
    throw new RangeError("Room scale must be positive and finite.");
  }
  return celestialBody(bodyId).referenceRadiusM * roomMetresPerPhysicalMetre;
}

export function initialWorldNavigationState(
  latitudeDegrees: number,
  longitudeDegrees: number,
  earthDisplayRadiusM: number,
  earthSystemPositionM: Vector3d = { x: 0, y: 0, z: 0 },
): WorldNavigationState {
  return {
    mode: "surface",
    focusBodyId: "earth",
    roomMetresPerPhysicalMetre: roomScaleForDisplayRadius(
      "earth",
      earthDisplayRadiusM,
    ),
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

export function withDisplayRadius(
  state: WorldNavigationState,
  displayRadiusM: number,
): WorldNavigationState {
  return {
    ...state,
    roomMetresPerPhysicalMetre: roomScaleForDisplayRadius(
      state.focusBodyId,
      displayRadiusM,
    ),
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
  roomMetresPerPhysicalMetre: number,
): Vector3d {
  return {
    x: relativeM.x * roomMetresPerPhysicalMetre,
    y: relativeM.z * roomMetresPerPhysicalMetre,
    z: -relativeM.y * roomMetresPerPhysicalMetre,
  };
}

/** Inverse of the render-axis mapping, used to move a rebased observer. */
export function translatedObserverJ2000M(
  observerM: Vector3d,
  renderTravelM: Vector3d,
  roomMetresPerPhysicalMetre: number,
): Vector3d {
  if (
    !Number.isFinite(roomMetresPerPhysicalMetre) ||
    roomMetresPerPhysicalMetre <= 0
  ) throw new RangeError("Room scale must be positive and finite.");
  return {
    x: observerM.x + renderTravelM.x / roomMetresPerPhysicalMetre,
    y: observerM.y - renderTravelM.z / roomMetresPerPhysicalMetre,
    z: observerM.z + renderTravelM.y / roomMetresPerPhysicalMetre,
  };
}

/** Space travel stays useful at toy, room, and interplanetary display scales. */
export function spaceTravelSpeedRoomMPerSecond(
  mode: Exclude<NavigationMode, "surface">,
  displayRadiusM: number,
  focusDistanceRoomM: number,
  boosted: boolean,
): number {
  if (!Number.isFinite(displayRadiusM) || displayRadiusM <= 0) {
    throw new RangeError("Display radius must be positive and finite.");
  }
  const focusRelativeSpeed = mode === "free"
    ? Math.max(displayRadiusM * 0.5, Math.max(0, focusDistanceRoomM) * 0.15)
    : displayRadiusM * 0.5;
  return Math.max(1.35, focusRelativeSpeed) * (boosted ? 4 : 1);
}
