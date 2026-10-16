import {
  SPATIAL_METERS_PER_PARSEC, addSpatialVectors as addVectors,
  subtractSpatialVectors as subtractVectors, scaleSpatialVector as scaleVector,
  getSpatialVectorLength as vectorLength, interpolateSpatialDirections,
} from "@found-in-space/spatial";

export const EARTH_TO_GAIA_JOURNEY_ID = "earth_to_gaia" as const;
export const EARTH_TO_GAIA_DURATION_MS = 35_000;
const LEGACY_EARTH_TO_GAIA_DURATION_MS = 45_000;
export const PARSEC_METRES = SPATIAL_METERS_PER_PARSEC;
export const STELLAR_METRES_PER_PARSEC = 1;
export const STELLAR_SUN_DISTANCE_PC = 1;
export const STELLAR_SCALE_DENOMINATOR =
  PARSEC_METRES / STELLAR_METRES_PER_PARSEC;
const EARTH_REFERENCE_RADIUS_M = 6_371_008.8;
export const WHOLE_EARTH_SCALE_DENOMINATOR = EARTH_REFERENCE_RADIUS_M / 0.4;
export const BODY_FADE_START_DIAMETER_M = 0.006;
export const BODY_FADE_END_DIAMETER_M = 0.002;

export type EarthToGaiaJourneyStatus =
  | "idle"
  | "preparing"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type EarthToGaiaJourneyPhase =
  | "idle"
  | "preparing"
  | "earth"
  | "earth_scale"
  | "whole_earth"
  | "solar_scale"
  | "solar_overview"
  | "interstellar"
  | "stellar_reveal"
  | "failed";

export interface JourneyVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface EarthToGaiaTimelineContext {
  readonly startScaleDenominator: number;
  /** Exact surface-view head position after rebasing into J2000 space. */
  readonly startObserverJ2000Pc: JourneyVector3;
  /** Earth centre used to keep the departure curve outside the planet. */
  readonly earthCenterJ2000Pc: JourneyVector3;
  readonly solarOverviewScaleDenominator: number;
  /** The fixed catalogue viewpoint used to preserve the starting sky. */
  readonly catalogObserverJ2000Pc: JourneyVector3;
  /** Unit vector from the Sun toward the final observer. */
  readonly destinationDirectionJ2000: JourneyVector3;
}

export interface EarthToGaiaTimelineSample {
  readonly elapsedMs: number;
  readonly progress: number;
  readonly phase: EarthToGaiaJourneyPhase;
  readonly navigationMode: "surface" | "orbit" | "free";
  readonly realm: "solar_system" | "stellar";
  readonly scaleDenominator: number;
  readonly catalogObserverJ2000Pc: JourneyVector3;
  readonly observerJ2000Pc: JourneyVector3;
  readonly roomTranslationBlend: number;
  readonly physicalSunOpacity: number;
  readonly syntheticSunOpacity: number;
}

export interface EarthToGaiaJourneyState {
  readonly id: typeof EARTH_TO_GAIA_JOURNEY_ID;
  readonly status: EarthToGaiaJourneyStatus;
  readonly phase: EarthToGaiaJourneyPhase;
  readonly elapsedMs: number;
  readonly durationMs: typeof EARTH_TO_GAIA_DURATION_MS;
  readonly progress: number;
  readonly error: string | null;
}

export interface JourneyRunnerHooks<Snapshot, Preparation> {
  capture(): Snapshot;
  prepare(snapshot: Snapshot, signal: AbortSignal): Promise<Preparation>;
  begin(snapshot: Snapshot, preparation: Preparation): void;
  apply(
    sample: EarthToGaiaTimelineSample,
    snapshot: Snapshot,
    preparation: Preparation,
  ): void;
  restore(snapshot: Snapshot): void;
  stateChanged?(state: EarthToGaiaJourneyState): void;
}

export interface JourneyRunnerOptions<Snapshot, Preparation> {
  readonly hooks: JourneyRunnerHooks<Snapshot, Preparation>;
  readonly context: (preparation: Preparation) => EarthToGaiaTimelineContext;
  readonly now?: () => number;
}

export class JourneyRunner<Snapshot, Preparation> {
  private readonly hooks: JourneyRunnerHooks<Snapshot, Preparation>;
  private readonly context: JourneyRunnerOptions<Snapshot, Preparation>["context"];
  private readonly now: () => number;
  private snapshot: Snapshot | null = null;
  private preparation: Preparation | null = null;
  private abortController: AbortController | null = null;
  private startedAtMs = 0;
  private elapsedMs = 0;
  private generation = 0;
  private state: EarthToGaiaJourneyState = idleJourneyState();

  constructor(options: JourneyRunnerOptions<Snapshot, Preparation>) {
    this.hooks = options.hooks;
    this.context = options.context;
    this.now = options.now ?? (() => performance.now());
  }

  getState(): EarthToGaiaJourneyState {
    return { ...this.state };
  }

  isLocked(): boolean {
    return this.state.status === "preparing" ||
      this.state.status === "running" ||
      this.state.status === "paused" ||
      this.state.status === "completed";
  }

  async start(): Promise<EarthToGaiaJourneyState> {
    if (this.state.status === "preparing" || this.state.status === "running" ||
      this.state.status === "paused") {
      throw new Error("The Earth-to-Gaia journey is already active.");
    }
    let snapshot: Snapshot;
    try {
      if (this.state.status === "completed" && this.snapshot) {
        this.hooks.restore(this.snapshot);
      }
      snapshot = this.hooks.capture();
    } catch (error) {
      this.snapshot = null;
      this.preparation = null;
      this.setState({
        status: "failed",
        phase: "failed",
        elapsedMs: 0,
        progress: 0,
        error: errorMessage(error),
      });
      return this.getState();
    }
    this.abortController?.abort();
    const generation = ++this.generation;
    const abortController = new AbortController();
    this.snapshot = snapshot;
    this.preparation = null;
    this.abortController = abortController;
    this.elapsedMs = 0;
    this.setState({
      status: "preparing",
      phase: "preparing",
      elapsedMs: 0,
      progress: 0,
      error: null,
    });
    try {
      const preparation = await this.hooks.prepare(
        snapshot,
        abortController.signal,
      );
      if (generation !== this.generation || abortController.signal.aborted) {
        return this.getState();
      }
      this.preparation = preparation;
      this.abortController = null;
      this.startedAtMs = this.now();
      this.hooks.begin(snapshot, preparation);
      const sample = sampleEarthToGaiaTimeline(0, this.context(preparation));
      this.hooks.apply(sample, snapshot, preparation);
      this.setStateFromSample("running", sample, null);
    } catch (error) {
      if (generation !== this.generation || abortController.signal.aborted) {
        return this.getState();
      }
      this.abortController = null;
      this.hooks.restore(snapshot);
      this.snapshot = null;
      this.preparation = null;
      this.setState({
        status: "failed",
        phase: "failed",
        elapsedMs: 0,
        progress: 0,
        error: errorMessage(error),
      });
    }
    return this.getState();
  }

  update(nowMs = this.now()): EarthToGaiaTimelineSample | null {
    if (this.state.status !== "running" || !this.snapshot ||
      !this.preparation) return null;
    this.elapsedMs = Math.min(
      EARTH_TO_GAIA_DURATION_MS,
      Math.max(0, nowMs - this.startedAtMs),
    );
    const sample = sampleEarthToGaiaTimeline(
      this.elapsedMs,
      this.context(this.preparation),
    );
    this.hooks.apply(sample, this.snapshot, this.preparation);
    const status = sample.progress >= 1 ? "completed" : "running";
    this.setStateFromSample(status, sample, null);
    return sample;
  }

  pause(): EarthToGaiaJourneyState {
    if (this.state.status !== "running") {
      throw new Error("Only a running journey can be paused.");
    }
    this.update(this.now());
    this.setState({ status: "paused" });
    return this.getState();
  }

  resume(): EarthToGaiaJourneyState {
    if (this.state.status !== "paused") {
      throw new Error("Only a paused journey can be resumed.");
    }
    this.startedAtMs = this.now() - this.elapsedMs;
    this.setState({ status: "running" });
    return this.getState();
  }

  stop(): EarthToGaiaJourneyState {
    this.cancel(true);
    return this.getState();
  }

  cancel(restore: boolean): void {
    ++this.generation;
    this.abortController?.abort();
    this.abortController = null;
    if (restore && this.snapshot) this.hooks.restore(this.snapshot);
    this.snapshot = null;
    this.preparation = null;
    this.elapsedMs = 0;
    this.state = idleJourneyState();
    this.hooks.stateChanged?.(this.getState());
  }

  private setStateFromSample(
    status: EarthToGaiaJourneyStatus,
    sample: EarthToGaiaTimelineSample,
    error: string | null,
  ): void {
    this.setState({
      status,
      phase: sample.phase,
      elapsedMs: sample.elapsedMs,
      progress: sample.progress,
      error,
    });
  }

  private setState(
    patch: Partial<Omit<EarthToGaiaJourneyState, "id" | "durationMs">>,
  ): void {
    this.state = { ...this.state, ...patch };
    this.hooks.stateChanged?.(this.getState());
  }
}

export function idleJourneyState(): EarthToGaiaJourneyState {
  return {
    id: EARTH_TO_GAIA_JOURNEY_ID,
    status: "idle",
    phase: "idle",
    elapsedMs: 0,
    durationMs: EARTH_TO_GAIA_DURATION_MS,
    progress: 0,
    error: null,
  };
}

export function sampleEarthToGaiaTimeline(
  elapsedMs: number,
  context: EarthToGaiaTimelineContext,
): EarthToGaiaTimelineSample {
  const elapsed = clamp(elapsedMs, 0, EARTH_TO_GAIA_DURATION_MS);
  const progress = elapsed / EARTH_TO_GAIA_DURATION_MS;
  const transformProgress = journeyTransformProgress(
    elapsed,
    context.startScaleDenominator,
  );
  const solarOverviewScaleDenominator = Math.min(
    context.solarOverviewScaleDenominator,
    STELLAR_SCALE_DENOMINATOR,
  );
  const scaleDenominator = logarithmicMix(
    context.startScaleDenominator,
    STELLAR_SCALE_DENOMINATOR,
    transformProgress,
  );
  const observerJ2000Pc = interstellarObserver(context, transformProgress);
  const phase: EarthToGaiaJourneyPhase = elapsed === 0
    ? "earth"
    : scaleDenominator < WHOLE_EARTH_SCALE_DENOMINATOR
    ? "earth_scale"
    : scaleDenominator < solarOverviewScaleDenominator
    ? "solar_scale"
    : elapsed < EARTH_TO_GAIA_DURATION_MS
    ? "interstellar"
    : "stellar_reveal";
  const stellarBlend = easedRange(transformProgress, 0.82, 1);

  return {
    elapsedMs: elapsed,
    progress,
    phase,
    navigationMode: "free",
    realm: elapsed >= EARTH_TO_GAIA_DURATION_MS ? "stellar" : "solar_system",
    scaleDenominator,
    catalogObserverJ2000Pc: { ...context.catalogObserverJ2000Pc },
    observerJ2000Pc,
    roomTranslationBlend: stellarBlend,
    physicalSunOpacity: 1 - stellarBlend,
    syntheticSunOpacity: stellarBlend,
  };
}

/**
 * Keeps the established departure timing until Earth has completely faded,
 * then compresses the otherwise empty stellar tail without a velocity jump.
 */
function journeyTransformProgress(
  elapsedMs: number,
  startScaleDenominator: number,
): number {
  const earthFadeScaleDenominator =
    EARTH_REFERENCE_RADIUS_M * 2 / BODY_FADE_END_DIAMETER_M;
  const handoffProgress = logarithmicProgress(
    startScaleDenominator,
    STELLAR_SCALE_DENOMINATOR,
    earthFadeScaleDenominator,
  );
  const handoffLegacyFraction = inverseSmoothstep(handoffProgress);
  const handoffElapsedMs =
    handoffLegacyFraction * LEGACY_EARTH_TO_GAIA_DURATION_MS;
  if (elapsedMs <= handoffElapsedMs) {
    return smoothstep(
      elapsedMs / LEGACY_EARTH_TO_GAIA_DURATION_MS,
    );
  }

  const tailDurationMs = EARTH_TO_GAIA_DURATION_MS - handoffElapsedMs;
  const tailProgress = clamp(
    (elapsedMs - handoffElapsedMs) / tailDurationMs,
    0,
    1,
  );
  const incomingProgressPerMs = smoothstepDerivative(
    handoffLegacyFraction,
  ) / LEGACY_EARTH_TO_GAIA_DURATION_MS;
  return cubicHermite(
    handoffProgress,
    1,
    incomingProgressPerMs * tailDurationMs,
    0,
    tailProgress,
  );
}

export function renderedBodyOpacity(renderedDiameterM: number): number {
  if (renderedDiameterM <= BODY_FADE_END_DIAMETER_M) return 0;
  if (renderedDiameterM >= BODY_FADE_START_DIAMETER_M) return 1;
  return easedRange(
    renderedDiameterM,
    BODY_FADE_END_DIAMETER_M,
    BODY_FADE_START_DIAMETER_M,
  );
}

export function apparentMagnitude(
  absoluteMagnitude: number,
  distancePc: number,
): number {
  if (!(Number.isFinite(distancePc) && distancePc > 0)) {
    return Number.NEGATIVE_INFINITY;
  }
  return absoluteMagnitude + 5 * (Math.log10(distancePc) - 1);
}

export function observerWithRoomTranslation(
  authoredObserverPc: JourneyVector3,
  roomOffsetWorldM: JourneyVector3,
  worldToJ2000: (value: JourneyVector3) => JourneyVector3,
  roomTranslationBlend: number,
): JourneyVector3 {
  const offset = worldToJ2000(roomOffsetWorldM);
  const scale = clamp(roomTranslationBlend, 0, 1) /
    STELLAR_METRES_PER_PARSEC;
  return {
    x: authoredObserverPc.x + offset.x * scale,
    y: authoredObserverPc.y + offset.y * scale,
    z: authoredObserverPc.z + offset.z * scale,
  };
}

function interstellarObserver(
  context: EarthToGaiaTimelineContext,
  progress: number,
): JourneyVector3 {
  const earth = context.earthCenterJ2000Pc;
  const startRelativeEarth = subtractVectors(
    context.startObserverJ2000Pc,
    earth,
  );
  const destinationDirection = normalizeVector(
    context.destinationDirectionJ2000,
  );
  const finalObserver = scaleVector(
    destinationDirection,
    STELLAR_SUN_DISTANCE_PC,
  );
  const finalRelativeEarth = subtractVectors(finalObserver, earth);
  const direction = sphericalDirectionMix(
    startRelativeEarth,
    finalRelativeEarth,
    progress,
  );
  const radius = logarithmicMix(
    vectorLength(startRelativeEarth),
    vectorLength(finalRelativeEarth),
    progress,
  );
  if (progress === 1) return finalObserver;
  return addVectors(earth, scaleVector(direction, radius));
}

export function sphericalDirectionMix(
  from: JourneyVector3,
  to: JourneyVector3,
  progress: number,
): JourneyVector3 {
  const left = normalizeVector(from);
  // Retain the authored journey's antipodal arc choice while sharing the interpolation.
  const tangent = Math.abs(left.x) < 0.8
    ? normalizeVector({ x: 0, y: -left.z, z: left.y })
    : normalizeVector({ x: -left.y, y: left.x, z: 0 });
  return interpolateSpatialDirections(left, normalizeVector(to), progress, {
    antipodalTangent: tangent, antipodalCosineThreshold: -0.9995,
  });
}

function normalizeVector(value: JourneyVector3): JourneyVector3 {
  const length = vectorLength(value);
  if (!(Number.isFinite(length) && length > 0)) {
    throw new Error("Journey direction must be finite and nonzero.");
  }
  return scaleVector(value, 1 / length);
}

function logarithmicMix(from: number, to: number, progress: number): number {
  if (!(from > 0 && to > 0)) throw new Error("Logarithmic values must be positive.");
  const t = clamp(progress, 0, 1);
  if (t === 0) return from;
  if (t === 1) return to;
  return Math.exp(mix(Math.log(from), Math.log(to), t));
}

function logarithmicProgress(from: number, to: number, value: number): number {
  if (!(from > 0 && to > 0 && value > 0)) {
    throw new Error("Logarithmic journey values must be positive.");
  }
  if (from === to) return 0;
  return clamp(
    Math.log(value / from) / Math.log(to / from),
    0,
    1,
  );
}

function easedRange(value: number, from: number, to: number): number {
  const progress = clamp((value - from) / (to - from), 0, 1);
  return smoothstep(progress);
}

function smoothstep(progress: number): number {
  const value = clamp(progress, 0, 1);
  return value * value * (3 - 2 * value);
}

function smoothstepDerivative(progress: number): number {
  const value = clamp(progress, 0, 1);
  return 6 * value * (1 - value);
}

function inverseSmoothstep(progress: number): number {
  const target = clamp(progress, 0, 1);
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 52; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (smoothstep(midpoint) < target) lower = midpoint;
    else upper = midpoint;
  }
  return (lower + upper) / 2;
}

function cubicHermite(
  from: number,
  to: number,
  fromTangent: number,
  toTangent: number,
  progress: number,
): number {
  const t = clamp(progress, 0, 1);
  const tSquared = t * t;
  const tCubed = tSquared * t;
  return (2 * tCubed - 3 * tSquared + 1) * from +
    (tCubed - 2 * tSquared + t) * fromTangent +
    (-2 * tCubed + 3 * tSquared) * to +
    (tCubed - tSquared) * toTangent;
}

function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
