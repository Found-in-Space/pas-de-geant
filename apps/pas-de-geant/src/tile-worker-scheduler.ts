import {
  normalizeTileLayoutTarget,
  type TileLayoutTarget,
} from "./tile-layout-source.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";
import type {
  SchedulerEvent,
  SchedulerSnapshot,
} from "./tile-transition-scheduler.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "./tile-provider.js";
import type { TileRequestCircuitDiagnostics } from "./tile-request-circuit.js";
import type {
  TileSchedulerCommand,
  TileSchedulerMessage,
} from "./tile-scheduler-protocol.js";

export interface TileSchedulerWorker {
  postMessage(message: TileSchedulerCommand): void;
  onmessage: ((event: MessageEvent<TileSchedulerMessage>) => void) | null;
  terminate(): void;
}

export interface TileWorkerSchedulerOptions<Resource> {
  readonly createWorker?: () => TileSchedulerWorker;
  readonly provider: TileProvider<Resource>;
  /** Base retry cadence for transient provider failures. */
  readonly retryDelayMs?: number;
  /** When set above the base cadence, failed retry rounds back off to this. */
  readonly retryMaxDelayMs?: number;
  /** Random source used to desynchronise exponential retries. */
  readonly retryRandom?: () => number;
}

export interface TileWorkerSchedulerRequestCounts {
  readonly requested: number;
  readonly in_flight: number;
  readonly total_outstanding: number;
}

export interface TileWorkerSchedulerDebugState {
  readonly planner_requests: TileWorkerSchedulerRequestCounts;
  readonly resident_payload_count: number;
  readonly working_set_payload_count: number;
  readonly horizon_candidate_count: number;
  readonly resource_releases: {
    readonly total: number;
    readonly discard: number;
    readonly cancel: number;
    readonly eviction: number;
  };
  readonly target_submission: {
    readonly pending: boolean;
    readonly in_flight: boolean;
  };
  readonly retry: {
    readonly failed_rounds: number;
    readonly scheduled_delay_ms: number | null;
    readonly scheduled_at_ms: number | null;
    readonly automatic_retry_enabled: boolean;
    readonly last_status: number | null;
    readonly circuit: TileRequestCircuitDiagnostics | null;
  };
}

interface ActiveBridgeRequest {
  readonly requestId: number;
  readonly tile: TileIdentity;
  workerOwned: boolean;
  waitingWorkerRequestIds?: Set<number>;
  phase: "requested" | "in-flight";
  /** Invalidates callbacks from a cancelled/replaced provider attempt. */
  providerAttempt: number;
  handle?: TileRequestHandle;
}

/** Largest delay browsers reliably represent without signed-32-bit overflow. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function initialSnapshot(
  target: TileLayoutTarget,
): SchedulerSnapshot<TileLayoutTarget> {
  return Object.freeze({
    revision: -1,
    target: Object.freeze({ ...target }),
    committedCut: Object.freeze([]),
    requestedCut: Object.freeze([]),
    graph: Object.freeze({
      retained: Object.freeze([]),
      groups: Object.freeze([]),
      batches: Object.freeze([]),
    }),
    requirements: Object.freeze([]),
  });
}

/**
 * Main-thread resource bridge for a tile-transition worker. The worker owns
 * all cut calculation and transition state; image resources never cross it.
 */
export class TileWorkerScheduler<Resource> {
  private readonly worker: TileSchedulerWorker;
  private readonly listeners = new Set<
    (snapshot: SchedulerSnapshot<TileLayoutTarget>, event?: SchedulerEvent) => void
  >();
  private readonly requests = new Map<string, ActiveBridgeRequest>();
  private readonly resources = new Map<string, Resource>();
  private readonly plannerFailureKeys = new Set<string>();
  private horizonCandidates = new Map<string, TileIdentity>();
  private horizonRevision = Number.NEGATIVE_INFINITY;
  private pendingTarget: TileLayoutTarget | undefined;
  private targetInFlight = false;
  private targetFlushQueued = false;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempt = 0;
  private retryScheduledDelayMs: number | undefined;
  private retryScheduledAtMs: number | undefined;
  private automaticRetryEnabled = true;
  private lastFailureStatus: number | undefined;
  private readonly resourceReleaseCounts = {
    discard: 0,
    cancel: 0,
    eviction: 0,
  };
  private snapshotValue: SchedulerSnapshot<TileLayoutTarget>;

  constructor(
    initialTarget: TileLayoutTarget,
    private readonly options: TileWorkerSchedulerOptions<Resource>,
  ) {
    const normalizedInitialTarget = normalizeTileLayoutTarget(initialTarget);
    this.snapshotValue = initialSnapshot(normalizedInitialTarget);
    this.worker =
      options.createWorker?.() ??
      new Worker(new URL("./tile-scheduler.worker.ts", import.meta.url), {
        type: "module",
      });
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.postMessage({
      kind: "initialize",
      target: normalizedInitialTarget,
    });
  }

  get snapshot(): SchedulerSnapshot<TileLayoutTarget> {
    return this.snapshotValue;
  }

  get debugState(): TileWorkerSchedulerDebugState {
    let requested = 0;
    let inFlight = 0;
    for (const request of this.requests.values()) {
      if (request.phase === "in-flight") inFlight += 1;
      else requested += 1;
    }
    const plannerRequests = {
      requested,
      in_flight: inFlight,
      total_outstanding: requested + inFlight,
    };
    return {
      planner_requests: plannerRequests,
      resident_payload_count: this.resources.size,
      working_set_payload_count: this.workingSetKeys().size,
      horizon_candidate_count: this.horizonCandidates.size,
      resource_releases: {
        total:
          this.resourceReleaseCounts.discard +
          this.resourceReleaseCounts.cancel +
          this.resourceReleaseCounts.eviction,
        ...this.resourceReleaseCounts,
      },
      target_submission: {
        pending: this.pendingTarget !== undefined,
        in_flight: this.targetInFlight,
      },
      retry: {
        failed_rounds: this.retryAttempt,
        scheduled_delay_ms: this.retryScheduledDelayMs ?? null,
        scheduled_at_ms: this.retryScheduledAtMs ?? null,
        automatic_retry_enabled: this.automaticRetryEnabled,
        last_status: this.lastFailureStatus ?? null,
        circuit: this.options.provider.retryDiagnostics ?? null,
      },
    };
  }

  subscribe(
    listener: (
      snapshot: SchedulerSnapshot<TileLayoutTarget>,
      event?: SchedulerEvent,
    ) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.snapshotValue);
    return () => this.listeners.delete(listener);
  }

  committedResource(tile: TileIdentity): Resource | undefined {
    return this.resources.get(tileIdentityKey(tile));
  }

  /** The horizon-retained planner generation plus active replacement work. */
  get workingSetTiles(): readonly TileIdentity[] {
    const tiles = new Map(this.horizonCandidates);
    for (const { tile } of this.snapshotValue.requirements) {
      tiles.set(tileIdentityKey(tile), tile);
    }
    return [...tiles.values()];
  }

  /** Applies geometric horizon culling to worker-owned planner candidates. */
  updateHorizonCulling(retainedTiles: Iterable<TileIdentity>): void {
    if (this.disposed) return;
    const tiles = [...retainedTiles];
    const retained = new Map<string, TileIdentity>(
      tiles.map((tile) => [tileIdentityKey(tile), tile] as const),
    );
    if (
      this.horizonRevision === this.snapshotValue.revision &&
      retained.size === this.horizonCandidates.size &&
      [...retained.keys()].every((key) => this.horizonCandidates.has(key))
    ) return;
    this.horizonCandidates = retained;
    this.horizonRevision = this.snapshotValue.revision;
    this.worker.postMessage({
      kind: "horizon-culling",
      revision: this.horizonRevision,
      tiles,
    });
    if (this.retainWorkingSetResources()) this.notifyResourceChange();
  }

  updateTarget(target: TileLayoutTarget): void {
    const normalized = normalizeTileLayoutTarget(target);
    if (
      this.pendingTarget &&
      this.sameTarget(this.pendingTarget, normalized)
    ) return;
    if (
      !this.targetInFlight &&
      this.sameTarget(this.snapshotValue.target, normalized)
    ) return;
    this.pendingTarget = normalized;
    this.flushTarget();
  }

  retryFailed(): void {
    if (this.disposed) return;
    if (
      this.retryScheduledAtMs !== undefined &&
      Date.now() < this.retryScheduledAtMs
    ) return;
    this.performRetry();
  }

  private performRetry(): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryScheduledDelayMs = undefined;
    this.retryScheduledAtMs = undefined;
    this.options.provider.resumeDeferred?.();
    if (!this.automaticRetryEnabled) return;
    this.worker.postMessage({ kind: "retry" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of this.requests.values()) {
      this.cancelProviderAttempt(request);
    }
    this.requests.clear();
    this.resources.clear();
    this.plannerFailureKeys.clear();
    this.listeners.clear();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryScheduledDelayMs = undefined;
    this.retryScheduledAtMs = undefined;
    this.worker.terminate();
  }

  private handleMessage(message: TileSchedulerMessage): void {
    if (this.disposed) return;
    if (message.kind === "resource-request")
      return this.requestResource(message);
    if (message.kind === "resource-cancel")
      return this.cancelResource(message.key, message.requestId);
    if (message.kind === "target-applied") {
      if (!this.sameTarget(this.snapshotValue.target, message.target)) {
        this.snapshotValue = Object.freeze({
          ...this.snapshotValue,
          target: Object.freeze({ ...message.target }),
        });
      }
      this.targetInFlight = false;
      this.flushTarget();
      return;
    }
    if (message.kind === "event") {
      if (message.event.revision < this.snapshotValue.revision) return;
      if (message.event.tile) {
        const key = tileIdentityKey(message.event.tile);
        if (message.event.kind === "failure") {
          this.plannerFailureKeys.add(key);
        } else if (
          message.event.kind === "response" ||
          message.event.kind === "cancellation" ||
          message.event.kind === "discard"
        ) {
          this.plannerFailureKeys.delete(key);
        }
      }
      if (message.event.kind === "discard" && message.event.tile) {
        this.releaseResource(
          tileIdentityKey(message.event.tile),
          "discard",
        );
      }
      for (const listener of this.listeners)
        listener(this.snapshotValue, message.event);
      if (message.event.kind === "failure")
        this.scheduleRetry(message.event);
      if (message.event.kind === "response")
        this.resetRetryIfSatisfied();
      return;
    }
    if (message.snapshot.revision < this.snapshotValue.revision) return;
    this.snapshotValue = message.snapshot;
    this.plannerFailureKeys.clear();
    for (const requirement of message.snapshot.requirements) {
      if (requirement.state === "failed") {
        this.plannerFailureKeys.add(tileIdentityKey(requirement.tile));
      }
    }
    this.retainWorkingSetResources();
    this.resetRetryIfSatisfied();
    for (const listener of this.listeners)
      listener(this.snapshotValue, message.event);
  }

  private sameTarget(
    first: TileLayoutTarget,
    second: TileLayoutTarget,
  ): boolean {
    return first.maxZoom === second.maxZoom &&
      first.latitudeDegrees === second.latitudeDegrees &&
      first.longitudeDegrees === second.longitudeDegrees;
  }

  private requestResource(
    message: Extract<TileSchedulerMessage, { kind: "resource-request" }>,
  ): void {
    if (this.resources.has(message.key)) {
      this.worker.postMessage({
        kind: "resource-result",
        key: message.key,
        requestId: message.requestId,
        result: { phase: "response", resource: undefined },
      });
      return;
    }
    const old = this.requests.get(message.key);
    if (old) {
      if (
        (old.workerOwned && old.requestId === message.requestId) ||
        old.waitingWorkerRequestIds?.has(message.requestId)
      ) return;
      old.waitingWorkerRequestIds ??= new Set();
      old.waitingWorkerRequestIds.add(message.requestId);
      if (old.phase === "in-flight") {
        this.postWorkerResourceResult(
          message.key,
          message.requestId,
          { phase: "in-flight" },
        );
      }
      return;
    }
    const provisional: ActiveBridgeRequest = {
      requestId: message.requestId,
      tile: message.tile,
      workerOwned: true,
      phase: "requested",
      providerAttempt: 0,
    };
    this.requests.set(message.key, provisional);
    this.startProviderRequest(message.key, provisional);
  }

  private startProviderRequest(
    key: string,
    request: ActiveBridgeRequest,
  ): void {
    if (this.disposed || this.requests.get(key) !== request) return;
    request.phase = "requested";
    const primaryRequestId = request.requestId;
    const providerAttempt = ++request.providerAttempt;
    const handle = this.options.provider.request(request.tile, (result) => {
      const active = this.requests.get(key);
      if (active !== request || active.requestId !== primaryRequestId ||
        active.providerAttempt !== providerAttempt ||
        this.disposed) return;
      const hasWorkerRecipient = active.workerOwned ||
        (active.waitingWorkerRequestIds?.size ?? 0) > 0;
      let retainedResponse = false;
      if (result.phase === "in-flight") {
        active.phase = "in-flight";
      } else if (result.phase === "response") {
        retainedResponse = hasWorkerRecipient;
        if (retainedResponse) this.resources.set(key, result.resource);
        this.resetRetryIfSatisfied();
      } else {
        // Retry ownership follows an attempted provider failure, not delivery
        // to a worker observer that may already have been cancelled.
        this.scheduleRetry(result);
      }
      const workerResult = result.phase === "response"
        ? { phase: "response" as const, resource: undefined }
        : result;
      if (active.workerOwned) {
        this.postWorkerResourceResult(key, primaryRequestId, workerResult);
      }
      if (active.waitingWorkerRequestIds) {
        for (const requestId of active.waitingWorkerRequestIds) {
          this.postWorkerResourceResult(key, requestId, workerResult);
        }
      }
      if (result.phase === "in-flight") return;
      this.requests.delete(key);
      if (
        result.phase === "response" &&
        retainedResponse &&
        !hasWorkerRecipient
      ) {
        this.notifyResourceChange();
      }
    });
    if (
      this.requests.get(key) === request &&
      request.providerAttempt === providerAttempt
    ) request.handle = handle;
  }

  private cancelResource(key: string, requestId: number): void {
    const active = this.requests.get(key);
    if (!active) return;
    if (active.requestId !== requestId || !active.workerOwned) {
      const removed = active.waitingWorkerRequestIds?.delete(requestId) === true;
      if (
        !removed ||
        active.workerOwned ||
        (active.waitingWorkerRequestIds?.size ?? 0) > 0
      ) return;
      this.cancelProviderAttempt(active);
      this.requests.delete(key);
      this.releaseResource(key, "cancel");
      return;
    }
    if (
      (active.waitingWorkerRequestIds?.size ?? 0) > 0
    ) {
      active.workerOwned = false;
      return;
    }
    this.cancelProviderAttempt(active);
    this.requests.delete(key);
    this.releaseResource(key, "cancel");
  }

  private notifyResourceChange(): void {
    for (const listener of this.listeners) {
      listener(this.snapshotValue, {
        sequence: -1,
        revision: this.snapshotValue.revision,
        kind: "response",
      });
    }
  }

  private postWorkerResourceResult(
    key: string,
    requestId: number,
    result: TileProviderResult<undefined>,
  ): void {
    this.worker.postMessage({
      kind: "resource-result",
      key,
      requestId,
      result,
    });
  }

  private workingSetKeys(): Set<string> {
    return new Set(this.workingSetTiles.map(tileIdentityKey));
  }

  private retainWorkingSetResources(): boolean {
    const live = this.workingSetKeys();
    let changed = false;
    for (const key of [...this.resources.keys()]) {
      if (!live.has(key)) {
        changed = this.releaseResource(key, "eviction") || changed;
      }
    }
    for (const [key, request] of this.requests) {
      if (live.has(key)) continue;
      this.cancelProviderAttempt(request);
      this.requests.delete(key);
    }
    return changed;
  }

  private releaseResource(
    key: string,
    reason: keyof typeof this.resourceReleaseCounts,
  ): boolean {
    if (!this.resources.delete(key)) return false;
    this.resourceReleaseCounts[reason] += 1;
    return true;
  }

  /** Invalidates the callback before cancellation, including sync callbacks. */
  private cancelProviderAttempt(request: ActiveBridgeRequest): void {
    const handle = request.handle;
    request.handle = undefined;
    request.providerAttempt += 1;
    handle?.cancel();
  }

  private flushTarget(): void {
    if (
      this.pendingTarget === undefined ||
      this.targetInFlight ||
      this.targetFlushQueued ||
      this.disposed
    ) return;
    this.targetFlushQueued = true;
    queueMicrotask(() => {
      this.targetFlushQueued = false;
      const latest = this.pendingTarget;
      this.pendingTarget = undefined;
      if (!latest || this.disposed) return;
      this.targetInFlight = true;
      this.worker.postMessage({ kind: "target", target: latest });
    });
  }

  private scheduleRetry(
    failure?: {
      readonly reason?: string;
      readonly status?: number;
      readonly retryAfterMs?: number;
      readonly retryable?: boolean;
      readonly scope?: "tile" | "provider";
    },
  ): void {
    if (failure?.status !== undefined) this.lastFailureStatus = failure.status;
    if (failure?.retryable === false) {
      if (failure.scope === "tile") return;
      this.automaticRetryEnabled = false;
      if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.retryScheduledDelayMs = undefined;
      this.retryScheduledAtMs = undefined;
      return;
    }
    const baseDelay = this.options.retryDelayMs;
    if (
      baseDelay === undefined ||
      baseDelay < 0 ||
      !this.automaticRetryEnabled
    ) return;
    const configuredMaximum = this.options.retryMaxDelayMs;
    const maximumDelay = configuredMaximum === undefined ||
        !Number.isFinite(configuredMaximum)
      ? baseDelay
      : Math.max(baseDelay, configuredMaximum);
    const hintedDelay = failure?.retryAfterMs;
    const hasHint = hintedDelay !== undefined &&
      Number.isFinite(hintedDelay) && hintedDelay >= 0;
    const random = Math.min(
      1,
      Math.max(0, (this.options.retryRandom ?? Math.random)()),
    );
    const cappedExponentialDelay = Math.min(
      maximumDelay,
      baseDelay * 2 ** Math.min(this.retryAttempt, 52),
    );
    // Downward jitter preserves the configured maximum while preventing
    // clients from synchronising once exponential retries reach that cap.
    const exponentialDelay = cappedExponentialDelay * (1 - random * 0.2);
    const delay = hasHint ? hintedDelay : exponentialDelay;
    const scheduledAt = Date.now() + delay;
    if (this.retryTimer !== undefined) {
      if (
        !hasHint ||
        scheduledAt <= (this.retryScheduledAtMs ?? Number.POSITIVE_INFINITY)
      ) return;
      clearTimeout(this.retryTimer);
    }
    this.retryScheduledDelayMs = delay;
    this.retryScheduledAtMs = scheduledAt;
    this.armRetryTimer();
  }

  /**
   * Arms one representable timer chunk while retaining the provider's exact
   * absolute deadline. Long Retry-After values must not overflow into a rapid
   * retry loop in browsers.
   */
  private armRetryTimer(): void {
    const deadline = this.retryScheduledAtMs;
    if (deadline === undefined || this.disposed) return;
    const remaining = Math.max(0, deadline - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.disposed) return;
      if (Date.now() < (this.retryScheduledAtMs ?? 0)) {
        this.armRetryTimer();
        return;
      }
      this.retryScheduledDelayMs = undefined;
      this.retryScheduledAtMs = undefined;
      this.retryAttempt += 1;
      this.performRetry();
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
  }

  private resetRetryIfSatisfied(): void {
    const circuitState = this.options.provider.retryDiagnostics?.state;
    if (
      this.plannerFailureKeys.size > 0 ||
      circuitState === "open" ||
      circuitState === "half-open"
    ) return;
    this.retryAttempt = 0;
    this.retryScheduledDelayMs = undefined;
    this.retryScheduledAtMs = undefined;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}
