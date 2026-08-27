import {
  coneRadialSlope,
  coneRadiusKm,
  type CartesianVector,
  type ShadowGeometryState,
} from "@found-in-space/shadowline";
import {
  bodyPositionJ2000M,
  celestialBody,
  subtractVector3d,
  vector3dLength,
  type Vector3d,
} from "./solar-system.js";

const METRES_PER_KILOMETRE = 1_000;

export interface SolarShadowGeometry {
  readonly atUtc: string;
  readonly sunFromEarthJ2000M: Vector3d;
  readonly moonFromEarthJ2000M: Vector3d;
  /** Direction travelled by sunlight after it reaches the Moon. */
  readonly shadowDirectionJ2000: Vector3d;
  readonly sunEarthDistanceM: number;
  readonly sunMoonDistanceM: number;
  readonly moonEarthDistanceM: number;
  /** Signed distance from the Moon to the plane through Earth's centre. */
  readonly axisDistanceToEarthPlaneM: number;
  /** Closest distance between Earth's centre and the infinite shadow axis. */
  readonly axisMissDistanceM: number;
  readonly centralConeSlope: number;
  readonly penumbraConeSlope: number;
  /** Signed: negative beyond the umbral apex, where it is an antumbra. */
  readonly centralConeRadiusAtEarthPlaneM: number;
  readonly penumbraConeRadiusAtEarthPlaneM: number;
}

function scaleVector(value: Vector3d, scale: number): CartesianVector {
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

function dot(first: Vector3d, second: Vector3d): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

/**
 * Builds the physical Sun–Moon shadow geometry from one ephemeris instant.
 *
 * Shadowline's cone equations are rotationally invariant, so the J2000
 * vectors can be supplied directly even though its structural field names
 * describe the Earth-fixed frame used by the observatory surface solver.
 */
export function calculateSolarShadowGeometry(
  at: Date,
): SolarShadowGeometry {
  if (!Number.isFinite(at.getTime())) {
    throw new RangeError(`Invalid solar-shadow time: ${at}`);
  }
  const earthJ2000M = bodyPositionJ2000M("earth", at);
  const sunFromEarthJ2000M = subtractVector3d(
    bodyPositionJ2000M("sun", at),
    earthJ2000M,
  );
  const moonFromEarthJ2000M = subtractVector3d(
    bodyPositionJ2000M("moon", at),
    earthJ2000M,
  );
  const sunToMoonJ2000M = subtractVector3d(
    moonFromEarthJ2000M,
    sunFromEarthJ2000M,
  );
  const sunMoonDistanceM = vector3dLength(sunToMoonJ2000M);
  const shadowDirectionJ2000 = {
    x: sunToMoonJ2000M.x / sunMoonDistanceM,
    y: sunToMoonJ2000M.y / sunMoonDistanceM,
    z: sunToMoonJ2000M.z / sunMoonDistanceM,
  };
  const sunEarthDistanceM = vector3dLength(sunFromEarthJ2000M);
  const moonEarthDistanceM = vector3dLength(moonFromEarthJ2000M);
  const axisDistanceToEarthPlaneM = -dot(
    moonFromEarthJ2000M,
    shadowDirectionJ2000,
  );
  const closestAxisPointM = {
    x:
      moonFromEarthJ2000M.x +
      shadowDirectionJ2000.x * axisDistanceToEarthPlaneM,
    y:
      moonFromEarthJ2000M.y +
      shadowDirectionJ2000.y * axisDistanceToEarthPlaneM,
    z:
      moonFromEarthJ2000M.z +
      shadowDirectionJ2000.z * axisDistanceToEarthPlaneM,
  };
  const geometryState: ShadowGeometryState = {
    atUtc: at.toISOString(),
    sunEcefKm: scaleVector(
      sunFromEarthJ2000M,
      1 / METRES_PER_KILOMETRE,
    ),
    moonEcefKm: scaleVector(
      moonFromEarthJ2000M,
      1 / METRES_PER_KILOMETRE,
    ),
    direction: shadowDirectionJ2000,
    sunDistanceKm: sunEarthDistanceM / METRES_PER_KILOMETRE,
    sunMoonDistanceKm: sunMoonDistanceM / METRES_PER_KILOMETRE,
  };
  const centralConeSlope = coneRadialSlope(geometryState, "central");
  const penumbraConeSlope = coneRadialSlope(geometryState, "penumbra");
  return {
    atUtc: geometryState.atUtc,
    sunFromEarthJ2000M,
    moonFromEarthJ2000M,
    shadowDirectionJ2000,
    sunEarthDistanceM,
    sunMoonDistanceM,
    moonEarthDistanceM,
    axisDistanceToEarthPlaneM,
    axisMissDistanceM: vector3dLength(closestAxisPointM),
    centralConeSlope,
    penumbraConeSlope,
    centralConeRadiusAtEarthPlaneM:
      coneRadiusKm(
        geometryState,
        "central",
        axisDistanceToEarthPlaneM / METRES_PER_KILOMETRE,
      ) * METRES_PER_KILOMETRE,
    penumbraConeRadiusAtEarthPlaneM:
      coneRadiusKm(
        geometryState,
        "penumbra",
        axisDistanceToEarthPlaneM / METRES_PER_KILOMETRE,
      ) * METRES_PER_KILOMETRE,
  };
}

export function solarShadowConeLengthM(
  geometry: SolarShadowGeometry,
): number {
  return geometry.moonEarthDistanceM +
    celestialBody("earth").referenceRadiusM * 4;
}
