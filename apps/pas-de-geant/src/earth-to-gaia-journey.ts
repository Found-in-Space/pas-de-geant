export const EARTH_TO_GAIA_JOURNEY_ID = "earth_to_gaia" as const;
export const EARTH_TO_GAIA_DURATION_MS = 45_000;
export const PARSEC_METRES = 3.085677581491367e16;
export const STELLAR_METRES_PER_PARSEC = 1;
export const STELLAR_SUN_DISTANCE_PC = 1;
export const STELLAR_SCALE_DENOMINATOR =
  PARSEC_METRES / STELLAR_METRES_PER_PARSEC;
export const WHOLE_EARTH_SCALE_DENOMINATOR = 6_371_008.8 / 0.4;
export const SOLAR_OVERVIEW_SUN_DISTANCE_M = 1.8;

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
  readonly observerJ2000Pc: JourneyVector3 | null;
  readonly earthHandoffProgress: number;
  readonly solarFocusProgress: number;
  readonly roomTranslationBlend: number;
  readonly planetOpacity: number;
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

const EARTH_SCALE_DENOMINATOR = 60_000;

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
  const seconds = elapsed / 1_000;
  const progress = elapsed / EARTH_TO_GAIA_DURATION_MS;
  const solarOverviewScaleDenominator = Math.min(
    context.solarOverviewScaleDenominator,
    STELLAR_SCALE_DENOMINATOR,
  );
  let phase: EarthToGaiaJourneyPhase;
  let navigationMode: EarthToGaiaTimelineSample["navigationMode"];
  let scaleDenominator: number;
  let observerJ2000Pc: JourneyVector3 | null = null;

  if (seconds < 5) {
    phase = "earth";
    navigationMode = "surface";
    scaleDenominator = EARTH_SCALE_DENOMINATOR;
  } else if (seconds < 11) {
    phase = "earth_scale";
    navigationMode = "orbit";
    scaleDenominator = logarithmicMix(
      EARTH_SCALE_DENOMINATOR,
      WHOLE_EARTH_SCALE_DENOMINATOR,
      easedRange(seconds, 5, 11),
    );
  } else if (seconds < 15) {
    phase = "whole_earth";
    navigationMode = "orbit";
    scaleDenominator = WHOLE_EARTH_SCALE_DENOMINATOR;
  } else if (seconds < 27) {
    phase = "solar_scale";
    navigationMode = "free";
    scaleDenominator = logarithmicMix(
      WHOLE_EARTH_SCALE_DENOMINATOR,
      solarOverviewScaleDenominator,
      easedRange(seconds, 15, 27),
    );
  } else if (seconds < 32) {
    phase = "solar_overview";
    navigationMode = "free";
    scaleDenominator = solarOverviewScaleDenominator;
  } else {
    phase = seconds < 43 ? "interstellar" : "stellar_reveal";
    navigationMode = "free";
    const travel = easedRange(seconds, 32, 43);
    observerJ2000Pc = interstellarObserver(context, travel);
    const radiusPc = vectorLength(observerJ2000Pc);
    const sunDisplayM = mix(SOLAR_OVERVIEW_SUN_DISTANCE_M, 1, travel);
    scaleDenominator = travel === 0
      ? solarOverviewScaleDenominator
      : Math.min(
          STELLAR_SCALE_DENOMINATOR,
          radiusPc * PARSEC_METRES / sunDisplayM,
        );
    if (seconds >= 43) scaleDenominator = STELLAR_SCALE_DENOMINATOR;
  }

  return {
    elapsedMs: elapsed,
    progress,
    phase,
    navigationMode,
    realm: seconds >= 43 ? "stellar" : "solar_system",
    scaleDenominator,
    catalogObserverJ2000Pc: { ...context.catalogObserverJ2000Pc },
    observerJ2000Pc,
    earthHandoffProgress: easedRange(seconds, 5, 11),
    solarFocusProgress: easedRange(seconds, 15, 27),
    roomTranslationBlend: easedRange(seconds, 39, 43),
    planetOpacity: 1 - easedRange(seconds, 36, 40),
    physicalSunOpacity: 1 - easedRange(seconds, 39, 43),
    syntheticSunOpacity: easedRange(seconds, 39, 43),
  };
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
  const destinationDirection = normalizeVector(
    context.destinationDirectionJ2000,
  );
  const startRadius = Math.min(
    context.solarOverviewScaleDenominator,
    STELLAR_SCALE_DENOMINATOR,
  ) *
    SOLAR_OVERVIEW_SUN_DISTANCE_M / PARSEC_METRES;
  const radius = logarithmicMix(
    startRadius,
    STELLAR_SUN_DISTANCE_PC,
    progress,
  );
  return scaleVector(destinationDirection, radius);
}

export function safeEarthHandoffCenter(
  headWorld: JourneyVector3,
  initialCenterWorld: JourneyVector3,
  targetDirectionWorld: JourneyVector3,
  initialDisplayRadiusM: number,
  displayRadiusM: number,
  progress: number,
  finalClearanceM = 1.4,
): JourneyVector3 {
  const initialOffset = {
    x: initialCenterWorld.x - headWorld.x,
    y: initialCenterWorld.y - headWorld.y,
    z: initialCenterWorld.z - headWorld.z,
  };
  const initialDistance = vectorLength(initialOffset);
  if (!(initialDisplayRadiusM > 0 && displayRadiusM > 0)) {
    throw new Error("Earth handoff radii must be positive.");
  }
  const initialClearance = Math.max(
    0,
    initialDistance - initialDisplayRadiusM,
  );
  const direction = sphericalDirectionMix(
    initialOffset,
    targetDirectionWorld,
    progress,
  );
  const clearance = mix(
    initialClearance,
    Math.max(0, finalClearanceM),
    clamp(progress, 0, 1),
  );
  const distance = displayRadiusM + clearance;
  return {
    x: headWorld.x + direction.x * distance,
    y: headWorld.y + direction.y * distance,
    z: headWorld.z + direction.z * distance,
  };
}

export function sphericalDirectionMix(
  from: JourneyVector3,
  to: JourneyVector3,
  progress: number,
): JourneyVector3 {
  const left = normalizeVector(from);
  const right = normalizeVector(to);
  const dot = clamp(
    left.x * right.x + left.y * right.y + left.z * right.z,
    -1,
    1,
  );
  const t = clamp(progress, 0, 1);
  if (dot > 0.9995) {
    return normalizeVector({
      x: mix(left.x, right.x, t),
      y: mix(left.y, right.y, t),
      z: mix(left.z, right.z, t),
    });
  }
  if (dot < -0.9995) {
    const axis = Math.abs(left.x) < 0.8
      ? normalizeVector({ x: 0, y: -left.z, z: left.y })
      : normalizeVector({ x: -left.y, y: left.x, z: 0 });
    const angle = Math.PI * t;
    return normalizeVector({
      x: left.x * Math.cos(angle) + axis.x * Math.sin(angle),
      y: left.y * Math.cos(angle) + axis.y * Math.sin(angle),
      z: left.z * Math.cos(angle) + axis.z * Math.sin(angle),
    });
  }
  const angle = Math.acos(dot);
  const sine = Math.sin(angle);
  const leftWeight = Math.sin((1 - t) * angle) / sine;
  const rightWeight = Math.sin(t * angle) / sine;
  return normalizeVector({
    x: left.x * leftWeight + right.x * rightWeight,
    y: left.y * leftWeight + right.y * rightWeight,
    z: left.z * leftWeight + right.z * rightWeight,
  });
}

function normalizeVector(value: JourneyVector3): JourneyVector3 {
  const length = vectorLength(value);
  if (!(Number.isFinite(length) && length > 0)) {
    throw new Error("Journey direction must be finite and nonzero.");
  }
  return scaleVector(value, 1 / length);
}

function scaleVector(value: JourneyVector3, scale: number): JourneyVector3 {
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

function vectorLength(value: JourneyVector3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function logarithmicMix(from: number, to: number, progress: number): number {
  if (!(from > 0 && to > 0)) throw new Error("Logarithmic values must be positive.");
  const t = clamp(progress, 0, 1);
  if (t === 0) return from;
  if (t === 1) return to;
  return Math.exp(mix(Math.log(from), Math.log(to), t));
}

function easedRange(value: number, from: number, to: number): number {
  const progress = clamp((value - from) / (to - from), 0, 1);
  return progress * progress * (3 - 2 * progress);
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
