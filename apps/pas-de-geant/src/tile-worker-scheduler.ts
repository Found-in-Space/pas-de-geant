import type { TileTarget } from "./tile-layout-source.js";
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
  /** Optional retry cadence for transient provider failures. */
  readonly retryDelayMs?: number;
  /** Demand known before the worker can emit its initial hydration requests. */
  readonly initialResourceDemand?: Iterable<TileIdentity>;
}

function initialSnapshot(target: TileTarget): SchedulerSnapshot<TileTarget> {
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
    (snapshot: SchedulerSnapshot<TileTarget>, event?: SchedulerEvent) => void
  >();
  private readonly requests = new Map<
    string,
    {
      readonly requestId: number;
      readonly tile: TileIdentity;
      readonly workerOwned: boolean;
      handle?: TileRequestHandle;
    }
  >();
  private readonly resources = new Map<string, Resource>();
  private demandedResources: ReadonlySet<string> | undefined;
  private priorityResources: ReadonlySet<string> = new Set();
  private nextDirectRequestId = -1;
  private pendingTarget: TileTarget | undefined;
  private targetInFlight = false;
  private targetFlushQueued = false;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshotValue: SchedulerSnapshot<TileTarget>;

  constructor(
    initialTarget: TileTarget,
    private readonly options: TileWorkerSchedulerOptions<Resource>,
  ) {
    this.snapshotValue = initialSnapshot(initialTarget);
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
      target: initialTarget,
      hydrateInitialResources: options.hydrateInitialResources ?? false,
    });
  }

  get snapshot(): SchedulerSnapshot<TileTarget> {
    return this.snapshotValue;
  }

  subscribe(
    listener: (
      snapshot: SchedulerSnapshot<TileTarget>,
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
    if (changed) this.notifyResourceChange();
  }

  updateResourcePriority(priorityTiles: Iterable<TileIdentity>): void {
    const priority = [...priorityTiles];
    this.priorityResources = new Set(priority.map(tileIdentityKey));
    this.options.provider.updatePriority?.(priority);
  }

  updateTarget(target: TileTarget): void {
    this.pendingTarget = target;
    this.flushTarget();
  }

  retryFailed(): void {
    if (this.disposed) return;
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
    this.worker.terminate();
  }

  private handleMessage(message: TileSchedulerMessage): void {
    if (this.disposed) return;
    if (message.kind === "resource-request")
      return this.requestResource(message);
    if (message.kind === "resource-cancel")
      return this.cancelResource(message.key, message.requestId);
    if (message.kind === "target-applied") {
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
      if (message.event.kind === "failure") this.scheduleRetry();
      return;
    }
    if (message.snapshot.revision < this.snapshotValue.revision) return;
    this.snapshotValue = message.snapshot;
    this.retainLiveResources();
    for (const listener of this.listeners)
      listener(this.snapshotValue, message.event);
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
    const old = this.requests.get(message.key);
    old?.handle?.cancel();
    const provisional: {
      readonly requestId: number;
      readonly tile: TileIdentity;
      readonly workerOwned: boolean;
      handle?: TileRequestHandle;
    } = {
      requestId: message.requestId,
      tile: message.tile,
      workerOwned: true,
    };
    this.requests.set(message.key, provisional);
    const handle = this.options.provider.request(message.tile, (result) => {
      const active = this.requests.get(message.key);
      if (!active || active.requestId !== message.requestId || this.disposed)
        return;
      if (result.phase === "response")
        this.resources.set(message.key, result.resource);
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
    const provisional: {
      readonly requestId: number;
      readonly tile: TileIdentity;
      readonly workerOwned: boolean;
      handle?: TileRequestHandle;
    } = { requestId, tile, workerOwned: false };
    this.requests.set(key, provisional);
    const handle = this.options.provider.request(tile, (result) => {
      const active = this.requests.get(key);
      if (!active || active.requestId !== requestId || this.disposed) return;
      if (result.phase === "in-flight") return;
      this.requests.delete(key);
      if (result.phase === "response") {
        this.resources.set(key, result.resource);
        this.notifyResourceChange();
      } else {
        this.scheduleRetry();
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
    if (!this.demandedResources) return;
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
    if (this.targetInFlight || this.targetFlushQueued || this.disposed) return;
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

  private scheduleRetry(): void {
    const delay = this.options.retryDelayMs;
    if (delay === undefined || delay < 0 || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.disposed) this.retryFailed();
    }, delay);
  }
}
