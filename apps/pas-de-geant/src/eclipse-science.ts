import {
  DeltaT_EspenakMeeus,
  SetDeltaTFunction,
} from "astronomy-engine";
import {
  AU_KM,
  EclipseEngine,
  coneRadialSlope,
  coneRadiusKm,
  magnitude,
  normalize,
  scale,
  subtract,
  type CartesianVector,
  type EclipseSummary,
  type InstantaneousShadowSurface,
  type ShadowGeometryState,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";
import { earthFixedToEquatorialJ2000Basis } from "./eclipse-frame.js";
import type { EclipseContactRange, EclipseFrame } from "./eclipse-types.js";

const TRACKER_2026_DELTA_T_SECONDS = 69.1734;
const provider = new AstronomyEngineProvider();
const engine = new EclipseEngine(astronomyEngineCapabilities(provider));

function configureDeltaT(eventId?: string): void {
  SetDeltaTFunction(
    eventId === "solar-2026-08-12-total"
      ? () => TRACKER_2026_DELTA_T_SECONDS
      : DeltaT_EspenakMeeus,
  );
}

function kilometres(
  body: "sun" | "moon",
  atUtc: string,
): CartesianVector {
  return scale(
    provider.stateVector(body, atUtc, "geocentric-earth-fixed").positionAu,
    AU_KM,
  );
}

function ringPoints(
  shadow: InstantaneousShadowSurface,
  region: "penumbra" | "central",
): CartesianVector[][] {
  const rings = region === "penumbra"
    ? shadow.penumbra.rings
    : shadow.central?.region.rings ?? [];
  return rings.map((ring) =>
    ring.points.map((point) => ({ ...point.ecefKm }))
  );
}

export function calculateEclipseEvents(
  startUtc: string,
  endUtc: string,
): EclipseSummary[] {
  configureDeltaT();
  return engine.events({ startUtc, endUtc });
}

export function calculateEclipseContactRange(
  event: EclipseSummary,
): EclipseContactRange {
  configureDeltaT(event.id);
  const contacts = engine.calculateGlobalContacts(event);
  const first = contacts[0];
  const last = contacts.at(-1);
  if (!first || !last || first.utc === last.utc) {
    throw new Error(`Global contacts were not found for ${event.id}.`);
  }
  return { startUtc: first.utc, endUtc: last.utc };
}

export function calculateEclipseFrame(
  event: EclipseSummary,
  atUtc: string,
  angularIntervalDegrees = 3,
): EclipseFrame {
  configureDeltaT(event.id);
  const sunEcefKm = kilometres("sun", atUtc);
  const moonEcefKm = kilometres("moon", atUtc);
  const direction = normalize(subtract(moonEcefKm, sunEcefKm));
  const sunEarthDistanceKm = magnitude(sunEcefKm);
  const sunMoonDistanceKm = magnitude(subtract(moonEcefKm, sunEcefKm));
  const moonEarthDistanceKm = magnitude(moonEcefKm);
  const axisDistanceToEarthPlaneKm = -(
    moonEcefKm.x * direction.x +
    moonEcefKm.y * direction.y +
    moonEcefKm.z * direction.z
  );
  const geometryState: ShadowGeometryState = {
    atUtc,
    sunEcefKm,
    moonEcefKm,
    direction,
    sunDistanceKm: sunEarthDistanceKm,
    sunMoonDistanceKm,
  };
  const centralConeSlope = coneRadialSlope(geometryState, "central");
  const penumbraConeSlope = coneRadialSlope(geometryState, "penumbra");
  const umbraRadiusAtEarthPlaneKm = coneRadiusKm(
    geometryState,
    "central",
    axisDistanceToEarthPlaneKm,
  );
  const penumbraRadiusAtEarthPlaneKm = coneRadiusKm(
    geometryState,
    "penumbra",
    axisDistanceToEarthPlaneKm,
  );
  let shadow: InstantaneousShadowSurface | null = null;
  try {
    shadow = engine.calculateInstantaneousShadow(event, atUtc, {
      angularIntervalDegrees,
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.startsWith(
        "The penumbra does not intersect visible Earth at ",
      )
    ) {
      throw error;
    }
  }
  const resolvedAtUtc = shadow?.atUtc ?? new Date(atUtc).toISOString();
  return {
    event,
    atUtc: resolvedAtUtc,
    sunEcefKm,
    moonEcefKm,
    direction,
    ecefToEquatorialJ2000:
      earthFixedToEquatorialJ2000Basis(resolvedAtUtc),
    sunEarthDistanceKm,
    sunMoonDistanceKm,
    moonEarthDistanceKm,
    axisDistanceToEarthPlaneKm,
    centralConeSlope,
    penumbraConeSlope,
    umbraRadiusAtEarthPlaneKm,
    penumbraRadiusAtEarthPlaneKm,
    centralKind: shadow?.central?.kind ?? null,
    penumbraRings: shadow ? ringPoints(shadow, "penumbra") : [],
    centralRings: shadow ? ringPoints(shadow, "central") : [],
  };
}
