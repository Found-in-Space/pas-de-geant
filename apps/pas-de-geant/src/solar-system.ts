import {
  Body,
  GeoMoon,
  HelioVector,
  KM_PER_AU,
  RotationAxis,
} from "astronomy-engine";

export type SolarSystemBodyId =
  | "sun"
  | "mercury"
  | "venus"
  | "earth"
  | "moon"
  | "mars"
  | "jupiter"
  | "saturn"
  | "uranus"
  | "neptune";

export interface Vector3d {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BodyRotation {
  /** J2000 right ascension of the north pole, in degrees. */
  readonly poleRightAscensionDegrees: number;
  /** J2000 declination of the north pole, in degrees. */
  readonly poleDeclinationDegrees: number;
  /** IAU prime-meridian rotation, in degrees. */
  readonly primeMeridianDegrees: number;
}

export interface CelestialBodyDefinition {
  readonly id: SolarSystemBodyId;
  readonly name: string;
  readonly astronomyBody: Body;
  readonly referenceRadiusM: number;
  readonly shape:
    | { readonly kind: "sphere"; readonly radiusM: number }
    | {
      readonly kind: "ellipsoid";
      readonly equatorialRadiusM: number;
      readonly polarRadiusM: number;
    };
  readonly surface: "earth" | "moon" | null;
  readonly atmosphere: "earth" | null;
  readonly placeholderColor: number;
}

const DEFINITIONS: readonly CelestialBodyDefinition[] = [
  {
    id: "sun",
    name: "Sun",
    astronomyBody: Body.Sun,
    referenceRadiusM: 695_700_000,
    shape: { kind: "sphere", radiusM: 695_700_000 },
    surface: null,
    atmosphere: null,
    placeholderColor: 0xffd27a,
  },
  {
    id: "mercury",
    name: "Mercury",
    astronomyBody: Body.Mercury,
    referenceRadiusM: 2_439_700,
    shape: { kind: "sphere", radiusM: 2_439_700 },
    surface: null,
    atmosphere: null,
    placeholderColor: 0xaaa49b,
  },
  {
    id: "venus",
    name: "Venus",
    astronomyBody: Body.Venus,
    referenceRadiusM: 6_051_800,
    shape: { kind: "sphere", radiusM: 6_051_800 },
    surface: null,
    atmosphere: null,
    placeholderColor: 0xd7ad76,
  },
  {
    id: "earth",
    name: "Earth",
    astronomyBody: Body.Earth,
    referenceRadiusM: 6_371_008.8,
    shape: {
      kind: "ellipsoid",
      equatorialRadiusM: 6_378_137,
      polarRadiusM: 6_356_752.314245,
    },
    surface: "earth",
    atmosphere: "earth",
    placeholderColor: 0x4c8fd6,
  },
  {
    id: "moon",
    name: "Moon",
    astronomyBody: Body.Moon,
    referenceRadiusM: 1_737_400,
    shape: { kind: "sphere", radiusM: 1_737_400 },
    surface: "moon",
    atmosphere: null,
    placeholderColor: 0xa7a5a1,
  },
  {
    id: "mars",
    name: "Mars",
    astronomyBody: Body.Mars,
    referenceRadiusM: 3_389_500,
    shape: { kind: "sphere", radiusM: 3_389_500 },
    surface: null,
    atmosphere: null,
    placeholderColor: 0xbc6747,
  },
  {
    id: "jupiter",
    name: "Jupiter",
    astronomyBody: Body.Jupiter,
    referenceRadiusM: 69_911_000,
    shape: { kind: "sphere", radiusM: 69_911_000 },
    surface: null,
    atmosphere: null,
    placeholderColor: 0xd2ad86,
  },
  {
    id: "saturn",
    name: "Saturn",
    astronomyBody: Body.Saturn,
    referenceRadiusM: 58_232_000,
    shape: { kind: "sphere", radiusM: 58_232_000 },
    surface: null,
    atmosphere: null,
    placeholderColor: 0xdac58f,
  },
  {
    id: "uranus",
    name: "Uranus",
    astronomyBody: Body.Uranus,
    referenceRadiusM: 25_362_000,
    shape: { kind: "sphere", radiusM: 25_362_000 },
    surface: null,
    atmosphere: null,
    placeholderColor: 0x9ed8db,
  },
  {
    id: "neptune",
    name: "Neptune",
    astronomyBody: Body.Neptune,
    referenceRadiusM: 24_622_000,
    shape: { kind: "sphere", radiusM: 24_622_000 },
    surface: null,
    atmosphere: null,
    placeholderColor: 0x5279d8,
  },
] as const;

export const SOLAR_SYSTEM_BODIES: readonly CelestialBodyDefinition[] =
  Object.freeze(DEFINITIONS);

const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

export function celestialBody(
  id: SolarSystemBodyId,
): CelestialBodyDefinition {
  return BY_ID.get(id)!;
}

export function isSolarSystemBodyId(value: unknown): value is SolarSystemBodyId {
  return typeof value === "string" && BY_ID.has(value as SolarSystemBodyId);
}

function auVectorToMetres(value: Vector3d): Vector3d {
  const metresPerAu = KM_PER_AU * 1_000;
  return {
    x: value.x * metresPerAu,
    y: value.y * metresPerAu,
    z: value.z * metresPerAu,
  };
}

/** Heliocentric J2000 equatorial position in physical metres. */
export function bodyPositionJ2000M(
  id: SolarSystemBodyId,
  at: Date,
): Vector3d {
  if (!Number.isFinite(at.getTime())) throw new RangeError("Invalid ephemeris time.");
  if (id === "sun") return { x: 0, y: 0, z: 0 };
  if (id === "moon") {
    const earth = HelioVector(Body.Earth, at);
    const moonFromEarth = GeoMoon(at);
    return auVectorToMetres({
      x: earth.x + moonFromEarth.x,
      y: earth.y + moonFromEarth.y,
      z: earth.z + moonFromEarth.z,
    });
  }
  return auVectorToMetres(HelioVector(celestialBody(id).astronomyBody, at));
}

export function bodyRotation(id: SolarSystemBodyId, at: Date): BodyRotation {
  if (!Number.isFinite(at.getTime())) throw new RangeError("Invalid rotation time.");
  const axis = RotationAxis(celestialBody(id).astronomyBody, at);
  return {
    poleRightAscensionDegrees: axis.ra * 15,
    poleDeclinationDegrees: axis.dec,
    primeMeridianDegrees: axis.spin,
  };
}

export function subtractVector3d(first: Vector3d, second: Vector3d): Vector3d {
  return {
    x: first.x - second.x,
    y: first.y - second.y,
    z: first.z - second.z,
  };
}

export function addVector3d(first: Vector3d, second: Vector3d): Vector3d {
  return {
    x: first.x + second.x,
    y: first.y + second.y,
    z: first.z + second.z,
  };
}

export function scaleVector3d(value: Vector3d, scale: number): Vector3d {
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

export function vector3dLength(value: Vector3d): number {
  return Math.hypot(value.x, value.y, value.z);
}
