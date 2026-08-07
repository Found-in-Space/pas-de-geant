export const CELESTIAL_PLANET_VISIBILITY_TARGETS = [
  "mercury",
  "venus",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
] as const;

export type CelestialPlanetVisibilityTarget =
  (typeof CELESTIAL_PLANET_VISIBILITY_TARGETS)[number];

export const CELESTIAL_VISIBILITY_TARGETS = [
  "sun",
  "moon",
  ...CELESTIAL_PLANET_VISIBILITY_TARGETS,
  "sun_and_moon",
  "planets",
  "all",
] as const;

export type CelestialVisibilityTarget =
  (typeof CELESTIAL_VISIBILITY_TARGETS)[number];

export interface CelestialVisibilityState {
  readonly sun_enabled: boolean;
  readonly moon_enabled: boolean;
  readonly planets: Record<CelestialPlanetVisibilityTarget, boolean>;
  readonly all_planets_enabled: boolean;
  readonly all_enabled: boolean;
}

export function isCelestialPlanetVisibilityTarget(
  value: unknown,
): value is CelestialPlanetVisibilityTarget {
  return CELESTIAL_PLANET_VISIBILITY_TARGETS.includes(
    value as CelestialPlanetVisibilityTarget,
  );
}

export function parseCelestialVisibilityArguments(value: unknown): {
  target: CelestialVisibilityTarget;
  enabled: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Celestial visibility arguments must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (!CELESTIAL_VISIBILITY_TARGETS.includes(
    candidate.target as CelestialVisibilityTarget,
  )) {
    throw new Error("Unknown celestial visibility target.");
  }
  if (typeof candidate.enabled !== "boolean") {
    throw new Error("Celestial visibility enabled must be a boolean.");
  }
  return {
    target: candidate.target as CelestialVisibilityTarget,
    enabled: candidate.enabled,
  };
}
