/// <reference lib="webworker" />

import {
  AU_KM,
  EclipseEngine,
  MOON_RADIUS_KM,
  SUN_RADIUS_KM,
  magnitude,
  normalize,
  scale,
  subtract,
  type CartesianVector,
  type EclipseSummary,
  type InstantaneousShadowSurface,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";
import {
  earthFixedToEquatorialJ2000Basis,
} from "./celestial-frame.js";

interface FrameRequest {
  type: "frame";
  requestId: number;
  atUtc: string;
}

const provider = new AstronomyEngineProvider();
const engine = new EclipseEngine(astronomyEngineCapabilities(provider));
const eclipseEvent = engine
  .events({
    startUtc: "2026-08-12T00:00:00Z",
    endUtc: "2026-08-13T00:00:00Z",
  })
  .find((candidate) => candidate.id === "solar-2026-08-12-total");

if (!eclipseEvent) {
  throw new Error("The 12 August 2026 total eclipse was not found.");
}
const event: EclipseSummary = eclipseEvent;

function kilometres(
  body: "sun" | "moon",
  atUtc: string,
): CartesianVector {
  return scale(
    provider.stateVector(
      body,
      atUtc,
      "geocentric-earth-fixed",
    ).positionAu,
    AU_KM,
  );
}

function ringPoints(
  shadow: InstantaneousShadowSurface,
  region: "penumbra" | "central",
): CartesianVector[][] {
  const rings =
    region === "penumbra"
      ? shadow.penumbra.rings
      : shadow.central?.region.rings ?? [];
  return rings.map((ring) =>
    ring.points.map((point) => ({ ...point.ecefKm })),
  );
}

function frame(atUtc: string) {
  const sunEcefKm = kilometres("sun", atUtc);
  const moonEcefKm = kilometres("moon", atUtc);
  const direction = normalize(subtract(moonEcefKm, sunEcefKm));
  const sunMoonDistanceKm = magnitude(
    subtract(moonEcefKm, sunEcefKm),
  );
  const moonEarthDistanceKm = magnitude(moonEcefKm);
  const axisDistanceToEarthPlaneKm = -(
    moonEcefKm.x * direction.x +
    moonEcefKm.y * direction.y +
    moonEcefKm.z * direction.z
  );
  const umbraRadiusAtEarthPlaneKm =
    MOON_RADIUS_KM -
    (axisDistanceToEarthPlaneKm * (SUN_RADIUS_KM - MOON_RADIUS_KM)) /
      sunMoonDistanceKm;
  const penumbraRadiusAtEarthPlaneKm =
    MOON_RADIUS_KM +
    (axisDistanceToEarthPlaneKm * (SUN_RADIUS_KM + MOON_RADIUS_KM)) /
      sunMoonDistanceKm;
  const shadow = engine.calculateInstantaneousShadow(event, atUtc, {
    angularIntervalDegrees: 3,
  });

  return {
    event,
    atUtc: shadow.atUtc,
    sunEcefKm,
    moonEcefKm,
    direction,
    ecefToEquatorialJ2000: earthFixedToEquatorialJ2000Basis(
      shadow.atUtc,
    ),
    sunMoonDistanceKm,
    moonEarthDistanceKm,
    axisDistanceToEarthPlaneKm,
    umbraRadiusAtEarthPlaneKm,
    penumbraRadiusAtEarthPlaneKm,
    centralKind: shadow.central?.kind ?? null,
    penumbraRings: ringPoints(shadow, "penumbra"),
    centralRings: ringPoints(shadow, "central"),
  };
}

self.postMessage({
  type: "ready",
  event,
});

self.addEventListener("message", (message: MessageEvent<FrameRequest>) => {
  const request = message.data;
  if (request.type !== "frame") return;
  try {
    self.postMessage({
      type: "frame",
      requestId: request.requestId,
      frame: frame(request.atUtc),
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
