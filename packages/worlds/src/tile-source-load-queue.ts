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
  | "network-active"
  | "processing-queued"
  | "processing-active";

export type TileSourceLoadStage = "cache" | "network";

export interface TileSourceLoadRequest<TSource> {
  /** Stable provider-local identity used to coalesce consumers. */
  readonly key: string;
  readonly source: TSource;
  /** Larger values are started first; priority never admits extra work. */
  readonly priority?: number;
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
      /** Active acquisition/processing work only; queued time is excluded. */
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

export interface TileSourceLoadQueueOptions<
  TSource,
  TValue,
  TPayload = TValue,
> {
  /** Omit to start every admitted acquisition without a client-side limit. */
  readonly loadConcurrency?: number;
  /** Undefined is a miss. Cache errors are also treated as misses. */
  readonly loadFromCache?: (
    source: TSource,
    signal: AbortSignal,
  ) => Promise<TPayload | undefined>;
  /** Acquires the encoded/provider payload without doing bounded processing. */
  readonly loadFromNetwork: (
    source: TSource,
    signal: AbortSignal,
  ) => Promise<TPayload>;
  /** Optional conversion from an acquired payload into the usable value. */
  readonly process?: (
    source: TSource,
    payload: TPayload,
    signal: AbortSignal,
  ) => Promise<TValue>;
  /** Required when process is present. */
  readonly processingConcurrency?: number;
  readonly classifyNetworkFailure?: (
    error: unknown,
    context: TileSourceFailureContext<TSource>,
  ) => TileRequestFailureMetadata;
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
  readonly processingQueued: number;
  readonly inFlight: number;
  readonly acquisitionActive: number;
  readonly cacheActive: number;
  readonly networkActive: number;
  readonly processingActive: number;
  readonly networkAdmissionPaused: boolean;
}

interface Consumer<TValue> {
  readonly requestId: number;
  readonly observer: (event: TileSourceLoadEvent<TValue>) => void;
  active: boolean;
  inFlightNotified: boolean;
}

interface SourceJob<TSource, TValue, TPayload> {
  readonly key: string;
  readonly source: TSource;
  readonly consumers: Map<number, Consumer<TValue>>;
  readonly sequence: number;
  state: TileSourceJobState;
  priority: number;
  peakConsumerCount: number;
  activeDurationMs: number;
  controller?: AbortController;
  probe?: boolean;
  payload?: TPayload;
  payloadSource?: TileSourceLoadStage;
}

function positiveConcurrency(value: number | undefined, name: string): number {
  if (!Number.isSafeInteger(value) || value! <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value!;
}

/**
 * Provider-local, cache-first source scheduler shared by tile adapters.
 *
 * Every request is already admitted by the planner/scheduler. Acquisition and
 * processing are deliberately separate: local proxy requests can all start
 * promptly while decode or other expensive preparation remains bounded.
 */
export class TileSourceLoadQueue<TSource, TValue, TPayload = TValue> {
  private readonly circuit = new TileRequestCircuit();
  private readonly jobs = new Map<
    string,
    SourceJob<TSource, TValue, TPayload>
  >();
  private readonly consumers = new Map<number, Consumer<TValue>>();
  private readonly queue: SourceJob<TSource, TValue, TPayload>[] = [];
  private readonly listeners = new Set<
    (metrics: TileSourceLoadQueueMetrics) => void
  >();
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly loadConcurrency: number;
  private readonly processingConcurrency: number;
  private nextRequestId = 1;
  private nextSequence = 1;
  private disposed = false;
  private pumpScheduled = false;
  private networkAdmissionPaused = false;
  private requestTotal = 0;
  private sourceLoadTotal = 0;
  private cacheLookupTotal = 0;
  private cacheHitTotal = 0;
  private sharedRequestTotal = 0;
  private failureTotal = 0;
  private sourceCancellationTotal = 0;
  private cacheQueuedCount = 0;
  private networkQueuedCount = 0;
  private processingQueuedCount = 0;
  private cacheActiveCount = 0;
  private networkActiveCount = 0;
  private processingActiveCount = 0;

  constructor(
    private readonly options: TileSourceLoadQueueOptions<
      TSource,
      TValue,
      TPayload
    >,
  ) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.loadConcurrency = options.loadConcurrency === undefined
      ? Number.POSITIVE_INFINITY
      : positiveConcurrency(options.loadConcurrency, "Tile load concurrency");
    if (options.process) {
      this.processingConcurrency = positiveConcurrency(
        options.processingConcurrency,
        "Tile processing concurrency",
      );
    } else {
      this.processingConcurrency = Number.POSITIVE_INFINITY;
    }
  }

  get metrics(): TileSourceLoadQueueMetrics {
    const acquisitionActive = this.cacheActiveCount + this.networkActiveCount;
    return Object.freeze({
      requestTotal: this.requestTotal,
      sourceLoadTotal: this.sourceLoadTotal,
      cacheLookupTotal: this.cacheLookupTotal,
      cacheHitTotal: this.cacheHitTotal,
      sharedRequestTotal: this.sharedRequestTotal,
      failureTotal: this.failureTotal,
      sourceCancellationTotal: this.sourceCancellationTotal,
      queued:
        this.cacheQueuedCount + this.networkQueuedCount +
        this.processingQueuedCount,
      cacheQueued: this.cacheQueuedCount,
      networkDeferred: this.networkQueuedCount,
      processingQueued: this.processingQueuedCount,
      inFlight: acquisitionActive + this.processingActiveCount,
      acquisitionActive,
      cacheActive: this.cacheActiveCount,
      networkActive: this.networkActiveCount,
      processingActive: this.processingActiveCount,
      networkAdmissionPaused: this.networkAdmissionPaused,
    });
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
      this.sharedRequestTotal += 1;
      if (
        job.state === "network-active" ||
        (job.payloadSource === "network" &&
          (job.state === "processing-queued" ||
            job.state === "processing-active"))
      ) {
        const joinedJob = job;
        queueMicrotask(() => {
          if (
            this.jobs.get(joinedJob.key) === joinedJob &&
            joinedJob.consumers.get(requestId) === consumer &&
            (joinedJob.state === "network-active" ||
              joinedJob.payloadSource === "network")
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
        peakConsumerCount: 1,
        activeDurationMs: 0,
      };
      this.jobs.set(job.key, job);
      this.enqueue(job, initialState);
    }
    this.emit();
    // Let a synchronous planner burst coalesce and establish priority before
    // acquisition begins. No numeric client limit is applied unless requested.
    this.schedulePump();

    return Object.freeze({
      requestId,
      cancel: () => this.cancel(requestId, input.key),
    });
  }

  /** Pauses only new provider/network acquisition. */
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
      if (
        job.state === "cache-active" ||
        job.state === "network-active" ||
        job.state === "processing-active"
      ) {
        this.sourceCancellationTotal += 1;
        job.controller?.abort();
      }
      delete job.payload;
      delete job.payloadSource;
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
    if (
      job.state === "cache-queued" ||
      job.state === "network-queued" ||
      job.state === "processing-queued"
    ) {
      this.removeQueued(job);
    } else {
      // Active work owns its slot until its promise settles after abort.
      this.sourceCancellationTotal += 1;
      job.controller?.abort();
    }
    delete job.payload;
    delete job.payloadSource;
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
    this.pumpAcquisition();
    this.pumpProcessing();
  }

  private pumpAcquisition(): void {
    while (this.acquisitionActiveCount < this.loadConcurrency) {
      const cacheJob = this.selectJob("cache-queued");
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

  private pumpProcessing(): void {
    while (this.processingActiveCount < this.processingConcurrency) {
      const job = this.selectJob("processing-queued");
      if (!job) return;
      this.startProcessing(job);
    }
  }

  private get acquisitionActiveCount(): number {
    return this.cacheActiveCount + this.networkActiveCount;
  }

  private selectJob(
    state: "cache-queued" | "network-queued" | "processing-queued",
  ): SourceJob<TSource, TValue, TPayload> | undefined {
    let selected: SourceJob<TSource, TValue, TPayload> | undefined;
    for (const job of this.queue) {
      if (
        job.state !== state ||
        this.jobs.get(job.key) !== job ||
        job.consumers.size === 0
      ) continue;
      if (!selected || this.precedes(job, selected)) selected = job;
    }
    return selected;
  }

  private selectNetworkJob():
    | SourceJob<TSource, TValue, TPayload>
    | undefined {
    if (
      this.networkAdmissionPaused ||
      !this.circuit.mayStart(this.wallNow())
    ) return undefined;
    return this.selectJob("network-queued");
  }

  private precedes(
    first: SourceJob<TSource, TValue, TPayload>,
    second: SourceJob<TSource, TValue, TPayload>,
  ): boolean {
    if (first.priority !== second.priority) {
      return first.priority > second.priority;
    }
    return first.sequence < second.sequence;
  }

  private startCache(job: SourceJob<TSource, TValue, TPayload>): void {
    const loadFromCache = this.options.loadFromCache;
    if (!loadFromCache || !this.beginActive(job, "cache-active")) return;
    this.cacheLookupTotal += 1;
    const controller = job.controller!;
    const startedAt = this.now();
    let acquired = false;
    this.emit();
    let pending: Promise<TPayload | undefined>;
    try {
      pending = Promise.resolve(loadFromCache(job.source, controller.signal));
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then(
        (payload) => {
          job.activeDurationMs += Math.max(0, this.now() - startedAt);
          if (!this.isCurrent(job) || payload === undefined) return;
          acquired = true;
          this.acceptPayload(job, payload, "cache");
        },
        () => {
          job.activeDurationMs += Math.max(0, this.now() - startedAt);
          // Cache corruption/API failure is deliberately indistinguishable
          // from a miss. Network admission is decided after this settles.
        },
      )
      .finally(() => {
        this.endActive(job, "cache-active");
        if (this.isCurrent(job) && !acquired) {
          this.enqueue(job, "network-queued");
        }
        this.emit();
        this.pump();
      });
  }

  private startNetwork(
    job: SourceJob<TSource, TValue, TPayload>,
    start: TileRequestStart,
  ): void {
    if (!this.beginActive(job, "network-active")) {
      this.circuit.recordCancellation(start === "probe");
      return;
    }
    job.probe = start === "probe";
    this.sourceLoadTotal += 1;
    const controller = job.controller!;
    const startedAt = this.now();
    let circuitSettled = false;
    this.notifyJobInFlight(job, "network");
    this.emit();
    let pending: Promise<TPayload>;
    try {
      pending = Promise.resolve(
        this.options.loadFromNetwork(job.source, controller.signal),
      );
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then(
        (payload) => {
          job.activeDurationMs += Math.max(0, this.now() - startedAt);
          // Provider availability is established when acquisition succeeds;
          // content processing is a separate, tile-local concern.
          this.circuit.recordSuccess(job.probe === true);
          circuitSettled = true;
          if (!this.isCurrent(job)) return;
          this.acceptPayload(job, payload, "network");
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
        this.emit();
        this.pump();
      });
  }

  private acceptPayload(
    job: SourceJob<TSource, TValue, TPayload>,
    payload: TPayload,
    source: TileSourceLoadStage,
  ): void {
    if (!this.options.process) {
      if (source === "cache") this.cacheHitTotal += 1;
      this.completeJob(job, payload as unknown as TValue, source);
      return;
    }
    job.payload = payload;
    job.payloadSource = source;
    this.enqueue(job, "processing-queued");
  }

  private startProcessing(job: SourceJob<TSource, TValue, TPayload>): void {
    const process = this.options.process;
    const payload = job.payload;
    const source = job.payloadSource;
    if (
      !process || payload === undefined || source === undefined ||
      !this.beginActive(job, "processing-active")
    ) return;
    const controller = job.controller!;
    const startedAt = this.now();
    let retryNetwork = false;
    this.emit();
    let pending: Promise<TValue>;
    try {
      pending = Promise.resolve(process(job.source, payload, controller.signal));
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending
      .then(
        (value) => {
          job.activeDurationMs += Math.max(0, this.now() - startedAt);
          if (!this.isCurrent(job)) return;
          if (source === "cache") this.cacheHitTotal += 1;
          this.completeJob(job, value, source);
        },
        (error: unknown) => {
          job.activeDurationMs += Math.max(0, this.now() - startedAt);
          if (controller.signal.aborted && !this.isCurrent(job)) return;
          if (source === "cache") {
            retryNetwork = this.isCurrent(job);
            return;
          }
          const metadata = this.classifyFailure(error, job, controller.signal);
          if (this.isCurrent(job)) this.failJob(job, error, metadata);
        },
      )
      .finally(() => {
        this.endActive(job, "processing-active");
        delete job.payload;
        delete job.payloadSource;
        if (retryNetwork && this.isCurrent(job)) {
          this.enqueue(job, "network-queued");
        }
        this.emit();
        this.pump();
      });
  }

  private beginActive(
    job: SourceJob<TSource, TValue, TPayload>,
    state: "cache-active" | "network-active" | "processing-active",
  ): boolean {
    if (!this.isCurrent(job) || !this.removeQueued(job)) return false;
    job.state = state;
    job.controller = new AbortController();
    if (state === "cache-active") this.cacheActiveCount += 1;
    else if (state === "network-active") this.networkActiveCount += 1;
    else this.processingActiveCount += 1;
    return true;
  }

  private endActive(
    job: SourceJob<TSource, TValue, TPayload>,
    state: "cache-active" | "network-active" | "processing-active",
  ): void {
    if (state === "cache-active") {
      this.cacheActiveCount = Math.max(0, this.cacheActiveCount - 1);
    } else if (state === "network-active") {
      this.networkActiveCount = Math.max(0, this.networkActiveCount - 1);
    } else {
      this.processingActiveCount = Math.max(
        0,
        this.processingActiveCount - 1,
      );
    }
    job.controller = undefined;
  }

  private enqueue(
    job: SourceJob<TSource, TValue, TPayload>,
    state: "cache-queued" | "network-queued" | "processing-queued",
  ): void {
    job.state = state;
    this.queue.push(job);
    if (state === "cache-queued") this.cacheQueuedCount += 1;
    else if (state === "network-queued") this.networkQueuedCount += 1;
    else this.processingQueuedCount += 1;
  }

  private removeQueued(job: SourceJob<TSource, TValue, TPayload>): boolean {
    const index = this.queue.indexOf(job);
    if (index < 0) return false;
    this.queue.splice(index, 1);
    if (job.state === "cache-queued") {
      this.cacheQueuedCount = Math.max(0, this.cacheQueuedCount - 1);
    } else if (job.state === "network-queued") {
      this.networkQueuedCount = Math.max(0, this.networkQueuedCount - 1);
    } else if (job.state === "processing-queued") {
      this.processingQueuedCount = Math.max(
        0,
        this.processingQueuedCount - 1,
      );
    }
    return true;
  }

  private completeJob(
    job: SourceJob<TSource, TValue, TPayload>,
    value: TValue,
    source: TileSourceLoadStage,
  ): void {
    if (!this.isCurrent(job)) return;
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
    job: SourceJob<TSource, TValue, TPayload>,
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
    job: SourceJob<TSource, TValue, TPayload>,
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

  private isCurrent(job: SourceJob<TSource, TValue, TPayload>): boolean {
    return this.jobs.get(job.key) === job && job.consumers.size > 0;
  }

  private notifyJobInFlight(
    job: SourceJob<TSource, TValue, TPayload>,
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

  private emit(): void {
    if (this.listeners.size === 0) return;
    const metrics = this.metrics;
    for (const listener of this.listeners) listener(metrics);
  }
}
