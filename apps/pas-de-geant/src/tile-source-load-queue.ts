import {
  TileRequestCircuit,
  type TileRequestCircuitDiagnostics,
  type TileRequestFailureMetadata,
  type TileRequestStart,
} from "./tile-request-circuit.js";

export type TileSourceJobState =
  | "cache-queued"
  | "cache-active"
  | "network-queued"
  | "network-active";

export type TileSourceLoadStage = "cache" | "network";

export interface TileSourceLoadRequest<TSource> {
  /** Stable provider-local identity used to coalesce consumers. */
  readonly key: string;
  readonly source: TSource;
  /** Larger values are admitted first within the same hot/cold class. */
  readonly priority?: number;
  readonly hot?: boolean;
}

export type TileSourceLoadEvent<TValue> =
  | {
      readonly phase: "in-flight";
      readonly stage: TileSourceLoadStage;
    }
  | {
      readonly phase: "response";
      readonly value: TValue;
      readonly source: TileSourceLoadStage;
      readonly shared: boolean;
      /** Active cache/network work only; provider backoff is excluded. */
      readonly readyDurationMs: number;
    }
  | {
      readonly phase: "failure";
      readonly error: unknown;
      readonly metadata: TileRequestFailureMetadata;
    };

export interface TileSourceLoadHandle {
  readonly requestId: number;
  cancel(): void;
}

export interface TileSourceFailureContext<TSource> {
  readonly key: string;
  readonly source: TSource;
  readonly signal: AbortSignal;
}

export interface TileSourceWarmRampOptions {
  /** Concurrent speculative network jobs admitted when a ramp begins. */
  readonly initialLimit?: number;
  /** Added after each successful speculative network job. */
  readonly increment?: number;
}

export interface TileSourceLoadQueueOptions<TSource, TValue> {
  readonly concurrency: number;
  /** Undefined is a miss. Cache errors are also treated as misses. */
  readonly loadFromCache?: (
    source: TSource,
    signal: AbortSignal,
  ) => Promise<TValue | undefined>;
  /** Includes provider I/O and any decode needed before the value is usable. */
  readonly loadFromNetwork: (
    source: TSource,
    signal: AbortSignal,
  ) => Promise<TValue>;
  readonly classifyNetworkFailure?: (
    error: unknown,
    context: TileSourceFailureContext<TSource>,
  ) => TileRequestFailureMetadata;
  readonly warmRamp?: TileSourceWarmRampOptions;
  readonly initialReadyMs?: number;
  readonly readyFilterWeight?: number;
  /** Monotonic clock used for readiness durations. */
  readonly now?: () => number;
  /** Epoch clock used by Retry-After/circuit admission. */
  readonly wallNow?: () => number;
}

export interface TileSourceLoadQueueMetrics {
  readonly requestTotal: number;
  readonly sourceLoadTotal: number;
  readonly cacheLookupTotal: number;
  readonly cacheHitTotal: number;
  readonly sharedRequestTotal: number;
  readonly failureTotal: number;
  readonly sourceCancellationTotal: number;
  readonly queued: number;
  readonly cacheQueued: number;
  readonly networkDeferred: number;
  readonly inFlight: number;
  readonly cacheActive: number;
  readonly networkActive: number;
  readonly networkAdmissionPaused: boolean;
  readonly warmRampActive: boolean;
  readonly warmRampLimit: number;
  readonly estimatedReadyMs: number;
  readonly successfulReadyTotal: number;
}

interface Consumer<TValue> {
  readonly requestId: number;
  readonly observer: (event: TileSourceLoadEvent<TValue>) => void;
  active: boolean;
  inFlightNotified: boolean;
}

interface SourceJob<TSource, TValue> {
  readonly key: string;
  readonly source: TSource;
  readonly consumers: Map<number, Consumer<TValue>>;
  readonly sequence: number;
  state: TileSourceJobState;
  priority: number;
  hot: boolean;
  hotRank: number;
  peakConsumerCount: number;
  activeDurationMs: number;
  controller?: AbortController;
  probe?: boolean;
  warmRamp?: boolean;
}

const DEFAULT_ESTIMATED_READY_MS = 750;
const DEFAULT_READY_FILTER_WEIGHT = 0.15;

/**
 * Provider-local, cache-first source scheduler shared by tile adapters.
 *
 * Demand is deliberately checked only when a cache miss reaches the network
 * queue. Active work owns its concurrency slot until its promise settles,
 * even when the final consumer cancels and the request is aborted.
 */
export class TileSourceLoadQueue<TSource, TValue> {
  private readonly circuit = new TileRequestCircuit();
  private readonly jobs = new Map<string, SourceJob<TSource, TValue>>();
  private readonly consumers = new Map<number, Consumer<TValue>>();
  private readonly queue: SourceJob<TSource, TValue>[] = [];
  private readonly listeners = new Set<
    (metrics: TileSourceLoadQueueMetrics) => void
  >();
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly readyFilterWeight: number;
  private readonly warmRampInitialLimit: number;
  private readonly warmRampIncrement: number;
  private nextRequestId = 1;
  private nextSequence = 1;
  private disposed = false;
  private pumpScheduled = false;
  private prioritySourceRanks = new Map<string, number>();
  private demandedSourceKeys: ReadonlySet<string> | undefined;
  private networkAdmissionPaused = false;
  private warmRampActive = false;
  private warmRampLimit: number;
  private warmRampInFlight = 0;
  private estimatedReadyMsValue: number;
  private successfulReadyTotal = 0;
  private requestTotal = 0;
  private sourceLoadTotal = 0;
  private cacheLookupTotal = 0;
  private cacheHitTotal = 0;
  private sharedRequestTotal = 0;
  private failureTotal = 0;
  private sourceCancellationTotal = 0;
  private cacheQueuedCount = 0;
  private networkQueuedCount = 0;
  private cacheActiveCount = 0;
  private networkActiveCount = 0;
  private activeSlotCount = 0;

  constructor(
    private readonly options: TileSourceLoadQueueOptions<TSource, TValue>,
  ) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.readyFilterWeight =
      options.readyFilterWeight ?? DEFAULT_READY_FILTER_WEIGHT;
    this.estimatedReadyMsValue =
      options.initialReadyMs ?? DEFAULT_ESTIMATED_READY_MS;
    this.warmRampInitialLimit = options.warmRamp?.initialLimit ?? 1;
    this.warmRampIncrement = options.warmRamp?.increment ?? 1;
    this.warmRampLimit = options.concurrency;
  }

  get metrics(): TileSourceLoadQueueMetrics {
    return Object.freeze({
      requestTotal: this.requestTotal,
      sourceLoadTotal: this.sourceLoadTotal,
      cacheLookupTotal: this.cacheLookupTotal,
      cacheHitTotal: this.cacheHitTotal,
      sharedRequestTotal: this.sharedRequestTotal,
      failureTotal: this.failureTotal,
      sourceCancellationTotal: this.sourceCancellationTotal,
      queued: this.cacheQueuedCount + this.networkQueuedCount,
      cacheQueued: this.cacheQueuedCount,
      networkDeferred: this.networkQueuedCount,
      inFlight: this.activeSlotCount,
      cacheActive: this.cacheActiveCount,
      networkActive: this.networkActiveCount,
      networkAdmissionPaused: this.networkAdmissionPaused,
      warmRampActive: this.warmRampActive,
      warmRampLimit: this.warmRampLimit,
      estimatedReadyMs: this.estimatedReadyMsValue,
      successfulReadyTotal: this.successfulReadyTotal,
    });
  }

  /** Current successful cache/network readiness estimate without allocating. */
  get estimatedReadyMs(): number {
    return this.estimatedReadyMsValue;
  }

  get retryDiagnostics(): TileRequestCircuitDiagnostics {
    return this.circuit.diagnostics;
  }

  request(
    input: TileSourceLoadRequest<TSource>,
    observer: (event: TileSourceLoadEvent<TValue>) => void,
  ): TileSourceLoadHandle {
    const requestId = this.nextRequestId++;
    if (this.disposed) {
      queueMicrotask(() => observer({
        phase: "failure",
        error: new Error("Tile source load queue is disposed."),
        metadata: { systemic: false, retryable: false },
      }));
      return Object.freeze({ requestId, cancel() {} });
    }

    this.requestTotal += 1;
    const consumer: Consumer<TValue> = {
      requestId,
      observer,
      active: true,
      inFlightNotified: false,
    };
    this.consumers.set(requestId, consumer);

    let job = this.jobs.get(input.key);
    if (job) {
      job.consumers.set(requestId, consumer);
      job.peakConsumerCount = Math.max(
        job.peakConsumerCount,
        job.consumers.size,
      );
      job.priority = Math.max(job.priority, input.priority ?? 0);
      job.hot =
        job.hot || input.hot === true || this.prioritySourceRanks.has(job.key);
      job.hotRank = Math.max(
        job.hotRank,
        this.prioritySourceRanks.get(job.key) ?? (input.hot ? 0 : -1),
      );
      this.sharedRequestTotal += 1;
      if (job.state === "network-active") {
        const joinedJob = job;
        queueMicrotask(() => {
          if (
            this.jobs.get(joinedJob.key) === joinedJob &&
            joinedJob.consumers.get(requestId) === consumer &&
            joinedJob.state === "network-active"
          ) {
            this.notifyInFlight(consumer, "network");
          }
        });
      }
    } else {
      const initialState = this.options.loadFromCache
        ? "cache-queued"
        : "network-queued";
      job = {
        key: input.key,
        source: input.source,
        consumers: new Map([[requestId, consumer]]),
        sequence: this.nextSequence++,
        state: initialState,
        priority: input.priority ?? 0,
        hot: input.hot === true || this.prioritySourceRanks.has(input.key),
        hotRank:
          this.prioritySourceRanks.get(input.key) ?? (input.hot ? 0 : -1),
        peakConsumerCount: 1,
        activeDurationMs: 0,
      };
      this.jobs.set(job.key, job);
      this.enqueue(job, initialState);
    }
    this.emit();
    // Defer the first pump so a synchronous cut burst can coalesce and be
    // ordered before it consumes provider slots. Both payload paths use this
    // same non-reentrant start behavior.
    this.schedulePump();

    return Object.freeze({
      requestId,
      cancel: () => this.cancel(requestId, input.key),
    });
  }

  /** Replaces the hot source set; request priority remains a stable tie-break. */
  updatePriority(sourceKeys: Iterable<string>): void {
    const ordered = [...sourceKeys];
    const ranks = new Map<string, number>();
    for (let index = 0; index < ordered.length; index += 1) {
      if (!ranks.has(ordered[index]!)) {
        ranks.set(ordered[index]!, ordered.length - index);
      }
    }
    this.prioritySourceRanks = ranks;
    for (const job of this.jobs.values()) {
      job.hot = ranks.has(job.key);
      job.hotRank = ranks.get(job.key) ?? -1;
    }
    this.pump();
  }

  /** Undefined clears the gate. Cache work is never filtered by this set. */
  updateDemand(sourceKeys?: Iterable<string>): void {
    this.demandedSourceKeys = sourceKeys === undefined
      ? undefined
      : new Set(sourceKeys);
    this.pump();
  }

  /** Pauses only new provider/network work. */
  pauseNetwork(): void {
    this.networkAdmissionPaused = true;
    this.emit();
  }

  /** Called after provider backoff; the circuit still enforces one probe. */
  resumeDeferred(): void {
    this.networkAdmissionPaused = false;
    this.emit();
    this.pump();
  }

  /**
   * Arms additive speculative admission. The next priority/demand update or
   * request pumps the queue, so callers can demote stale forecast work first.
   */
  beginWarmRamp(): void {
    if (!this.options.warmRamp) return;
    this.warmRampActive = true;
    this.warmRampLimit = this.warmRampInitialLimit;
    this.emit();
    // Runtime admission updates synchronously after arming. If that plan adds
    // no jobs, close here so an unrelated later burst is not stale-throttled.
    queueMicrotask(() => {
      if (!this.disposed && this.closeWarmRampIfIdle()) this.emit();
    });
  }

  endWarmRamp(): void {
    if (!this.warmRampActive) return;
    this.warmRampActive = false;
    this.warmRampLimit = this.options.concurrency;
    this.emit();
    this.pump();
  }

  subscribe(
    listener: (metrics: TileSourceLoadQueueMetrics) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.metrics);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of [...this.queue]) this.removeQueued(job);
    for (const job of this.jobs.values()) {
      if (job.state === "cache-active" || job.state === "network-active") {
        this.sourceCancellationTotal += 1;
        job.controller?.abort();
      }
    }
    this.jobs.clear();
    for (const consumer of this.consumers.values()) consumer.active = false;
    this.consumers.clear();
    this.emit();
    this.listeners.clear();
  }

  private cancel(requestId: number, sourceKey: string): void {
    const consumer = this.consumers.get(requestId);
    if (!consumer?.active) return;
    consumer.active = false;
    this.consumers.delete(requestId);
    const job = this.jobs.get(sourceKey);
    if (!job || job.consumers.get(requestId) !== consumer) {
      this.emit();
      return;
    }
    job.consumers.delete(requestId);
    if (job.consumers.size > 0) {
      this.emit();
      return;
    }

    this.jobs.delete(job.key);
    if (job.state === "cache-queued" || job.state === "network-queued") {
      this.removeQueued(job);
    } else {
      // The slot and half-open probe remain owned until the promise settles.
      this.sourceCancellationTotal += 1;
      job.controller?.abort();
    }
    this.closeWarmRampIfIdle();
    this.emit();
    this.pump();
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.disposed) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.activeSlotCount < this.options.concurrency) {
      const cacheJob = this.selectCacheJob();
      const networkJob = this.selectNetworkJob();
      if (
        cacheJob &&
        (!networkJob || this.precedes(cacheJob, networkJob))
      ) {
        this.startCache(cacheJob);
        continue;
      }
      if (!networkJob) return;
      const start = this.circuit.tryStart(this.wallNow());
      if (!start) return;
      this.startNetwork(networkJob, start);
    }
  }

  private selectCacheJob(): SourceJob<TSource, TValue> | undefined {
    let selected: SourceJob<TSource, TValue> | undefined;
    for (const job of this.queue) {
      if (
        job.state !== "cache-queued" ||
        this.jobs.get(job.key) !== job ||
        job.consumers.size === 0
      ) continue;
      if (!selected || this.precedes(job, selected)) selected = job;
    }
    return selected;
  }

  private selectNetworkJob(): SourceJob<TSource, TValue> | undefined {
    if (
      this.networkAdmissionPaused ||
      !this.circuit.mayStart(this.wallNow())
    ) return undefined;
    let selected: SourceJob<TSource, TValue> | undefined;
    for (const job of this.queue) {
      if (
        job.state !== "network-queued" ||
        this.jobs.get(job.key) !== job ||
        job.consumers.size === 0 ||
        (this.demandedSourceKeys !== undefined &&
          !this.demandedSourceKeys.has(job.key)) ||
        (this.warmRampActive &&
          !job.hot &&
          this.warmRampInFlight >= this.warmRampLimit)
      ) continue;
      if (!selected || this.precedes(job, selected)) selected = job;
    }
    return selected;
  }

  private precedes(
    first: SourceJob<TSource, TValue>,
    second: SourceJob<TSource, TValue>,
  ): boolean {
    const firstDemanded =
      this.demandedSourceKeys === undefined ||
      this.demandedSourceKeys.has(first.key);
    const secondDemanded =
      this.demandedSourceKeys === undefined ||
      this.demandedSourceKeys.has(second.key);
    if (firstDemanded !== secondDemanded) return firstDemanded;
    if (first.hot !== second.hot) return first.hot;
    if (first.hotRank !== second.hotRank) return first.hotRank > second.hotRank;
    if (first.priority !== second.priority) {
      return first.priority > second.priority;
    }
    return first.sequence < second.sequence;
  }

  private startCache(job: SourceJob<TSource, TValue>): void {
    const loadFromCache = this.options.loadFromCache;
    if (!loadFromCache || !this.beginActive(job, "cache-active")) return;
    this.cacheLookupTotal += 1;
    const controller = job.controller!;
    const startedAt = this.now();
    this.emit();
    let pending: Promise<TValue | undefined>;
    try {
      pending = Promise.resolve(loadFromCache(job.source, controller.signal));
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then(
        (value) => {
          const elapsed = Math.max(0, this.now() - startedAt);
          job.activeDurationMs += elapsed;
          if (!this.isCurrent(job)) return;
          if (value === undefined) return;
          this.cacheHitTotal += 1;
          this.completeJob(job, value, "cache");
        },
        () => {
          job.activeDurationMs += Math.max(0, this.now() - startedAt);
          // Cache corruption/API failure is deliberately indistinguishable
          // from a miss. Network admission is decided after this settles.
        },
      )
      .finally(() => {
        this.endActive(job, "cache-active");
        if (this.isCurrent(job)) this.enqueue(job, "network-queued");
        this.closeWarmRampIfIdle();
        this.emit();
        this.pump();
      });
  }

  private startNetwork(
    job: SourceJob<TSource, TValue>,
    start: TileRequestStart,
  ): void {
    if (!this.beginActive(job, "network-active")) {
      this.circuit.recordCancellation(start === "probe");
      return;
    }
    job.probe = start === "probe";
    job.warmRamp = this.warmRampActive && !job.hot;
    if (job.warmRamp) this.warmRampInFlight += 1;
    this.sourceLoadTotal += 1;
    const controller = job.controller!;
    const startedAt = this.now();
    let circuitSettled = false;
    let deliveredSuccess = false;
    this.notifyJobInFlight(job, "network");
    this.emit();
    let pending: Promise<TValue>;
    try {
      pending = Promise.resolve(
        this.options.loadFromNetwork(job.source, controller.signal),
      );
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then(
        (value) => {
          job.activeDurationMs += Math.max(0, this.now() - startedAt);
          this.circuit.recordSuccess(job.probe === true);
          circuitSettled = true;
          if (!this.isCurrent(job)) return;
          deliveredSuccess = true;
          this.completeJob(job, value, "network");
        },
        (error: unknown) => {
          job.activeDurationMs += Math.max(0, this.now() - startedAt);
          if (controller.signal.aborted && !this.isCurrent(job)) {
            this.circuit.recordCancellation(job.probe === true);
            circuitSettled = true;
            return;
          }
          const metadata = this.classifyFailure(error, job, controller.signal);
          const tripped = this.circuit.recordFailure(
            metadata,
            job.probe === true,
            this.wallNow(),
          );
          circuitSettled = true;
          if (tripped) this.networkAdmissionPaused = true;
          if (this.isCurrent(job)) this.failJob(job, error, metadata);
        },
      )
      .finally(() => {
        if (!circuitSettled) {
          this.circuit.recordCancellation(job.probe === true);
        }
        this.endActive(job, "network-active");
        if (job.warmRamp) {
          this.warmRampInFlight = Math.max(0, this.warmRampInFlight - 1);
          if (deliveredSuccess) this.advanceWarmRamp();
        }
        this.closeWarmRampIfIdle();
        this.emit();
        this.pump();
      });
  }

  private beginActive(
    job: SourceJob<TSource, TValue>,
    state: "cache-active" | "network-active",
  ): boolean {
    if (!this.isCurrent(job) || !this.removeQueued(job)) return false;
    job.state = state;
    job.controller = new AbortController();
    this.activeSlotCount += 1;
    if (state === "cache-active") this.cacheActiveCount += 1;
    else this.networkActiveCount += 1;
    return true;
  }

  private endActive(
    job: SourceJob<TSource, TValue>,
    state: "cache-active" | "network-active",
  ): void {
    this.activeSlotCount = Math.max(0, this.activeSlotCount - 1);
    if (state === "cache-active") {
      this.cacheActiveCount = Math.max(0, this.cacheActiveCount - 1);
    } else {
      this.networkActiveCount = Math.max(0, this.networkActiveCount - 1);
    }
    job.controller = undefined;
  }

  private enqueue(
    job: SourceJob<TSource, TValue>,
    state: "cache-queued" | "network-queued",
  ): void {
    job.state = state;
    this.queue.push(job);
    if (state === "cache-queued") this.cacheQueuedCount += 1;
    else this.networkQueuedCount += 1;
  }

  private removeQueued(job: SourceJob<TSource, TValue>): boolean {
    const index = this.queue.indexOf(job);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    if (job.state === "cache-queued") {
      this.cacheQueuedCount = Math.max(0, this.cacheQueuedCount - 1);
    } else if (job.state === "network-queued") {
      this.networkQueuedCount = Math.max(0, this.networkQueuedCount - 1);
    }
    return true;
  }

  private completeJob(
    job: SourceJob<TSource, TValue>,
    value: TValue,
    source: TileSourceLoadStage,
  ): void {
    if (!this.isCurrent(job)) return;
    this.recordReady(job.activeDurationMs);
    this.jobs.delete(job.key);
    const shared = job.peakConsumerCount > 1;
    for (const consumer of job.consumers.values()) {
      if (!consumer.active) continue;
      consumer.active = false;
      this.consumers.delete(consumer.requestId);
      this.notify(consumer, {
        phase: "response",
        value,
        source,
        shared,
        readyDurationMs: job.activeDurationMs,
      });
    }
    job.consumers.clear();
  }

  private failJob(
    job: SourceJob<TSource, TValue>,
    error: unknown,
    metadata: TileRequestFailureMetadata,
  ): void {
    if (!this.isCurrent(job)) return;
    this.failureTotal += 1;
    this.jobs.delete(job.key);
    for (const consumer of job.consumers.values()) {
      if (!consumer.active) continue;
      consumer.active = false;
      this.consumers.delete(consumer.requestId);
      this.notify(consumer, { phase: "failure", error, metadata });
    }
    job.consumers.clear();
  }

  private classifyFailure(
    error: unknown,
    job: SourceJob<TSource, TValue>,
    signal: AbortSignal,
  ): TileRequestFailureMetadata {
    try {
      return this.options.classifyNetworkFailure?.(error, {
        key: job.key,
        source: job.source,
        signal,
      }) ?? { systemic: true };
    } catch {
      return { systemic: true };
    }
  }

  private isCurrent(job: SourceJob<TSource, TValue>): boolean {
    return this.jobs.get(job.key) === job && job.consumers.size > 0;
  }

  private notifyJobInFlight(
    job: SourceJob<TSource, TValue>,
    stage: TileSourceLoadStage,
  ): void {
    for (const consumer of job.consumers.values()) {
      this.notifyInFlight(consumer, stage);
    }
  }

  private notifyInFlight(
    consumer: Consumer<TValue>,
    stage: TileSourceLoadStage,
  ): void {
    if (!consumer.active || consumer.inFlightNotified) return;
    consumer.inFlightNotified = true;
    this.notify(consumer, { phase: "in-flight", stage });
  }

  private notify(
    consumer: Consumer<TValue>,
    event: TileSourceLoadEvent<TValue>,
  ): void {
    try {
      consumer.observer(event);
    } catch {
      // A consumer callback cannot strand shared queue/circuit state.
    }
  }

  private recordReady(durationMs: number): void {
    this.successfulReadyTotal += 1;
    this.estimatedReadyMsValue +=
      (durationMs - this.estimatedReadyMsValue) * this.readyFilterWeight;
  }

  private advanceWarmRamp(): void {
    this.warmRampLimit = Math.min(
      this.options.concurrency,
      this.warmRampLimit + this.warmRampIncrement,
    );
    if (this.warmRampLimit >= this.options.concurrency) {
      this.warmRampActive = false;
    }
  }

  private closeWarmRampIfIdle(): boolean {
    if (
      !this.warmRampActive ||
      this.jobs.size > 0 ||
      this.activeSlotCount > 0
    ) return false;
    this.warmRampActive = false;
    this.warmRampLimit = this.options.concurrency;
    return true;
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const metrics = this.metrics;
    for (const listener of this.listeners) listener(metrics);
  }
}
