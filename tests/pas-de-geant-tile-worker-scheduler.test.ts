import { describe, expect, it, vi } from "vitest";
import type {
  TileSchedulerCommand,
  TileSchedulerMessage,
} from "../apps/pas-de-geant/src/tile-scheduler-protocol.js";
import {
  TileWorkerScheduler,
  type TileSchedulerWorker,
} from "../apps/pas-de-geant/src/tile-worker-scheduler.js";
import type {
  TileProvider,
  TileProviderResult,
} from "../apps/pas-de-geant/src/tile-provider.js";
import type { TileIdentity } from "../apps/pas-de-geant/src/tile-transition-planner.js";
import { ScheduledImageryProvider } from "../apps/pas-de-geant/src/imagery.js";
import type { ImageryProvider } from "../apps/pas-de-geant/src/imagery-provider.js";

function layoutTarget(
  maxZoom: number,
  latitudeDegrees = 0,
  longitudeDegrees = 0,
) {
  return { maxZoom, latitudeDegrees, longitudeDegrees };
}

class FakeWorker implements TileSchedulerWorker {
  readonly commands: TileSchedulerCommand[] = [];
  onmessage: ((event: MessageEvent<TileSchedulerMessage>) => void) | null = null;
  terminated = false;

  postMessage(message: TileSchedulerCommand): void {
    this.commands.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: TileSchedulerMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<TileSchedulerMessage>);
  }
}

function snapshot(
  revision: number,
  committedCut: readonly TileIdentity[] = [{ z: 0, x: 0, y: 0 }],
) {
  return {
    revision,
    target: layoutTarget(0),
    committedCut,
    requestedCut: committedCut,
    graph: { retained: committedCut, groups: [], batches: [] },
    requirements: [],
  } as const;
}

interface ProviderHarness<Resource> {
  readonly provider: TileProvider<Resource>;
  readonly requested: TileIdentity[];
  readonly observers: Array<(result: TileProviderResult<Resource>) => void>;
  readonly cancelled: number[];
}

function providerHarness<Resource>(): ProviderHarness<Resource> {
  const requested: TileIdentity[] = [];
  const observers: Array<(result: TileProviderResult<Resource>) => void> = [];
  const cancelled: number[] = [];
  return {
    requested,
    observers,
    cancelled,
    provider: {
      request: (tile, observer) => {
        const requestId = requested.length + 1;
        requested.push(tile);
        observers.push(observer);
        return {
          requestId,
          cancel: () => cancelled.push(requestId),
        };
      },
    },
  };
}

describe("Tile worker scheduler planner bridge", () => {
  it("sends horizon culling to the worker and deduplicates identical sets", () => {
    const worker = new FakeWorker();
    const harness = providerHarness<string>();
    const scheduler = new TileWorkerScheduler(layoutTarget(2), {
      provider: harness.provider,
      createWorker: () => worker,
    });
    const first = { z: 2, x: 1, y: 1 };
    const second = { z: 2, x: 2, y: 1 };

    scheduler.updateHorizonCulling([first, second]);
    scheduler.updateHorizonCulling([second, first, first]);

    expect(worker.commands).toEqual([
      { kind: "initialize", target: layoutTarget(2) },
      {
        kind: "horizon-culling",
        revision: -1,
        tiles: [first, second],
      },
    ]);
    expect(harness.requested).toEqual([]);
    expect(scheduler.debugState.horizon_candidate_count).toBe(2);
    scheduler.dispose();
  });

  it("resends unchanged horizon keys when the planner revision changes", () => {
    const worker = new FakeWorker();
    const harness = providerHarness<string>();
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: harness.provider,
      createWorker: () => worker,
    });
    const tile = { z: 1, x: 0, y: 0 };

    scheduler.updateHorizonCulling([tile]);
    worker.emit({ kind: "snapshot", snapshot: snapshot(0, [tile]) });
    scheduler.updateHorizonCulling([tile]);
    scheduler.updateHorizonCulling([tile]);

    expect(worker.commands.filter(({ kind }) =>
      kind === "horizon-culling"
    )).toEqual([
      { kind: "horizon-culling", revision: -1, tiles: [tile] },
      { kind: "horizon-culling", revision: 0, tiles: [tile] },
    ]);
    scheduler.dispose();
  });

  it("invokes the provider only for planner-and-horizon requests", () => {
    const worker = new FakeWorker();
    const harness = providerHarness<string>();
    const scheduler = new TileWorkerScheduler(layoutTarget(0), {
      provider: harness.provider,
      createWorker: () => worker,
    });
    const planned = { z: 1, x: 0, y: 0 };
    const outside = { z: 8, x: 100, y: 100 };

    scheduler.updateHorizonCulling([planned, outside]);
    expect(harness.requested).toEqual([]);
    worker.emit({
      kind: "resource-request",
      tile: planned,
      key: "1/0/0",
      requestId: 7,
    });

    expect(harness.requested).toEqual([planned]);
    expect(scheduler.debugState.planner_requests).toEqual({
      requested: 1,
      in_flight: 0,
      total_outstanding: 1,
    });
    scheduler.dispose();
  });

  it("coalesces worker requests and publishes one provider response to every request id", () => {
    const worker = new FakeWorker();
    const harness = providerHarness<string>();
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: harness.provider,
      createWorker: () => worker,
    });
    const tile = { z: 1, x: 0, y: 0 };
    worker.emit({ kind: "resource-request", tile, key: "1/0/0", requestId: 4 });
    worker.emit({ kind: "resource-request", tile, key: "1/0/0", requestId: 5 });

    expect(harness.requested).toEqual([tile]);
    harness.observers[0]!({ phase: "response", resource: "payload" });

    expect(worker.commands).toContainEqual({
      kind: "resource-result",
      key: "1/0/0",
      requestId: 4,
      result: { phase: "response", resource: undefined },
    });
    expect(worker.commands).toContainEqual({
      kind: "resource-result",
      key: "1/0/0",
      requestId: 5,
      result: { phase: "response", resource: undefined },
    });
    expect(scheduler.committedResource(tile)).toBe("payload");
    scheduler.dispose();
  });

  it("bridges synchronous in-flight and response callbacks from a provider", () => {
    const worker = new FakeWorker();
    const cancel = vi.fn();
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: {
        request(_tile, observer) {
          observer({ phase: "in-flight" });
          observer({ phase: "response", resource: "synchronous" });
          return { requestId: 77, cancel };
        },
      },
      createWorker: () => worker,
    });
    const tile = { z: 1, x: 0, y: 0 };

    worker.emit({ kind: "resource-request", tile, key: "1/0/0", requestId: 4 });

    expect(worker.commands.filter(({ kind }) => kind === "resource-result"))
      .toEqual([
        {
          kind: "resource-result",
          key: "1/0/0",
          requestId: 4,
          result: { phase: "in-flight" },
        },
        {
          kind: "resource-result",
          key: "1/0/0",
          requestId: 4,
          result: { phase: "response", resource: undefined },
        },
      ]);
    expect(scheduler.committedResource(tile)).toBe("synchronous");
    expect(scheduler.debugState.planner_requests.total_outstanding).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("cancels an unneeded provider attempt without fabricating a failure", () => {
    const worker = new FakeWorker();
    const harness = providerHarness<string>();
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: harness.provider,
      createWorker: () => worker,
    });
    const tile = { z: 1, x: 0, y: 0 };
    worker.emit({ kind: "resource-request", tile, key: "1/0/0", requestId: 4 });
    worker.emit({ kind: "resource-cancel", key: "1/0/0", requestId: 4 });

    expect(harness.cancelled).toEqual([1]);
    expect(worker.commands.filter(({ kind }) => kind === "resource-result"))
      .toEqual([]);
    expect(scheduler.debugState.planner_requests.total_outstanding).toBe(0);
    scheduler.dispose();
  });

  it("allows planner-requested cache-first work during Retry-After backoff", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const harness = providerHarness<string>();
      const scheduler = new TileWorkerScheduler(layoutTarget(1), {
        provider: harness.provider,
        createWorker: () => worker,
        retryDelayMs: 100,
      });
      const first = { z: 1, x: 0, y: 0 };
      const second = { z: 1, x: 1, y: 0 };
      worker.emit({ kind: "resource-request", tile: first, key: "1/0/0", requestId: 1 });
      harness.observers[0]!({
        phase: "failure",
        reason: "limited",
        status: 429,
        retryAfterMs: 10_000,
        scope: "provider",
      });
      worker.emit({ kind: "resource-request", tile: second, key: "1/1/0", requestId: 2 });

      expect(harness.requested).toEqual([first, second]);
      expect(scheduler.debugState.retry).toMatchObject({
        scheduled_delay_ms: 10_000,
        last_status: 429,
      });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes provider-deferred misses and retries failed planner requirements", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      let resumed = 0;
      const scheduler = new TileWorkerScheduler(layoutTarget(0), {
        provider: {
          request: () => ({ requestId: 1, cancel() {} }),
          resumeDeferred: () => {
            resumed += 1;
          },
        },
        createWorker: () => worker,
        retryDelayMs: 250,
        retryRandom: () => 0,
      });
      worker.emit({
        kind: "event",
        event: {
          sequence: 1,
          revision: 0,
          kind: "failure",
          tile: { z: 0, x: 0, y: 0 },
          reason: "limited",
          status: 429,
          retryAfterMs: 1_000,
          scope: "provider",
        },
      });

      vi.advanceTimersByTime(999);
      expect(resumed).toBe(0);
      vi.advanceTimersByTime(1);

      expect(resumed).toBe(1);
      expect(worker.commands.at(-1)).toEqual({ kind: "retry" });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("chunks long Retry-After waits and preserves their wake-up on early retry", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const worker = new FakeWorker();
      let resumed = 0;
      const scheduler = new TileWorkerScheduler(layoutTarget(0), {
        provider: {
          request: () => ({ requestId: 1, cancel() {} }),
          resumeDeferred: () => {
            resumed += 1;
          },
        },
        createWorker: () => worker,
        retryDelayMs: 100,
      });
      const retryAfterMs = 30 * 24 * 60 * 60 * 1_000;
      worker.emit({
        kind: "event",
        event: {
          sequence: 1,
          revision: 0,
          kind: "failure",
          tile: { z: 0, x: 0, y: 0 },
          reason: "limited",
          status: 429,
          retryAfterMs,
          scope: "provider",
        },
      });

      vi.advanceTimersByTime(1_000);
      scheduler.retryFailed();
      expect(resumed).toBe(0);
      expect(worker.commands).not.toContainEqual({ kind: "retry" });

      vi.advanceTimersByTime(retryAfterMs - 1_001);
      expect(resumed).toBe(0);
      vi.advanceTimersByTime(1);

      expect(resumed).toBe(1);
      expect(worker.commands.at(-1)).toEqual({ kind: "retry" });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never fabricates failures for later work after a terminal provider failure", () => {
    const worker = new FakeWorker();
    const harness = providerHarness<string>();
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: harness.provider,
      createWorker: () => worker,
      retryDelayMs: 100,
    });
    const first = { z: 1, x: 0, y: 0 };
    const second = { z: 1, x: 1, y: 0 };
    worker.emit({ kind: "resource-request", tile: first, key: "1/0/0", requestId: 10 });
    harness.observers[0]!({
      phase: "failure",
      reason: "provider disabled",
      status: 403,
      retryable: false,
      scope: "provider",
    });
    worker.emit({ kind: "resource-request", tile: second, key: "1/1/0", requestId: 11 });

    expect(harness.requested).toEqual([first, second]);
    expect(worker.commands).not.toContainEqual(expect.objectContaining({
      kind: "resource-result",
      requestId: 11,
    }));
    scheduler.dispose();
  });

  it("evicts completed payloads and cancels completing work beyond the horizon", () => {
    const worker = new FakeWorker();
    const harness = providerHarness<string>();
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: harness.provider,
      createWorker: () => worker,
    });
    const loaded = { z: 1, x: 0, y: 0 };
    const completing = { z: 1, x: 1, y: 0 };
    scheduler.updateHorizonCulling([loaded, completing]);
    worker.emit({ kind: "resource-request", tile: loaded, key: "1/0/0", requestId: 1 });
    harness.observers[0]!({ phase: "response", resource: "loaded" });
    worker.emit({ kind: "resource-request", tile: completing, key: "1/1/0", requestId: 2 });
    harness.observers[1]!({ phase: "in-flight" });
    scheduler.updateHorizonCulling([]);
    harness.observers[1]!({ phase: "response", resource: "completed" });

    expect(harness.cancelled).toEqual([2]);
    expect(scheduler.committedResource(loaded)).toBeUndefined();
    expect(scheduler.committedResource(completing)).toBeUndefined();
    expect(scheduler.debugState.resource_releases).toMatchObject({
      total: 1,
      eviction: 1,
    });

    scheduler.updateHorizonCulling([loaded]);
    worker.emit({ kind: "resource-request", tile: loaded, key: "1/0/0", requestId: 3 });
    expect(harness.requested).toEqual([loaded, completing, loaded]);
    harness.observers[2]!({ phase: "response", resource: "reloaded" });
    expect(scheduler.committedResource(loaded)).toBe("reloaded");
    scheduler.dispose();
  });

  it("does not pin an outgoing payload through an unrelated provider outage", async () => {
    const worker = new FakeWorker();
    const source: ImageryProvider = {
      id: "session-outage-fixture",
      attribution: "fixture",
      tileSize: 1,
      minZoom: 1,
      maxZoom: 1,
      async load(tile) {
        if (tile.x === 1) throw new TypeError("provider unavailable");
        return new Blob(["loaded"]);
      },
    };
    const provider = new ScheduledImageryProvider(
      source,
      async () => new Uint8Array([1, 2, 3, 4]),
    );
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider,
      createWorker: () => worker,
    });
    const loaded = { z: 1, x: 0, y: 0 };
    const outage = { z: 1, x: 1, y: 0 };
    scheduler.updateHorizonCulling([loaded]);
    worker.emit({
      kind: "resource-request",
      tile: loaded,
      key: "1/0/0",
      requestId: 1,
    });
    await vi.waitFor(() =>
      expect(scheduler.committedResource(loaded)).toBeDefined()
    );
    scheduler.updateHorizonCulling([]);
    expect(scheduler.committedResource(loaded)).toBeUndefined();
    scheduler.updateHorizonCulling([outage]);
    worker.emit({
      kind: "resource-request",
      tile: outage,
      key: "1/1/0",
      requestId: 2,
    });
    await vi.waitFor(() => expect(provider.retryDiagnostics.state).toBe("open"));

    expect(scheduler.committedResource(loaded)).toBeUndefined();
    expect(scheduler.committedResource(outage)).toBeUndefined();
    expect(scheduler.debugState.resident_payload_count).toBe(0);
    expect(worker.commands).toContainEqual(expect.objectContaining({
      kind: "resource-result",
      requestId: 2,
      result: expect.objectContaining({ phase: "failure" }),
    }));
    scheduler.dispose();
    provider.dispose();
  });

  it("retains active replacement payloads and evicts them after ownership ends", () => {
    const worker = new FakeWorker();
    const harness = providerHarness<string>();
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: harness.provider,
      createWorker: () => worker,
    });
    const first = { z: 1, x: 0, y: 0 };
    const second = { z: 1, x: 1, y: 0 };
    scheduler.updateHorizonCulling([first]);
    worker.emit({ kind: "resource-request", tile: first, key: "1/0/0", requestId: 1 });
    harness.observers[0]!({ phase: "response", resource: "first" });
    worker.emit({
      kind: "snapshot",
      snapshot: {
        ...snapshot(1, [first]),
        requirements: [{
          tile: second,
          state: "in-flight",
          requestId: 2,
        }],
      },
    });
    worker.emit({ kind: "resource-request", tile: second, key: "1/1/0", requestId: 2 });
    harness.observers[1]!({ phase: "response", resource: "second" });
    scheduler.updateHorizonCulling([]);

    expect(scheduler.committedResource(first)).toBeUndefined();
    expect(scheduler.committedResource(second)).toBe("second");
    worker.emit({ kind: "snapshot", snapshot: snapshot(2, [second]) });

    expect(scheduler.committedResource(second)).toBeUndefined();
    expect(scheduler.debugState.resource_releases).toMatchObject({
      total: 2,
      eviction: 2,
    });
    scheduler.dispose();
  });

  it("serializes targets and keeps only the latest pending target", async () => {
    const worker = new FakeWorker();
    const harness = providerHarness<string>();
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: harness.provider,
      createWorker: () => worker,
    });

    scheduler.updateTarget(layoutTarget(2, 1, 0));
    scheduler.updateTarget(layoutTarget(2, 2, 0));
    await Promise.resolve();
    expect(worker.commands.at(-1)).toEqual({
      kind: "target",
      target: layoutTarget(2, 2, 0),
    });
    scheduler.updateTarget(layoutTarget(2, 3, 0));
    await Promise.resolve();
    expect(worker.commands.filter(({ kind }) => kind === "target")).toHaveLength(1);
    worker.emit({ kind: "target-applied", target: layoutTarget(2, 2, 0) });
    await Promise.resolve();
    expect(worker.commands.at(-1)).toEqual({
      kind: "target",
      target: layoutTarget(2, 3, 0),
    });
    scheduler.dispose();
  });
});
