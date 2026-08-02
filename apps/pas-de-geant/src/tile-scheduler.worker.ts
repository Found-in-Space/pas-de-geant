/// <reference lib="webworker" />

import {
  TileOnionLayoutSource,
  type TileLayoutTarget,
} from "./tile-layout-source.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";
import { TileTransitionScheduler } from "./tile-transition-scheduler.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "./tile-provider.js";
import type {
  TileSchedulerCommand,
  TileSchedulerMessage,
} from "./tile-scheduler-protocol.js";

const scope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

class MainThreadResourceProvider implements TileProvider<undefined> {
  private nextRequestId = 1;
  private readonly observers = new Map<
    number,
    (result: TileProviderResult<undefined>) => void
  >();

  request(
    tile: TileIdentity,
    observer: (result: TileProviderResult<undefined>) => void,
  ): TileRequestHandle {
    const requestId = this.nextRequestId++;
    this.observers.set(requestId, observer);
    post({
      kind: "resource-request",
      tile,
      key: tileIdentityKey(tile),
      requestId,
    });
    return {
      requestId,
      cancel: () => {
        if (!this.observers.delete(requestId)) return;
        post({
          kind: "resource-cancel",
          key: tileIdentityKey(tile),
          requestId,
        });
      },
    };
  }

  deliver(requestId: number, result: TileProviderResult<undefined>): void {
    const observer = this.observers.get(requestId);
    if (!observer) return;
    observer(result);
    if (result.phase !== "in-flight") this.observers.delete(requestId);
  }
}

let scheduler: TileTransitionScheduler<TileLayoutTarget, undefined> | undefined;
let provider: MainThreadResourceProvider | undefined;

function post(message: TileSchedulerMessage): void {
  scope.postMessage(message);
}

scope.onmessage = ({ data }: MessageEvent<TileSchedulerCommand>) => {
  if (data.kind === "initialize") {
    provider = new MainThreadResourceProvider();
    scheduler = new TileTransitionScheduler(
      data.target,
      new TileOnionLayoutSource(),
      provider,
      { hydrateInitialResources: data.hydrateInitialResources },
    );
    scheduler.subscribe((snapshot, event) => {
      // Resource progress can be frequent. The main thread already owns those
      // resources, so only clone topology when it changes.
      if (!event || event.kind === "atomic-swap") {
        post({ kind: "snapshot", snapshot, ...(event ? { event } : {}) });
      } else {
        post({ kind: "event", event });
      }
    });
    return;
  }
  if (!scheduler || !provider) return;
  if (data.kind === "target") {
    const changed = scheduler.updateTarget(data.target);
    if (changed) post({ kind: "snapshot", snapshot: scheduler.snapshot });
    post({ kind: "target-applied", target: data.target });
  }
  if (data.kind === "retry") scheduler.retryFailed();
  if (data.kind === "resource-result")
    provider.deliver(data.requestId, data.result);
};
