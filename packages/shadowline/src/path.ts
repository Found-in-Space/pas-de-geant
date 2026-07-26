import {
  addSeconds,
  toIsoUtc,
} from "./math.js";
import {
  chordDistanceKm,
} from "./ecef-geometry.js";
import {
  axisIntersection,
  maximumShadowMarginOnSolarLimb,
  shadowSolarLimbIntersections,
  shadowSurfaceState,
  solarLimbMarginAtSurfaceKm,
  visibleShadowEnvelopePoints,
  type AxisIntersection,
  type ShadowEnvelopePoint,
} from "./shadow-math.js";
import type {
  CentralPathStrip,
  CentralPathSurface,
  EclipseKind,
  EclipseSummary,
  EarthFixedEphemeris,
  ObserverCircumstances,
  PathOptions,
  SurfaceCurve,
  SurfacePoint,
  TimedSurfacePoint,
  TimeMarker,
  TimeMarkerOptions,
} from "./types.js";

interface EnvelopeSample extends TimedSurfacePoint {
  timeMs: number;
  solarLimbMarginKm: number;
  side: ShadowEnvelopePoint["side"];
}

const CENTRAL_SEARCH_WINDOW_SECONDS = 6 * 60 * 60;
const CENTRAL_HORIZON_SEARCH_LIMIT_SECONDS = 30 * 60;
const CENTRAL_HORIZON_SAMPLE_SECONDS = 5;

interface TimedPoint extends TimedSurfacePoint {
  timeMs: number;
}

interface HorizonCap {
  branches: [TimedPoint[], TimedPoint[]];
}

function cloneSurfacePoint(point: SurfacePoint): SurfacePoint {
  return {
    ecefKm: { ...point.ecefKm },
    geographic: { ...point.geographic },
  };
}

function timedPoint(timeMs: number, point: SurfacePoint): TimedPoint {
  return {
    ...cloneSurfacePoint(point),
    atUtc: toIsoUtc(timeMs),
    timeMs,
  };
}

function findTransition(
  provider: EarthFixedEphemeris,
  outsideUtc: string,
  insideUtc: string,
): string {
  let outside = new Date(outsideUtc).getTime();
  let inside = new Date(insideUtc).getTime();
  for (let iteration = 0; iteration < 45; iteration += 1) {
    const middle = (outside + inside) / 2;
    if (axisIntersection(provider, toIsoUtc(middle))) inside = middle;
    else outside = middle;
  }
  return toIsoUtc(inside);
}

function centralWindow(
  provider: EarthFixedEphemeris,
  peakUtc: string,
): { startUtc: string; endUtc: string } {
  if (!axisIntersection(provider, peakUtc)) {
    throw new Error(`The shadow axis does not intersect Earth at ${peakUtc}.`);
  }
  const startOutside = addSeconds(
    peakUtc,
    -CENTRAL_SEARCH_WINDOW_SECONDS,
  );
  const endOutside = addSeconds(
    peakUtc,
    CENTRAL_SEARCH_WINDOW_SECONDS,
  );
  if (
    axisIntersection(provider, startOutside) ||
    axisIntersection(provider, endOutside)
  ) {
    throw new Error(
      `Central eclipse window for ${peakUtc} exceeds the six-hour search bounds.`,
    );
  }
  return {
    startUtc: findTransition(provider, startOutside, peakUtc),
    endUtc: findTransition(provider, endOutside, peakUtc),
  };
}

function envelopeCandidates(
  provider: EarthFixedEphemeris,
  axis: AxisIntersection,
  derivativeDeltaMs: number,
): EnvelopeSample[] {
  const timeMs = new Date(axis.atUtc).getTime();
  const axisSolarLimbMarginKm = solarLimbMarginAtSurfaceKm(
    axis,
    axis.point,
  );
  return visibleShadowEnvelopePoints(
    shadowSurfaceState(
      provider,
      toIsoUtc(timeMs - derivativeDeltaMs),
    ),
    axis,
    shadowSurfaceState(
      provider,
      toIsoUtc(timeMs + derivativeDeltaMs),
    ),
    "central",
    axisSolarLimbMarginKm < 2_000 ? 2 : 10,
    true,
    false,
  ).map((candidate) => ({
    ...cloneSurfacePoint(candidate.point),
    atUtc: axis.atUtc,
    timeMs,
    side: candidate.side,
    solarLimbMarginKm: solarLimbMarginAtSurfaceKm(
      axis,
      candidate.point,
    ),
  }));
}

function predictedPoint(track: EnvelopeSample[]): SurfacePoint {
  const last = track[track.length - 1]!;
  if (track.length < 2) return last;
  const previous = track[track.length - 2]!;
  return {
    ecefKm: {
      x: 2 * last.ecefKm.x - previous.ecefKm.x,
      y: 2 * last.ecefKm.y - previous.ecefKm.y,
      z: 2 * last.ecefKm.z - previous.ecefKm.z,
    },
    geographic: last.geographic,
  };
}

function assignPair(
  tracks: [EnvelopeSample[], EnvelopeSample[]],
  candidates: EnvelopeSample[],
): [EnvelopeSample | null, EnvelopeSample | null] {
  if (candidates.length === 0) return [null, null];
  const predictions = tracks.map(predictedPoint);
  let best: {
    cost: number;
    assigned: [EnvelopeSample | null, EnvelopeSample | null];
  } = {
    cost: Number.POSITIVE_INFINITY,
    assigned: [null, null],
  };
  const choices = [-1, ...candidates.map((_candidate, index) => index)];
  for (const first of choices) {
    for (const second of choices) {
      if (first >= 0 && first === second) continue;
      const assigned: [EnvelopeSample | null, EnvelopeSample | null] = [
        first < 0 ? null : candidates[first]!,
        second < 0 ? null : candidates[second]!,
      ];
      if (!assigned[0] && !assigned[1]) continue;
      let cost = 0;
      for (const index of [0, 1] as const) {
        const candidate = assigned[index];
        if (!candidate) {
          cost += 1e8;
          continue;
        }
        cost += chordDistanceKm(
          predictions[index]!.ecefKm,
          candidate.ecefKm,
        );
        if (candidate.side !== tracks[index][0]!.side) cost += 1e6;
      }
      if (cost < best.cost) best = { cost, assigned };
    }
  }
  return best.assigned;
}

/**
 * Predictor-corrector continuation in ECEF. Root identities are seeded by
 * signed cross-track at peak and never inferred from latitude.
 */
function trackEnvelopeLimits(
  provider: EarthFixedEphemeris,
  axes: AxisIntersection[],
  peakIndex: number,
  derivativeDeltaMs: number,
): [EnvelopeSample[], EnvelopeSample[]] {
  const peakCandidates = envelopeCandidates(
    provider,
    axes[peakIndex]!,
    derivativeDeltaMs,
  );
  const positive = peakCandidates
    .filter((candidate) => candidate.side === "positive-cross-track")
    .sort(
      (left, right) =>
        chordDistanceKm(right.ecefKm, axes[peakIndex]!.point.ecefKm) -
        chordDistanceKm(left.ecefKm, axes[peakIndex]!.point.ecefKm),
    )[0];
  const negative = peakCandidates
    .filter((candidate) => candidate.side === "negative-cross-track")
    .sort(
      (left, right) =>
        chordDistanceKm(right.ecefKm, axes[peakIndex]!.point.ecefKm) -
        chordDistanceKm(left.ecefKm, axes[peakIndex]!.point.ecefKm),
    )[0];
  if (!positive || !negative) {
    throw new Error(
      `Unable to solve central limits at ${axes[peakIndex]!.atUtc}.`,
    );
  }
  const forward: [EnvelopeSample[], EnvelopeSample[]] = [
    [positive],
    [negative],
  ];
  for (let index = peakIndex + 1; index < axes.length - 1; index += 1) {
    const assigned = assignPair(
      forward,
      envelopeCandidates(
        provider,
        axes[index]!,
        derivativeDeltaMs,
      ),
    );
    if (!assigned[0] && !assigned[1]) break;
    for (const trackIndex of [0, 1] as const) {
      if (assigned[trackIndex]) {
        forward[trackIndex].push(assigned[trackIndex]!);
      }
    }
  }

  const backward: [EnvelopeSample[], EnvelopeSample[]] = [
    [positive],
    [negative],
  ];
  for (let index = peakIndex - 1; index > 0; index -= 1) {
    // Predicting backwards uses the same extrapolation after reversing time.
    const assigned = assignPair(
      backward,
      envelopeCandidates(
        provider,
        axes[index]!,
        derivativeDeltaMs,
      ),
    );
    if (!assigned[0] && !assigned[1]) break;
    for (const trackIndex of [0, 1] as const) {
      if (assigned[trackIndex]) {
        backward[trackIndex].push(assigned[trackIndex]!);
      }
    }
  }
  return ([0, 1] as const).map((index) => [
    ...backward[index].slice(1).reverse(),
    ...forward[index],
  ]) as [EnvelopeSample[], EnvelopeSample[]];
}

function centralLimbMarginKm(
  provider: EarthFixedEphemeris,
  timeMs: number,
) {
  return maximumShadowMarginOnSolarLimb(
    shadowSurfaceState(provider, toIsoUtc(timeMs)),
    "central",
    5,
  );
}

function refineLimbTouch(
  provider: EarthFixedEphemeris,
  outsideMs: number,
  insideMs: number,
): TimedPoint {
  let outside = outsideMs;
  let inside = insideMs;
  for (let iteration = 0; iteration < 45; iteration += 1) {
    if (Math.abs(inside - outside) <= 1) break;
    const middle = (outside + inside) / 2;
    if (centralLimbMarginKm(provider, middle).marginKm > 0) inside = middle;
    else outside = middle;
  }
  const timeMs = (outside + inside) / 2;
  return timedPoint(
    timeMs,
    centralLimbMarginKm(provider, timeMs).point,
  );
}

function centralHorizonWindow(
  provider: EarthFixedEphemeris,
  axisContactMs: number,
): [TimedPoint, TimedPoint] {
  if (centralLimbMarginKm(provider, axisContactMs).marginKm <= 0) {
    throw new Error(
      `Central cone does not reach the solar limb at ${toIsoUtc(axisContactMs)}.`,
    );
  }
  const outside = (direction: -1 | 1): number => {
    for (
      let offsetSeconds = 1;
      offsetSeconds <= CENTRAL_HORIZON_SEARCH_LIMIT_SECONDS;
      offsetSeconds *= 2
    ) {
      const candidate =
        axisContactMs + direction * offsetSeconds * 1000;
      if (centralLimbMarginKm(provider, candidate).marginKm <= 0) {
        return candidate;
      }
    }
    throw new Error(
      `Central horizon cap near ${toIsoUtc(axisContactMs)} exceeds the search bounds.`,
    );
  };
  return [
    refineLimbTouch(provider, outside(-1), axisContactMs),
    refineLimbTouch(provider, outside(1), axisContactMs),
  ];
}

function assignHorizonBranches(
  previous: [SurfacePoint, SurfacePoint] | null,
  points: [SurfacePoint, SurfacePoint],
): [SurfacePoint, SurfacePoint] {
  if (!previous) return points;
  const direct =
    chordDistanceKm(previous[0].ecefKm, points[0].ecefKm) +
    chordDistanceKm(previous[1].ecefKm, points[1].ecefKm);
  const swapped =
    chordDistanceKm(previous[0].ecefKm, points[1].ecefKm) +
    chordDistanceKm(previous[1].ecefKm, points[0].ecefKm);
  return direct <= swapped ? points : [points[1], points[0]];
}

function centralHorizonCap(
  provider: EarthFixedEphemeris,
  axisContactMs: number,
  requestedSampleSeconds: number,
): HorizonCap {
  const [begin, end] = centralHorizonWindow(provider, axisContactMs);
  const branches: [TimedPoint[], TimedPoint[]] = [
    [begin],
    [timedPoint(begin.timeMs, begin)],
  ];
  const stepMs =
    Math.min(
      requestedSampleSeconds,
      CENTRAL_HORIZON_SAMPLE_SECONDS,
    ) * 1000;
  const sampleTimes = new Set<number>();
  for (
    let timeMs = Math.ceil(begin.timeMs / stepMs) * stepMs;
    timeMs < end.timeMs;
    timeMs += stepMs
  ) {
    if (timeMs > begin.timeMs) sampleTimes.add(timeMs);
  }
  for (const offsetMs of [
    100, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000,
  ]) {
    if (begin.timeMs + offsetMs < end.timeMs) {
      sampleTimes.add(begin.timeMs + offsetMs);
    }
    if (end.timeMs - offsetMs > begin.timeMs) {
      sampleTimes.add(end.timeMs - offsetMs);
    }
  }

  let previous: [SurfacePoint, SurfacePoint] | null = null;
  for (const timeMs of [...sampleTimes].sort((a, b) => a - b)) {
    const distanceToTouchMs = Math.min(
      timeMs - begin.timeMs,
      end.timeMs - timeMs,
    );
    const roots = shadowSolarLimbIntersections(
      shadowSurfaceState(provider, toIsoUtc(timeMs)),
      "central",
      distanceToTouchMs < 5_000 ? 0.1 : 0.5,
    );
    if (roots.length !== 2) continue;
    const pair = assignHorizonBranches(previous, [
      roots[0]!.point,
      roots[1]!.point,
    ]);
    branches[0].push(timedPoint(timeMs, pair[0]));
    branches[1].push(timedPoint(timeMs, pair[1]));
    previous = pair;
  }
  branches[0].push(end);
  branches[1].push(timedPoint(end.timeMs, end));
  return { branches };
}

interface CapMatch {
  branch: 0 | 1;
  index: number;
}

function nearestOnBranch(
  branch: TimedPoint[],
  reference: SurfacePoint,
): { index: number; distanceKm: number } {
  return branch.reduce(
    (best, sample, index) => {
      const distanceKm = chordDistanceKm(
        sample.ecefKm,
        reference.ecefKm,
      );
      return distanceKm < best.distanceKm
        ? { index, distanceKm }
        : best;
    },
    { index: 0, distanceKm: Number.POSITIVE_INFINITY },
  );
}

function matchOppositeCapBranches(
  cap: HorizonCap,
  first: SurfacePoint,
  second: SurfacePoint,
): [CapMatch, CapMatch] {
  const firstOn0 = nearestOnBranch(cap.branches[0], first);
  const firstOn1 = nearestOnBranch(cap.branches[1], first);
  const secondOn0 = nearestOnBranch(cap.branches[0], second);
  const secondOn1 = nearestOnBranch(cap.branches[1], second);
  return firstOn0.distanceKm + secondOn1.distanceKm <=
    firstOn1.distanceKm + secondOn0.distanceKm
    ? [
        { branch: 0, index: firstOn0.index },
        { branch: 1, index: secondOn1.index },
      ]
    : [
        { branch: 1, index: firstOn1.index },
        { branch: 0, index: secondOn0.index },
      ];
}

function capArc(
  cap: HorizonCap,
  from: CapMatch,
  to: CapMatch,
  through: "early" | "late",
): TimedPoint[] {
  const fromBranch = cap.branches[from.branch];
  const toBranch = cap.branches[to.branch];
  if (through === "early") {
    return [
      ...fromBranch.slice(0, from.index + 1).reverse(),
      ...toBranch.slice(1, to.index + 1),
    ];
  }
  return [
    ...fromBranch.slice(from.index),
    ...toBranch.slice(to.index, -1).reverse(),
  ];
}

function addTimedEndpoint(
  points: TimedPoint[],
  sample: TimedPoint,
  atStart: boolean,
): void {
  const copy = timedPoint(sample.timeMs, sample);
  const current = atStart ? points[0]! : points.at(-1)!;
  if (chordDistanceKm(current.ecefKm, copy.ecefKm) < 1e-6) {
    if (atStart) points[0] = copy;
    else points[points.length - 1] = copy;
  } else if (atStart) points.unshift(copy);
  else points.push(copy);
}

function curve<T extends SurfacePoint>(
  points: T[],
  closed = false,
): SurfaceCurve<T> {
  return { points, ...(closed ? { closed: true } : {}) };
}

function selectedCapStrip(
  cap: HorizonCap,
  first: CapMatch,
  second: CapMatch,
  through: "early" | "late",
): CentralPathStrip {
  const selected = (match: CapMatch): TimedPoint[] => {
    const branch = cap.branches[match.branch];
    return through === "early"
      ? branch.slice(0, match.index + 1)
      : branch.slice(match.index);
  };
  return {
    edges: [
      curve(selected(first)),
      curve(selected(second)),
    ],
  };
}

export function calculateCentralPath(
  provider: EarthFixedEphemeris,
  event: EclipseSummary,
  options: PathOptions = {},
): CentralPathSurface {
  if (event.kind === "partial") {
    throw new RangeError(
      "Partial-only eclipses do not have a central track.",
    );
  }
  const sampleIntervalSeconds = options.sampleIntervalSeconds ?? 5;
  if (
    !Number.isInteger(sampleIntervalSeconds) ||
    sampleIntervalSeconds < 1 ||
    sampleIntervalSeconds > 300
  ) {
    throw new RangeError(
      "Sample interval must be an integer from 1 to 300 seconds.",
    );
  }
  const calculationSampleIntervalSeconds = Math.min(
    sampleIntervalSeconds,
    5,
  );

  const window = centralWindow(provider, event.peakUtc);
  const startMs = new Date(window.startUtc).getTime();
  const endMs = new Date(window.endUtc).getTime();
  const startCap = centralHorizonCap(
    provider,
    startMs,
    calculationSampleIntervalSeconds,
  );
  const endCap = centralHorizonCap(
    provider,
    endMs,
    calculationSampleIntervalSeconds,
  );
  const stepMilliseconds = calculationSampleIntervalSeconds * 1000;
  const centerAxes: AxisIntersection[] = [];
  for (
    let time =
      Math.ceil((startMs + 1) / stepMilliseconds) * stepMilliseconds;
    time <=
    Math.floor((endMs - 1) / stepMilliseconds) * stepMilliseconds;
    time += stepMilliseconds
  ) {
    const axis = axisIntersection(provider, toIsoUtc(time));
    if (axis) centerAxes.push(axis);
  }

  const peakTime = new Date(event.peakUtc).getTime();
  const envelopeStartMs = startCap.branches[0][0]!.timeMs;
  const envelopeEndMs = endCap.branches[0].at(-1)!.timeMs;
  const envelopeTimes = new Set<number>([peakTime]);
  for (
    let timeMs =
      Math.ceil(envelopeStartMs / stepMilliseconds) * stepMilliseconds;
    timeMs < envelopeEndMs;
    timeMs += stepMilliseconds
  ) {
    if (timeMs > envelopeStartMs) envelopeTimes.add(timeMs);
  }
  for (const offsetMs of [
    100, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000,
    60_000,
  ]) {
    if (envelopeStartMs + offsetMs < envelopeEndMs) {
      envelopeTimes.add(envelopeStartMs + offsetMs);
    }
    if (envelopeEndMs - offsetMs > envelopeStartMs) {
      envelopeTimes.add(envelopeEndMs - offsetMs);
    }
  }
  const axes = [...envelopeTimes]
    .sort((left, right) => left - right)
    .map((timeMs) =>
      shadowSurfaceState(provider, toIsoUtc(timeMs)),
    );
  const peakIndex = axes.reduce(
    (nearestIndex, axis, index) =>
      Math.abs(new Date(axis.atUtc).getTime() - peakTime) <
      Math.abs(
        new Date(axes[nearestIndex]!.atUtc).getTime() - peakTime,
      )
        ? index
        : nearestIndex,
    0,
  );
  if (peakIndex === 0 || peakIndex === axes.length - 1) {
    throw new Error(`No central shadow around ${event.peakUtc}.`);
  }
  const [positiveSamples, negativeSamples] = trackEnvelopeLimits(
    provider,
    axes,
    peakIndex,
    Math.min(1_000, stepMilliseconds / 2),
  );
  if (
    positiveSamples.length < 2 ||
    negativeSamples.length < 2 ||
    centerAxes.length < 2
  ) {
    throw new Error(
      `Insufficient central-track samples for ${event.id}.`,
    );
  }

  const kind = classifyWindow(provider, event, window);
  const centerline: TimedPoint[] = [
    timedPoint(
      startMs,
      shadowSurfaceState(provider, window.startUtc).point,
    ),
    ...centerAxes.map((axis) =>
      timedPoint(new Date(axis.atUtc).getTime(), axis.point),
    ),
    timedPoint(
      endMs,
      shadowSurfaceState(provider, window.endUtc).point,
    ),
  ];
  const positiveTimed = positiveSamples.map((sample) =>
    timedPoint(sample.timeMs, sample),
  );
  const negativeTimed = negativeSamples.map((sample) =>
    timedPoint(sample.timeMs, sample),
  );

  const [startPositiveMatch, startNegativeMatch] =
    matchOppositeCapBranches(
      startCap,
      positiveTimed[0]!,
      negativeTimed[0]!,
    );
  const [endNegativeMatch, endPositiveMatch] =
    matchOppositeCapBranches(
      endCap,
      negativeTimed.at(-1)!,
      positiveTimed.at(-1)!,
    );
  addTimedEndpoint(
    positiveTimed,
    startCap.branches[startPositiveMatch.branch][
      startPositiveMatch.index
    ]!,
    true,
  );
  addTimedEndpoint(
    negativeTimed,
    startCap.branches[startNegativeMatch.branch][
      startNegativeMatch.index
    ]!,
    true,
  );
  addTimedEndpoint(
    negativeTimed,
    endCap.branches[endNegativeMatch.branch][endNegativeMatch.index]!,
    false,
  );
  addTimedEndpoint(
    positiveTimed,
    endCap.branches[endPositiveMatch.branch][endPositiveMatch.index]!,
    false,
  );

  const startCapArc = capArc(
    startCap,
    startPositiveMatch,
    startNegativeMatch,
    "late",
  );
  const endCapArc = capArc(
    endCap,
    endNegativeMatch,
    endPositiveMatch,
    "early",
  );
  const ringTimed = [
    ...negativeTimed,
    ...endCapArc.slice(1),
    ...positiveTimed.slice().reverse().slice(1),
    ...startCapArc.slice(1),
  ];
  const boundary = ringTimed.map(cloneSurfacePoint);
  if (
    chordDistanceKm(
      boundary[0]!.ecefKm,
      boundary.at(-1)!.ecefKm,
    ) > 1e-9
  ) {
    boundary.push(cloneSurfacePoint(boundary[0]!));
  }

  return {
    datum: "WGS 84",
    calculationFrame: "geocentric-earth-fixed",
    kind,
    centralBeginUtc: window.startUtc,
    centralEndUtc: window.endUtc,
    centerline: curve(centerline),
    limits: {
      positiveCrossTrack: curve(positiveTimed),
      negativeCrossTrack: curve(negativeTimed),
    },
    startCap: selectedCapStrip(
      startCap,
      startPositiveMatch,
      startNegativeMatch,
      "late",
    ),
    endCap: selectedCapStrip(
      endCap,
      endNegativeMatch,
      endPositiveMatch,
      "early",
    ),
    boundary: curve(boundary, true),
  };
}

function nearestLimitDistanceKm(
  center: SurfacePoint,
  limit: SurfaceCurve<TimedSurfacePoint>,
): number {
  return Math.min(
    ...limit.points.map((point) =>
      chordDistanceKm(center.ecefKm, point.ecefKm),
    ),
  );
}

export function calculateTimeMarkers(
  provider: EarthFixedEphemeris,
  circumstances: ObserverCircumstances,
  event: EclipseSummary,
  path: CentralPathSurface,
  options: TimeMarkerOptions = {},
): TimeMarker[] {
  const intervalMinutes = options.intervalMinutes ?? 10;
  if (
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 60
  ) {
    throw new RangeError(
      "Marker interval must be an integer from 1 to 60 minutes.",
    );
  }
  const intervalMs = intervalMinutes * 60 * 1000;
  const selected = new Map<number, TimedSurfacePoint>();
  for (const sample of path.centerline.points) {
    const sampleMs = new Date(sample.atUtc).getTime();
    const bucket = Math.round(sampleMs / intervalMs) * intervalMs;
    const current = selected.get(bucket);
    if (
      !current ||
      Math.abs(sampleMs - bucket) <
        Math.abs(new Date(current.atUtc).getTime() - bucket)
    ) {
      selected.set(bucket, sample);
    }
  }
  return [...selected.values()]
    .sort(
      (left, right) =>
        new Date(left.atUtc).getTime() -
        new Date(right.atUtc).getTime(),
    )
    .map((sample) => {
      const observer = {
        ...sample.geographic,
        elevationMeters: 0,
      };
      const horizontal = circumstances.horizontalCoordinates(
        "sun",
        sample.atUtc,
        observer,
      );
      const local = circumstances
        .searchLocalEclipses(observer, {
          startUtc: addSeconds(event.peakUtc, -24 * 60 * 60),
          endUtc: addSeconds(event.peakUtc, 24 * 60 * 60),
        })
        .find(
          (candidate) =>
            Math.abs(
              new Date(candidate.peak.utc).getTime() -
                new Date(event.peakUtc).getTime(),
            ) <
            12 * 60 * 60 * 1000,
        );
      const centralDurationSeconds =
        local?.centralBegin && local.centralEnd
          ? (new Date(local.centralEnd.utc).getTime() -
              new Date(local.centralBegin.utc).getTime()) /
            1000
          : undefined;
      const state = shadowSurfaceState(provider, sample.atUtc);
      return {
        point: sample,
        sunAltitudeDeg: horizontal.altitudeDeg,
        sunAzimuthDeg: horizontal.azimuthDeg,
        pathWidthKm:
          nearestLimitDistanceKm(
            sample,
            path.limits.positiveCrossTrack,
          ) +
          nearestLimitDistanceKm(
            sample,
            path.limits.negativeCrossTrack,
          ),
        ...(centralDurationSeconds === undefined
          ? {}
          : { centralDurationSeconds }),
        eclipseKind:
          state.signedUmbraRadiusKm >= 0 ? "total" : "annular",
      };
    });
}

export function classifyCentralEclipse(
  provider: EarthFixedEphemeris,
  event: EclipseSummary,
): Exclude<EclipseKind, "partial"> {
  if (event.kind === "partial") {
    throw new RangeError(
      "A partial-only eclipse has no central classification.",
    );
  }
  return classifyWindow(
    provider,
    event,
    centralWindow(provider, event.peakUtc),
  );
}

function classifyWindow(
  provider: EarthFixedEphemeris,
  event: EclipseSummary,
  window: { startUtc: string; endUtc: string },
): Exclude<EclipseKind, "partial"> {
  const start = Date.parse(window.startUtc);
  const end = Date.parse(window.endUtc);
  const peak = Date.parse(event.peakUtc);
  const instants = [
    start + 100,
    start + 1_000,
    start + 5_000,
    start + 30_000,
    start + 60_000,
    peak,
    end - 60_000,
    end - 30_000,
    end - 5_000,
    end - 1_000,
    end - 100,
  ];
  let sawTotal = false;
  let sawAnnular = false;
  for (const instant of instants) {
    const axis = axisIntersection(provider, toIsoUtc(instant));
    if (!axis) continue;
    if (axis.signedUmbraRadiusKm >= 0) sawTotal = true;
    else sawAnnular = true;
  }
  if (sawTotal && sawAnnular) return "hybrid";
  return sawTotal ? "total" : "annular";
}
