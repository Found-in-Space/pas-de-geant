import { beforeAll, describe, expect, it } from "vitest";
import {
  EclipseEngine,
  chordDistanceKm,
  toIsoUtc,
  type CartesianVector,
  type EarthFixedEphemeris,
  type EclipseSummary,
  type StateVector,
  type SurfacePoint,
} from "@found-in-space/shadowline";
import { intersectConeGenerator } from "../packages/shadowline/src/ecef-geometry.js";
import {
  shadowSurfaceState,
  visibleShadowEnvelopePoints,
} from "../packages/shadowline/src/shadow-math.js";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";

const provider = new AstronomyEngineProvider();
let event: EclipseSummary;

function rotateZ(
  vector: CartesianVector,
  angleRad: number,
): CartesianVector {
  const cosine = Math.cos(angleRad);
  const sine = Math.sin(angleRad);
  return {
    x: cosine * vector.x - sine * vector.y,
    y: sine * vector.x + cosine * vector.y,
    z: vector.z,
  };
}

class RotatedProvider implements EarthFixedEphemeris {
  readonly metadata = provider.metadata;

  constructor(private readonly angleRad: number) {}

  stateVector(
    body: "sun" | "moon",
    atUtc: string,
    frame: "geocentric-earth-fixed",
  ): StateVector {
    const state = provider.stateVector(body, atUtc, frame);
    return {
      ...state,
      positionAu: rotateZ(state.positionAu, this.angleRad),
      ...(state.velocityAuPerDay
        ? {
            velocityAuPerDay: rotateZ(
              state.velocityAuPerDay,
              this.angleRad,
            ),
          }
        : {}),
    };
  }
}

function nearestDistance(
  point: SurfacePoint,
  candidates: SurfacePoint[],
): number {
  return Math.min(
    ...candidates.map((candidate) =>
      chordDistanceKm(point.ecefKm, candidate.ecefKm),
    ),
  );
}

beforeAll(() => {
  event = provider.searchGlobalEclipses({
    startUtc: "2026-08-01T00:00:00Z",
    endUtc: "2026-09-01T00:00:00Z",
  })[0]!;
});

describe("coordinate-free geometry invariants", () => {
  it("rotates the complete central ECEF surface equivariantly", () => {
    const angleRad = 0.731;
    const original = new EclipseEngine(
      astronomyEngineCapabilities(provider),
    ).calculateCentralPath(event, { sampleIntervalSeconds: 60 });
    const rotatedProvider = new RotatedProvider(angleRad);
    const rotated = new EclipseEngine({
      ephemeris: rotatedProvider,
    }).calculateCentralPath(event, { sampleIntervalSeconds: 60 });
    for (const [originalCurve, rotatedCurve] of [
      [original.centerline, rotated.centerline],
      [
        original.limits.positiveCrossTrack,
        rotated.limits.positiveCrossTrack,
      ],
      [
        original.limits.negativeCrossTrack,
        rotated.limits.negativeCrossTrack,
      ],
      [original.boundary, rotated.boundary],
    ] as const) {
      expect(rotatedCurve.points.length).toBe(originalCurve.points.length);
      expect(
        Math.max(
          ...originalCurve.points.map((point, index) =>
            chordDistanceKm(
              rotateZ(point.ecefKm, angleRad),
              rotatedCurve.points[index]!.ecefKm,
            ),
          ),
        ),
      ).toBeLessThan(1e-5);
    }
  });

  it("rotates instantaneous physical regions equivariantly", () => {
    const angleRad = -1.17;
    const original = new EclipseEngine(
      astronomyEngineCapabilities(provider),
    ).calculateInstantaneousShadow(event, event.peakUtc, {
      angularIntervalDegrees: 3,
    });
    const rotated = new EclipseEngine({
      ephemeris: new RotatedProvider(angleRad),
    }).calculateInstantaneousShadow(event, event.peakUtc, {
      angularIntervalDegrees: 3,
    });
    for (const [originalRegion, rotatedRegion] of [
      [original.penumbra, rotated.penumbra],
      [original.central!.region, rotated.central!.region],
    ] as const) {
      const rotatedPoints = rotatedRegion.rings.flatMap(
        (ring) => ring.points,
      );
      expect(
        Math.max(
          ...originalRegion.rings.flatMap((ring) =>
            ring.points.map((point) =>
              nearestDistance(
                {
                  ecefKm: rotateZ(point.ecefKm, angleRad),
                  geographic: point.geographic,
                },
                rotatedPoints,
              ),
            ),
          ),
        ),
      ).toBeLessThan(1e-5);
    }
  });

  it("is invariant to the arbitrary cone perpendicular basis", () => {
    const state = shadowSurfaceState(provider, event.peakUtc);
    const step = Math.PI / 18;
    const baseline = Array.from({ length: 36 }, (_unused, index) =>
      intersectConeGenerator(
        state,
        "central",
        index * step,
        0,
      )[0]!,
    );
    const rotatedBasis = Array.from(
      { length: 36 },
      (_unused, index) =>
        intersectConeGenerator(
          state,
          "central",
          index * step,
          5 * step,
        )[0]!,
    );
    expect(
      Math.max(
        ...baseline.map((point) =>
          nearestDistance(point, rotatedBasis),
        ),
      ),
    ).toBeLessThan(1e-6);
  });

  it("changes envelope azimuth parameters but not physical roots", () => {
    const timeMs = Date.parse(event.peakUtc);
    const previous = shadowSurfaceState(
      provider,
      toIsoUtc(timeMs - 1_000),
    );
    const state = shadowSurfaceState(provider, event.peakUtc);
    const next = shadowSurfaceState(
      provider,
      toIsoUtc(timeMs + 1_000),
    );
    const baseline = visibleShadowEnvelopePoints(
      previous,
      state,
      next,
      "central",
      2,
      true,
      false,
      0,
    );
    const rotated = visibleShadowEnvelopePoints(
      previous,
      state,
      next,
      "central",
      2,
      true,
      false,
      0.37,
    );
    expect(baseline).toHaveLength(2);
    expect(rotated).toHaveLength(2);
    expect(
      Math.max(
        ...baseline.map((root) =>
          nearestDistance(
            root.point,
            rotated.map((candidate) => candidate.point),
          ),
        ),
      ),
    ).toBeLessThan(1e-5);
  });
});
