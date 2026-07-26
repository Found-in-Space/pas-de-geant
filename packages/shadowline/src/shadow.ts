import { toIsoUtc } from "./math.js";
import {
  GEOMETRY_RESIDUAL_TOLERANCE_KM,
  chordDistanceKm,
} from "./ecef-geometry.js";
import {
  maximumShadowMarginOnSolarLimb,
  shadowBoundaryAtAzimuth,
  shadowMarginAtSurfaceKm,
  shadowSolarLimbIntersections,
  shadowSurfaceState,
  solarLimbMarginAtSurfaceKm,
  solarLimbPoint,
  type AxisIntersection,
  type ShadowCone,
} from "./shadow-math.js";
import type {
  EarthFixedEphemeris,
  EclipseSummary,
  InstantaneousShadowSurface,
  ShadowOutlineOptions,
  SurfacePoint,
  SurfaceRegion,
} from "./types.js";

interface OrderedBoundaryPoint {
  azimuthRad: number;
  point: SurfacePoint;
}

function clonePoint(point: SurfacePoint): SurfacePoint {
  return {
    ecefKm: { ...point.ecefKm },
    geographic: { ...point.geographic },
  };
}

function closeRing(points: SurfacePoint[]): SurfacePoint[] {
  if (points.length === 0) return points;
  if (
    chordDistanceKm(points[0]!.ecefKm, points.at(-1)!.ecefKm) >
    1e-9
  ) {
    points.push(clonePoint(points[0]!));
  }
  return points;
}

function contiguousRuns(
  samples: Array<OrderedBoundaryPoint | null>,
): OrderedBoundaryPoint[][] {
  const runs: OrderedBoundaryPoint[][] = [];
  let current: OrderedBoundaryPoint[] = [];
  for (const sample of samples) {
    if (sample) current.push(sample);
    else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  if (
    runs.length > 1 &&
    samples[0] &&
    samples.at(-1)
  ) {
    const last = runs.pop()!;
    runs[0] = [...last, ...runs[0]!];
  }
  return runs;
}

function limbArc(
  axis: AxisIntersection,
  cone: ShadowCone,
  fromAngleDeg: number,
  toAngleDeg: number,
  maximumStepDegrees: number,
): SurfacePoint[] {
  const positiveSpan =
    ((toAngleDeg - fromAngleDeg) % 360 + 360) % 360;
  const negativeSpan = positiveSpan - 360;
  const midpointMargin = (span: number) =>
    shadowMarginAtSurfaceKm(
      axis,
      solarLimbPoint(axis, fromAngleDeg + span / 2),
      cone,
    );
  const span =
    midpointMargin(positiveSpan) >=
    midpointMargin(negativeSpan)
      ? positiveSpan
      : negativeSpan;
  const count = Math.max(
    1,
    Math.ceil(Math.abs(span) / maximumStepDegrees),
  );
  const points: SurfacePoint[] = [];
  for (let index = 0; index <= count; index += 1) {
    points.push(
      solarLimbPoint(
        axis,
        fromAngleDeg + (span * index) / count,
      ),
    );
  }
  return points;
}

/**
 * Builds the visible intersection region from exact cone-boundary and
 * solar-limb arcs. Longitude is never used to order or close the ring.
 */
function visibleRegion(
  axis: AxisIntersection,
  cone: ShadowCone,
  maximumAngleDegrees: number,
): SurfaceRegion {
  const stepRad = (maximumAngleDegrees * Math.PI) / 180;
  const samples: Array<OrderedBoundaryPoint | null> = [];
  for (
    let azimuthRad = 0;
    azimuthRad < 2 * Math.PI - stepRad / 2;
    azimuthRad += stepRad
  ) {
    const point = shadowBoundaryAtAzimuth(
      axis,
      azimuthRad,
      cone,
      false,
    );
    samples.push(
      point &&
        solarLimbMarginAtSurfaceKm(axis, point) >=
          -GEOMETRY_RESIDUAL_TOLERANCE_KM
        ? { azimuthRad, point }
        : null,
    );
  }
  const visibleCount = samples.filter(Boolean).length;
  if (visibleCount === samples.length && visibleCount >= 3) {
    const points = closeRing(
      samples.map(
        (sample) => clonePoint(sample!.point),
      ),
    );
    return {
      rings: [
        {
          points,
          closed: true,
          segments: [
            {
              kind: "cone",
              curve: { points, closed: true },
            },
          ],
        },
      ],
    };
  }
  if (visibleCount === 0) return { rings: [] };

  const intersections = shadowSolarLimbIntersections(
    axis,
    cone,
    Math.min(1, maximumAngleDegrees),
  );
  if (intersections.length < 2) return { rings: [] };
  const runs = contiguousRuns(samples)
    .filter((run) => run.length >= 2)
    .sort((left, right) => right.length - left.length);
  const rings = runs.slice(0, intersections.length / 2).flatMap((run) => {
    const first = run[0]!.point;
    const last = run.at(-1)!.point;
    const ordered = intersections
      .map((intersection, index) => ({
        intersection,
        index,
        firstDistance: chordDistanceKm(
          first.ecefKm,
          intersection.point.ecefKm,
        ),
        lastDistance: chordDistanceKm(
          last.ecefKm,
          intersection.point.ecefKm,
        ),
      }));
    let best:
      | {
          first: (typeof intersections)[number];
          last: (typeof intersections)[number];
          cost: number;
        }
      | undefined;
    for (const firstCandidate of ordered) {
      for (const lastCandidate of ordered) {
        if (firstCandidate.index === lastCandidate.index) continue;
        const cost =
          firstCandidate.firstDistance +
          lastCandidate.lastDistance;
        if (!best || cost < best.cost) {
          best = {
            first: firstCandidate.intersection,
            last: lastCandidate.intersection,
            cost,
          };
        }
      }
    }
    if (!best) return [];
    const coneArc = [
      clonePoint(best.first.point),
      ...run.map((sample) => clonePoint(sample.point)),
      clonePoint(best.last.point),
    ];
    const horizonArc = limbArc(
      axis,
      cone,
      best.last.angleDeg,
      best.first.angleDeg,
      maximumAngleDegrees,
    );
    const points = closeRing([
      ...coneArc,
      ...horizonArc.slice(1),
    ]);
    return [
      {
        points,
        closed: true as const,
        segments: [
          {
            kind: "cone" as const,
            curve: { points: coneArc },
          },
          {
            kind: "solar-limb" as const,
            curve: { points: horizonArc },
          },
        ],
      },
    ];
  });
  return { rings };
}

export function calculateInstantaneousShadow(
  provider: EarthFixedEphemeris,
  event: EclipseSummary,
  atUtc: string,
  options: ShadowOutlineOptions = {},
): InstantaneousShadowSurface {
  const instant = new Date(atUtc);
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError(`Invalid instantaneous-shadow time: ${atUtc}`);
  }
  if (
    Math.abs(
      instant.getTime() - new Date(event.peakUtc).getTime(),
    ) >
    24 * 60 * 60 * 1000
  ) {
    throw new RangeError(
      "Instantaneous-shadow time must be within 24 hours of eclipse maximum.",
    );
  }
  const angularIntervalDegrees =
    options.angularIntervalDegrees ?? 3;
  if (
    !Number.isFinite(angularIntervalDegrees) ||
    angularIntervalDegrees < 0.25 ||
    angularIntervalDegrees > 15
  ) {
    throw new RangeError(
      "Shadow angular interval must be from 0.25 to 15 degrees.",
    );
  }
  const calculationAngleDegrees = Math.min(
    angularIntervalDegrees,
    3,
  );

  const utc = toIsoUtc(instant);
  const state = shadowSurfaceState(provider, utc);
  const penumbra = visibleRegion(
    state,
    "penumbra",
    calculationAngleDegrees,
  );
  if (penumbra.rings.length === 0) {
    throw new Error(`The penumbra does not intersect visible Earth at ${utc}.`);
  }
  const centralVisible =
    state.axisIntersectsEarth ||
    maximumShadowMarginOnSolarLimb(
      state,
      "central",
      Math.min(2, calculationAngleDegrees),
    ).marginKm > 0;
  const centralRegion = centralVisible
    ? visibleRegion(state, "central", calculationAngleDegrees)
    : { rings: [] };

  return {
    datum: "WGS 84",
    calculationFrame: "geocentric-earth-fixed",
    atUtc: utc,
    penumbra,
    central:
      centralRegion.rings.length > 0
        ? {
            kind:
              state.signedUmbraRadiusKm >= 0
                ? "umbra"
                : "antumbra",
            region: centralRegion,
          }
        : null,
  };
}
