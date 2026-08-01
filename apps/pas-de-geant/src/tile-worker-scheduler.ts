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
    { readonly requestId: number; handle?: TileRequestHandle }
  >();
  private readonly resources = new Map<string, Resource>();
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

  updateTarget(target: TileTarget): void {
    this.pendingTarget = target;
    this.flushTarget();
  }

  retryFailed(): void {
    if (!this.disposed) this.worker.postMessage({ kind: "retry" });
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
    const old = this.requests.get(message.key);
    old?.handle?.cancel();
    const provisional: {
      readonly requestId: number;
      handle?: TileRequestHandle;
    } = { requestId: message.requestId };
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
      if (!this.disposed) this.worker.postMessage({ kind: "retry" });
    }, delay);
  }
}
