import {
  scale,
  subtract,
  toIsoUtc,
} from "./math.js";
import {
  CONTACT_TIME_TOLERANCE_MS,
  ROOT_ITERATIONS,
  chordDistanceKm,
} from "./ecef-geometry.js";
import {
  maximumShadowMarginOnSolarLimb,
  shadowSolarLimbIntersections,
  shadowSurfaceState,
  solarLimbMarginAtSurfaceKm,
  visibleShadowEnvelopePoints,
  type AxisIntersection,
  type ShadowEnvelopePoint,
} from "./shadow-math.js";
import type {
  EarthFixedEphemeris,
  EclipseSummary,
  GlobalVisibilityOptions,
  GlobalVisibilityResult,
  PenumbralContact,
  PenumbralContactKind,
  PenumbralVisibilitySurface,
  SurfacePoint,
  TimedSurfacePoint,
} from "./types.js";

const SEARCH_WINDOW_SECONDS = 6 * 60 * 60;
const CONTACT_SEARCH_INTERVAL_SECONDS = 120;
const INTERNAL_TIME_STEP_SECONDS = 10;
const INTERNAL_AZIMUTH_STEP_DEGREES = 2;

interface ContactRoot extends PenumbralContact {
  crossing: "entering" | "leaving";
}

interface TimedCandidate extends TimedSurfacePoint {
  timeMs: number;
  side: ShadowEnvelopePoint["side"];
}

interface Track {
  side: ShadowEnvelopePoint["side"];
  samples: TimedCandidate[];
  active: boolean;
}

function clonePoint(point: SurfacePoint): SurfacePoint {
  return {
    ecefKm: { ...point.ecefKm },
    geographic: { ...point.geographic },
  };
}

function timedPoint(
  timeMs: number,
  point: SurfacePoint,
): TimedCandidate {
  return {
    ...clonePoint(point),
    atUtc: toIsoUtc(timeMs),
    timeMs,
    side: "positive-cross-track",
  };
}

function contactAt(
  provider: EarthFixedEphemeris,
  outsideMs: number,
  insideMs: number,
  angularIntervalDegrees: number,
): Omit<ContactRoot, "kind"> {
  let outside = outsideMs;
  let inside = insideMs;
  const crossing: ContactRoot["crossing"] =
    outsideMs < insideMs ? "entering" : "leaving";
  for (let iteration = 0; iteration < ROOT_ITERATIONS; iteration += 1) {
    if (
      Math.abs(inside - outside) <=
      CONTACT_TIME_TOLERANCE_MS
    ) {
      break;
    }
    const middle = (outside + inside) / 2;
    const maximum = maximumShadowMarginOnSolarLimb(
      shadowSurfaceState(provider, toIsoUtc(middle)),
      "penumbra",
      angularIntervalDegrees,
    );
    if (maximum.marginKm > 0) inside = middle;
    else outside = middle;
  }
  const contactMs = (outside + inside) / 2;
  const maximum = maximumShadowMarginOnSolarLimb(
    shadowSurfaceState(provider, toIsoUtc(contactMs)),
    "penumbra",
    angularIntervalDegrees,
  );
  return {
    utc: toIsoUtc(contactMs),
    point: clonePoint(maximum.point),
    crossing,
  };
}

function findContacts(
  provider: EarthFixedEphemeris,
  event: EclipseSummary,
  angularIntervalDegrees: number,
): ContactRoot[] {
  const peakMs = new Date(event.peakUtc).getTime();
  const startMs = peakMs - SEARCH_WINDOW_SECONDS * 1000;
  const endMs = peakMs + SEARCH_WINDOW_SECONDS * 1000;
  const intervalMs = CONTACT_SEARCH_INTERVAL_SECONDS * 1000;
  const roots: Array<Omit<ContactRoot, "kind">> = [];
  let previousMs = startMs;
  let previousMargin = maximumShadowMarginOnSolarLimb(
    shadowSurfaceState(provider, toIsoUtc(previousMs)),
    "penumbra",
    angularIntervalDegrees,
  ).marginKm;
  for (
    let currentMs = startMs + intervalMs;
    currentMs <= endMs;
    currentMs += intervalMs
  ) {
    const currentMargin = maximumShadowMarginOnSolarLimb(
      shadowSurfaceState(provider, toIsoUtc(currentMs)),
      "penumbra",
      angularIntervalDegrees,
    ).marginKm;
    if (previousMargin <= 0 && currentMargin > 0) {
      roots.push(
        contactAt(
          provider,
          previousMs,
          currentMs,
          angularIntervalDegrees,
        ),
      );
    } else if (previousMargin > 0 && currentMargin <= 0) {
      roots.push(
        contactAt(
          provider,
          currentMs,
          previousMs,
          angularIntervalDegrees,
        ),
      );
    }
    previousMs = currentMs;
    previousMargin = currentMargin;
  }
  if (roots.length !== 2 && roots.length !== 4) {
    throw new Error(
      `Expected two or four penumbral limb contacts for ${event.id}; found ${roots.length}.`,
    );
  }
  const kinds: PenumbralContactKind[] =
    roots.length === 4
      ? ["P1", "P2", "P3", "P4"]
      : ["P1", "P4"];
  return roots.map((root, index) => ({
    ...root,
    kind: kinds[index]!,
  }));
}

function publicContacts(contacts: ContactRoot[]): PenumbralContact[] {
  return contacts.map(({ crossing: _crossing, ...contact }) => ({
    ...contact,
    point: clonePoint(contact.point),
  }));
}

/**
 * Calculates only the global P1–P4 penumbral contacts, without constructing
 * the much larger visibility surface.
 */
export function calculateGlobalContacts(
  provider: EarthFixedEphemeris,
  event: EclipseSummary,
): PenumbralContact[] {
  return publicContacts(
    findContacts(provider, event, INTERNAL_AZIMUTH_STEP_DEGREES),
  );
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

function horizonLoop(
  provider: EarthFixedEphemeris,
  start: ContactRoot,
  end: ContactRoot,
  sampleIntervalSeconds: number,
  angularIntervalDegrees: number,
): TimedSurfacePoint[] {
  const startMs = new Date(start.utc).getTime();
  const endMs = new Date(end.utc).getTime();
  const first: TimedSurfacePoint = {
    ...clonePoint(start.point),
    atUtc: start.utc,
  };
  const last: TimedSurfacePoint = {
    ...clonePoint(end.point),
    atUtc: end.utc,
  };
  const branchA: TimedSurfacePoint[] = [first];
  const branchB: TimedSurfacePoint[] = [
    { ...clonePoint(start.point), atUtc: start.utc },
  ];
  const stepMs = sampleIntervalSeconds * 1000;
  const sampleTimes = new Set<number>();
  for (
    let timeMs = Math.ceil(startMs / stepMs) * stepMs;
    timeMs < endMs;
    timeMs += stepMs
  ) {
    if (timeMs > startMs) sampleTimes.add(timeMs);
  }
  for (const offsetMs of [
    1_000, 2_000, 5_000, 10_000, 20_000, 30_000,
  ]) {
    if (startMs + offsetMs < endMs) {
      sampleTimes.add(startMs + offsetMs);
    }
    if (endMs - offsetMs > startMs) {
      sampleTimes.add(endMs - offsetMs);
    }
  }
  let previousPair: [SurfacePoint, SurfacePoint] | null = null;
  for (const timeMs of [...sampleTimes].sort((a, b) => a - b)) {
    const roots = shadowSolarLimbIntersections(
      shadowSurfaceState(provider, toIsoUtc(timeMs)),
      "penumbra",
      Math.min(angularIntervalDegrees, 1),
    );
    if (roots.length !== 2) continue;
    const pair = assignHorizonBranches(previousPair, [
      roots[0]!.point,
      roots[1]!.point,
    ]);
    branchA.push({
      ...clonePoint(pair[0]),
      atUtc: toIsoUtc(timeMs),
    });
    branchB.push({
      ...clonePoint(pair[1]),
      atUtc: toIsoUtc(timeMs),
    });
    previousPair = pair;
  }
  branchA.push(last);
  branchB.push({ ...clonePoint(end.point), atUtc: end.utc });
  return [
    ...branchA,
    ...branchB.reverse().slice(1),
    { ...clonePoint(start.point), atUtc: start.utc },
  ];
}

function envelopeCandidates(
  provider: EarthFixedEphemeris,
  timeMs: number,
  derivativeDeltaMs: number,
  angularIntervalDegrees: number,
  clipToSunlitLimb: boolean,
): TimedCandidate[] {
  const state = shadowSurfaceState(provider, toIsoUtc(timeMs));
  return visibleShadowEnvelopePoints(
    shadowSurfaceState(
      provider,
      toIsoUtc(timeMs - derivativeDeltaMs),
    ),
    state,
    shadowSurfaceState(
      provider,
      toIsoUtc(timeMs + derivativeDeltaMs),
    ),
    "penumbra",
    angularIntervalDegrees,
    true,
    clipToSunlitLimb,
  )
    .filter(
      (candidate) =>
        !clipToSunlitLimb ||
        solarLimbMarginAtSurfaceKm(state, candidate.point) >= 0,
    )
    .map((candidate) => ({
      ...clonePoint(candidate.point),
      atUtc: toIsoUtc(timeMs),
      timeMs,
      side: candidate.side,
    }));
}

function predictedEcef(track: Track) {
  const last = track.samples.at(-1)!;
  if (track.samples.length < 2) return last.ecefKm;
  const previous = track.samples.at(-2)!;
  return {
    x: 2 * last.ecefKm.x - previous.ecefKm.x,
    y: 2 * last.ecefKm.y - previous.ecefKm.y,
    z: 2 * last.ecefKm.z - previous.ecefKm.z,
  };
}

/**
 * Exhaustive minimum-cost assignment. There are ordinarily two roots, so
 * exhaustive enumeration is both clearer and more deterministic than a
 * greedy nearest-neighbour pass.
 */
function minimumAssignment(
  tracks: Track[],
  candidates: TimedCandidate[],
): Array<[number, number]> {
  const active = tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.active);
  let best: { cost: number; pairs: Array<[number, number]> } = {
    cost: Number.POSITIVE_INFINITY,
    pairs: [],
  };
  const recurse = (
    activeIndex: number,
    used: Set<number>,
    pairs: Array<[number, number]>,
    cost: number,
  ) => {
    if (activeIndex === active.length) {
      if (
        cost < best.cost ||
        (cost === best.cost && pairs.length > best.pairs.length)
      ) {
        best = { cost, pairs: pairs.slice() };
      }
      return;
    }
    const current = active[activeIndex]!;
    // Ending a branch is allowed but deliberately more expensive than any
    // physically plausible assignment; no fixed kilometre cutoff is used.
    recurse(activeIndex + 1, used, pairs, cost + 1e7);
    const prediction = predictedEcef(current.track);
    for (
      let candidateIndex = 0;
      candidateIndex < candidates.length;
      candidateIndex += 1
    ) {
      if (used.has(candidateIndex)) continue;
      const candidate = candidates[candidateIndex]!;
      const sidePenalty =
        candidate.side === current.track.side ? 0 : 1e6;
      used.add(candidateIndex);
      pairs.push([current.index, candidateIndex]);
      recurse(
        activeIndex + 1,
        used,
        pairs,
        cost +
          chordDistanceKm(prediction, candidate.ecefKm) +
          sidePenalty,
      );
      pairs.pop();
      used.delete(candidateIndex);
    }
  };
  recurse(0, new Set(), [], 0);
  return best.pairs;
}

function refineEndpoint(
  provider: EarthFixedEphemeris,
  inside: TimedCandidate,
  outsideMs: number,
  derivativeDeltaMs: number,
  angularIntervalDegrees: number,
): TimedCandidate {
  let insideMs = inside.timeMs;
  let outsideTimeMs = outsideMs;
  let reference = inside;
  for (let iteration = 0; iteration < ROOT_ITERATIONS; iteration += 1) {
    if (Math.abs(insideMs - outsideTimeMs) <= 1) break;
    const middleMs = (insideMs + outsideTimeMs) / 2;
    const candidates = envelopeCandidates(
      provider,
      middleMs,
      derivativeDeltaMs,
      angularIntervalDegrees,
      false,
    );
    const candidate = candidates
      .filter((item) => item.side === inside.side)
      .sort(
        (left, right) =>
          chordDistanceKm(left.ecefKm, reference.ecefKm) -
          chordDistanceKm(right.ecefKm, reference.ecefKm),
      )[0];
    if (!candidate) {
      outsideTimeMs = middleMs;
      continue;
    }
    const state = shadowSurfaceState(provider, candidate.atUtc);
    if (solarLimbMarginAtSurfaceKm(state, candidate) >= 0) {
      insideMs = middleMs;
      reference = candidate;
    } else {
      outsideTimeMs = middleMs;
    }
  }
  return reference;
}

function extentCurves(
  provider: EarthFixedEphemeris,
  contacts: ContactRoot[],
  sampleIntervalSeconds: number,
  angularIntervalDegrees: number,
): TimedSurfacePoint[][] {
  const startMs = new Date(contacts[0]!.utc).getTime();
  const endMs = new Date(contacts.at(-1)!.utc).getTime();
  const stepMs = sampleIntervalSeconds * 1000;
  const derivativeDeltaMs = Math.min(15_000, stepMs / 2);
  const sampleTimes: number[] = [];
  for (
    let timeMs = Math.ceil(startMs / stepMs) * stepMs;
    timeMs <= Math.floor(endMs / stepMs) * stepMs;
    timeMs += stepMs
  ) {
    sampleTimes.push(timeMs);
  }
  const tracks: Track[] = [];
  for (const timeMs of sampleTimes) {
    const candidates = envelopeCandidates(
      provider,
      timeMs,
      derivativeDeltaMs,
      angularIntervalDegrees,
      true,
    );
    const pairs = minimumAssignment(tracks, candidates);
    const assignedTracks = new Set(pairs.map(([track]) => track));
    const assignedCandidates = new Set(
      pairs.map(([_track, candidate]) => candidate),
    );
    for (const [trackIndex, candidateIndex] of pairs) {
      tracks[trackIndex]!.samples.push(candidates[candidateIndex]!);
    }
    for (let index = 0; index < tracks.length; index += 1) {
      if (tracks[index]!.active && !assignedTracks.has(index)) {
        tracks[index]!.active = false;
      }
    }
    for (
      let index = 0;
      index < candidates.length;
      index += 1
    ) {
      if (assignedCandidates.has(index)) continue;
      tracks.push({
        side: candidates[index]!.side,
        samples: [candidates[index]!],
        active: true,
      });
    }
  }

  const curves = tracks
    .filter((track) => track.samples.length >= 2)
    .map((track) => {
      const samples = track.samples;
      const first = samples[0]!;
      const last = samples.at(-1)!;
      const refinedFirst = refineEndpoint(
        provider,
        first,
        first.timeMs - stepMs,
        derivativeDeltaMs,
        angularIntervalDegrees,
      );
      const refinedLast = refineEndpoint(
        provider,
        last,
        last.timeMs + stepMs,
        derivativeDeltaMs,
        angularIntervalDegrees,
      );
      return [
        refinedFirst,
        ...samples,
        refinedLast,
      ].filter(
        (sample, index, all) =>
          index === 0 ||
          chordDistanceKm(
            sample.ecefKm,
            all[index - 1]!.ecefKm,
          ) > 1e-6,
      );
    })
    .sort((left, right) => right.length - left.length);

  // Four contacts produce independent sunrise and sunset extent branches;
  // two contacts produce one connected branch. This is event topology, not a
  // distance score or sample-count heuristic.
  return curves.slice(0, contacts.length === 4 ? 2 : 1);
}

export function calculateGlobalVisibility(
  provider: EarthFixedEphemeris,
  event: EclipseSummary,
  options: GlobalVisibilityOptions = {},
): GlobalVisibilityResult {
  const requestedSampleIntervalSeconds =
    options.sampleIntervalSeconds ?? 60;
  const requestedAngularIntervalDegrees =
    options.angularIntervalDegrees ?? 2;
  if (
    !Number.isInteger(requestedSampleIntervalSeconds) ||
    requestedSampleIntervalSeconds < 10 ||
    requestedSampleIntervalSeconds > 600
  ) {
    throw new RangeError(
      "Global-visibility sample interval must be an integer from 10 to 600 seconds.",
    );
  }
  if (
    !Number.isFinite(requestedAngularIntervalDegrees) ||
    requestedAngularIntervalDegrees < 0.5 ||
    requestedAngularIntervalDegrees > 10
  ) {
    throw new RangeError(
      "Global-visibility angular interval must be from 0.5 to 10 degrees.",
    );
  }
  // Public intervals are maximum output spacings, never solver controls.
  // The invariant topology graph is therefore built at one deterministic
  // internal resolution for every valid option combination.
  const sampleIntervalSeconds = INTERNAL_TIME_STEP_SECONDS;
  const angularIntervalDegrees = INTERNAL_AZIMUTH_STEP_DEGREES;
  const contacts = findContacts(
    provider,
    event,
    angularIntervalDegrees,
  );
  const horizonIntervals: Array<[ContactRoot, ContactRoot]> =
    contacts.length === 4
      ? [
          [contacts[0]!, contacts[1]!],
          [contacts[2]!, contacts[3]!],
        ]
      : [[contacts[0]!, contacts[1]!]];
  const horizon = horizonIntervals.map(([start, end]) => ({
    points: horizonLoop(
      provider,
      start,
      end,
      sampleIntervalSeconds,
      angularIntervalDegrees,
    ),
    closed: true as const,
  }));
  const extent = extentCurves(
    provider,
    contacts,
    sampleIntervalSeconds,
    angularIntervalDegrees,
  ).map((points) => ({ points }));
  const surface: PenumbralVisibilitySurface = {
    datum: "WGS 84",
    calculationFrame: "geocentric-earth-fixed",
    extent,
    horizon,
  };
  return {
    surface,
    contacts: publicContacts(contacts),
  };
}
