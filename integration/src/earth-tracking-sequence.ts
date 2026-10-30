import { evaluateSpatialOrbit } from "@found-in-space/spatial";
import { createGeantTrackingSequence, geantBodyFixedSpace } from "@found-in-space/pas-de-geant/journey";

// An authored moving marker in Earth-fixed coordinates, not a predicted satellite orbit.
const path = { space: geantBodyFixedSpace("earth"), center: { x: 0, y: 0, z: 0 }, radius: 7_000_000,
  orbitNormal: { x: 0, y: 1, z: 0 }, referenceAxis: { x: 1, y: 0, z: 0 }, angularSpeedRadPerSec: Math.PI / 90 };
export const earthTrackingSequence = createGeantTrackingSequence({
  sequence: { durationSecs: 30, evaluate(timeSecs) {
    const sample = evaluateSpatialOrbit(path, timeSecs);
    return { body: "earth" as const, space: sample.space, position: sample.position, velocityMPerSec: sample.velocityUnitsPerSec };
  } },
  shot: { up: "radial", heading: { kind: "velocity", referenceForward: { x: 0, y: 0, z: -1 }, blendSpeedMPerSec: 1000 },
    offset: { rightM: 1_000_000, upM: 1_500_000, behindM: 3_500_000 }, lookAheadSecs: 1, scaleDenominator: 2_000_000 },
  worldTime: () => Date.parse("2026-10-30T12:00:00Z"),
});
