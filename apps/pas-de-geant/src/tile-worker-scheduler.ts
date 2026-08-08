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
  readonly hydrateInitialResources?: boolean;
  readonly provider: TileProvider<Resource>;
  /** Base retry cadence for transient provider failures. */
  readonly retryDelayMs?: number;
  /** When set above the base cadence, failed retry rounds back off to this. */
  readonly retryMaxDelayMs?: number;
  /** Random source used to desynchronise exponential retries. */
  readonly retryRandom?: () => number;
  /** Demand known before the worker can emit its initial hydration requests. */
  readonly initialResourceDemand?: Iterable<TileIdentity>;
}

export interface TileWorkerSchedulerRequestCounts {
  readonly requested: number;
  readonly in_flight: number;
  readonly total_outstanding: number;
}

export interface TileWorkerSchedulerDebugState {
  readonly transition_owned: TileWorkerSchedulerRequestCounts;
  readonly residency_hydration: TileWorkerSchedulerRequestCounts;
  readonly total: TileWorkerSchedulerRequestCounts;
  readonly resident_payload_count: number;
  readonly demanded_payload_count: number | null;
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
  readonly workerOwned: boolean;
  phase: "requested" | "in-flight";
  handle?: TileRequestHandle;
}

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
  private demandedResources: ReadonlySet<string> | undefined;
  private priorityResources: ReadonlySet<string> = new Set();
  private nextDirectRequestId = -1;
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
  private terminalFailure:
    | Extract<TileProviderResult<never>, { phase: "failure" }>
    | undefined;
  private snapshotValue: SchedulerSnapshot<TileLayoutTarget>;

  constructor(
    initialTarget: TileLayoutTarget,
    private readonly options: TileWorkerSchedulerOptions<Resource>,
  ) {
    const normalizedInitialTarget = normalizeTileLayoutTarget(initialTarget);
    this.snapshotValue = initialSnapshot(normalizedInitialTarget);
    if (options.initialResourceDemand) {
      this.demandedResources = new Set(
        [...options.initialResourceDemand].map(tileIdentityKey),
      );
    }
    this.worker =
      options.createWorker?.() ??
      new Worker(new URL("./tile-scheduler.worker.ts", import.meta.url), {
        type: "module",
      });
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.postMessage({
      kind: "initialize",
      target: normalizedInitialTarget,
      hydrateInitialResources: options.hydrateInitialResources ?? false,
    });
  }

  get snapshot(): SchedulerSnapshot<TileLayoutTarget> {
    return this.snapshotValue;
  }

  get debugState(): TileWorkerSchedulerDebugState {
    const counts = (workerOwned: boolean): TileWorkerSchedulerRequestCounts => {
      let requested = 0;
      let inFlight = 0;
      for (const request of this.requests.values()) {
        if (request.workerOwned !== workerOwned) continue;
        if (request.phase === "in-flight") inFlight += 1;
        else requested += 1;
      }
      return {
        requested,
        in_flight: inFlight,
        total_outstanding: requested + inFlight,
      };
    };
    const transitionOwned = counts(true);
    const residencyHydration = counts(false);
    return {
      transition_owned: transitionOwned,
      residency_hydration: residencyHydration,
      total: {
        requested:
          transitionOwned.requested + residencyHydration.requested,
        in_flight:
          transitionOwned.in_flight + residencyHydration.in_flight,
        total_outstanding:
          transitionOwned.total_outstanding +
          residencyHydration.total_outstanding,
      },
      resident_payload_count: this.resources.size,
      demanded_payload_count: this.demandedResources?.size ?? null,
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

  /**
   * Changes expensive payload residency without changing topology. An
   * undefined demand preserves the historical hydrate-everything behaviour.
   */
  updateResourceDemand(
    demandedTiles: Iterable<TileIdentity>,
    priorityTiles: Iterable<TileIdentity> = [],
  ): void {
    const demanded = new Set([...demandedTiles].map(tileIdentityKey));
    const priority = [...priorityTiles];
    this.demandedResources = demanded;
    this.priorityResources = new Set(priority.map(tileIdentityKey));
    this.options.provider.updatePriority?.(priority);
    for (const [key, request] of [...this.requests]) {
      if (demanded.has(key)) continue;
      request.handle?.cancel();
      this.requests.delete(key);
      if (request.workerOwned) {
        this.worker.postMessage({
          kind: "resource-result",
          key,
          requestId: request.requestId,
          result: { phase: "response", resource: undefined },
        });
      }
    }
    let changed = false;
    for (const key of [...this.resources.keys()]) {
      if (demanded.has(key)) continue;
      this.resources.delete(key);
      changed = true;
    }
    this.hydrateDemandedCommitted();
    this.resetRetryIfSatisfied();
    if (changed) this.notifyResourceChange();
  }

  updateResourcePriority(priorityTiles: Iterable<TileIdentity>): void {
    const priority = [...priorityTiles];
    this.priorityResources = new Set(priority.map(tileIdentityKey));
    this.options.provider.updatePriority?.(priority);
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
    if (this.disposed || !this.automaticRetryEnabled) return;
    this.worker.postMessage({ kind: "retry" });
    this.hydrateDemandedCommitted();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { handle } of this.requests.values()) handle?.cancel();
    this.requests.clear();
    this.resources.clear();
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
      if (message.event.kind === "discard" && message.event.tile) {
        this.resources.delete(tileIdentityKey(message.event.tile));
      }
      for (const listener of this.listeners)
        listener(this.snapshotValue, message.event);
      if (message.event.kind === "failure")
        this.scheduleRetry(message.event);
      return;
    }
    if (message.snapshot.revision < this.snapshotValue.revision) return;
    this.snapshotValue = message.snapshot;
    this.retainLiveResources();
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
    if (this.demandedResources && !this.demandedResources.has(message.key)) {
      this.worker.postMessage({
        kind: "resource-result",
        key: message.key,
        requestId: message.requestId,
        result: { phase: "response", resource: undefined },
      });
      return;
    }
    if (this.terminalFailure) {
      this.worker.postMessage({
        kind: "resource-result",
        key: message.key,
        requestId: message.requestId,
        result: this.terminalFailure,
      });
      return;
    }
    if (this.retryTimer !== undefined) {
      this.worker.postMessage({
        kind: "resource-result",
        key: message.key,
        requestId: message.requestId,
        result: {
          phase: "failure",
          reason: "Tile provider retry backoff is active.",
        },
      });
      return;
    }
    const old = this.requests.get(message.key);
    old?.handle?.cancel();
    const provisional: ActiveBridgeRequest = {
      requestId: message.requestId,
      tile: message.tile,
      workerOwned: true,
      phase: "requested",
    };
    this.requests.set(message.key, provisional);
    const handle = this.options.provider.request(message.tile, (result) => {
      const active = this.requests.get(message.key);
      if (!active || active.requestId !== message.requestId || this.disposed)
        return;
      if (result.phase === "in-flight") active.phase = "in-flight";
      if (result.phase === "response") {
        this.resources.set(message.key, result.resource);
        this.resetRetryIfSatisfied();
      }
      this.worker.postMessage({
        kind: "resource-result",
        key: message.key,
        requestId: message.requestId,
        result:
          result.phase === "response"
            ? { phase: "response", resource: undefined }
            : result,
      });
      if (result.phase !== "in-flight") this.requests.delete(message.key);
    });
    const active = this.requests.get(message.key);
    if (active === provisional) active.handle = handle;
  }

  private cancelResource(key: string, requestId: number): void {
    const active = this.requests.get(key);
    if (!active || active.requestId !== requestId) return;
    active.handle?.cancel();
    this.requests.delete(key);
    this.resources.delete(key);
  }

  private requestDirectHydration(tile: TileIdentity, key: string): void {
    const requestId = this.nextDirectRequestId--;
    const provisional: ActiveBridgeRequest = {
      requestId,
      tile,
      workerOwned: false,
      phase: "requested",
    };
    this.requests.set(key, provisional);
    const handle = this.options.provider.request(tile, (result) => {
      const active = this.requests.get(key);
      if (!active || active.requestId !== requestId || this.disposed) return;
      if (result.phase === "in-flight") {
        active.phase = "in-flight";
        return;
      }
      this.requests.delete(key);
      if (result.phase === "response") {
        this.resources.set(key, result.resource);
        this.resetRetryIfSatisfied();
        this.notifyResourceChange();
      } else {
        this.scheduleRetry(result);
      }
    });
    if (this.requests.get(key) === provisional) provisional.handle = handle;
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

  private hydrateDemandedCommitted(): void {
    if (
      !this.demandedResources ||
      this.retryTimer !== undefined ||
      !this.automaticRetryEnabled
    ) return;
    const demandedResources = this.demandedResources;
    const hydrate = (tile: TileIdentity): void => {
      const key = tileIdentityKey(tile);
      if (
        !demandedResources.has(key) ||
        this.resources.has(key) ||
        this.requests.has(key)
      ) return;
      this.requestDirectHydration(tile, key);
    };
    for (const tile of this.snapshotValue.committedCut) {
      if (this.priorityResources.has(tileIdentityKey(tile))) hydrate(tile);
    }
    for (const tile of this.snapshotValue.committedCut) {
      if (!this.priorityResources.has(tileIdentityKey(tile))) hydrate(tile);
    }
  }

  private retainLiveResources(): void {
    const live = new Set([
      ...this.snapshotValue.committedCut.map(tileIdentityKey),
      ...this.snapshotValue.requirements.map(({ tile }) =>
        tileIdentityKey(tile),
      ),
    ]);
    for (const key of this.resources.keys())
      if (!live.has(key)) this.resources.delete(key);
    for (const [key, request] of this.requests) {
      if (live.has(key)) continue;
      request.handle?.cancel();
      this.requests.delete(key);
    }
    this.hydrateDemandedCommitted();
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
    },
  ): void {
    if (failure?.status !== undefined) this.lastFailureStatus = failure.status;
    if (failure?.retryable === false) {
      this.automaticRetryEnabled = false;
      this.terminalFailure = {
        phase: "failure",
        reason: failure.reason ?? "Tile provider requests are disabled.",
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ...(failure.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: failure.retryAfterMs }),
        retryable: false,
      };
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
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryScheduledDelayMs = undefined;
      this.retryScheduledAtMs = undefined;
      this.retryAttempt += 1;
      if (!this.disposed) this.retryFailed();
    }, delay);
  }

  private resetRetryIfSatisfied(): void {
    if (
      this.demandedResources &&
      [...this.demandedResources].some((key) => !this.resources.has(key))
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
