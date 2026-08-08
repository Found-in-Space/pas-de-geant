import { describe, expect, it, vi } from "vitest";
import type {
  TileSchedulerCommand,
  TileSchedulerMessage,
} from "../apps/pas-de-geant/src/tile-scheduler-protocol.js";
import {
  TileWorkerScheduler,
  type TileSchedulerWorker,
} from "../apps/pas-de-geant/src/tile-worker-scheduler.js";
import type { TileProvider } from "../apps/pas-de-geant/src/tile-provider.js";

function layoutTarget(
  maxZoom: number,
  latitudeDegrees = 0,
  longitudeDegrees = 0,
) {
  return { maxZoom, latitudeDegrees, longitudeDegrees };
}

class FakeWorker implements TileSchedulerWorker {
  readonly commands: TileSchedulerCommand[] = [];
  onmessage: ((event: MessageEvent<TileSchedulerMessage>) => void) | null =
    null;
  terminated = false;
  postMessage(message: TileSchedulerCommand): void {
    this.commands.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(message: TileSchedulerMessage): void {
    this.onmessage?.({
      data: message,
    } as MessageEvent<TileSchedulerMessage>);
  }
}

function snapshot(revision: number, committedCut = [{ z: 0, x: 0, y: 0 }]) {
  return {
    revision,
    target: layoutTarget(0),
    committedCut,
    requestedCut: committedCut,
    graph: { retained: committedCut, groups: [], batches: [] },
    requirements: [],
  } as const;
}

describe("Tile worker scheduler bridge", () => {
  it("honors a prolonged visible Retry-After before retrying", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const observers: Array<Parameters<TileProvider<string>["request"]>[1]> = [];
      let resumes = 0;
      const scheduler = new TileWorkerScheduler(layoutTarget(0), {
        provider: {
          request: (_tile, observer) => {
            observers.push(observer);
            return { requestId: observers.length, cancel() {} };
          },
          resumeDeferred: () => {
            resumes += 1;
          },
        },
        createWorker: () => worker,
        retryDelayMs: 250,
        retryMaxDelayMs: 1_000,
      });
      const tile = { z: 0, x: 0, y: 0 };
      worker.emit({ kind: "snapshot", snapshot: snapshot(1, [tile]) });
      scheduler.updateResourceDemand([tile]);
      observers[0]!({
        phase: "failure",
        reason: "limited",
        status: 429,
        retryAfterMs: 4_158_000,
      });

      expect(scheduler.debugState.retry).toMatchObject({
        scheduled_delay_ms: 4_158_000,
        last_status: 429,
      });
      vi.advanceTimersByTime(4_157_999);
      expect(observers).toHaveLength(1);
      expect(resumes).toBe(0);
      vi.advanceTimersByTime(1);
      expect(observers).toHaveLength(2);
      expect(resumes).toBe(1);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a Retry-After deadline beyond the browser timer range", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const scheduler = new TileWorkerScheduler(layoutTarget(0), {
        provider: {
          request: () => ({ requestId: 1, cancel() {} }),
        },
        createWorker: () => worker,
        retryDelayMs: 250,
        retryRandom: () => 0,
      });
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
      worker.emit({
        kind: "event",
        event: {
          sequence: 1,
          revision: 0,
          kind: "failure",
          tile: { z: 0, x: 0, y: 0 },
          reason: "long provider backoff",
          status: 429,
          retryAfterMs: thirtyDaysMs,
        },
      });

      expect(scheduler.debugState.retry.scheduled_delay_ms).toBe(
        thirtyDaysMs,
      );
      vi.advanceTimersByTime(2_147_483_647);
      expect(worker.commands.some(({ kind }) => kind === "retry")).toBe(false);
      vi.advanceTimersByTime(thirtyDaysMs - 2_147_483_647 - 1);
      expect(worker.commands.some(({ kind }) => kind === "retry")).toBe(false);
      vi.advanceTimersByTime(1);
      expect(worker.commands.at(-1)).toEqual({ kind: "retry" });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the automatic wake-up when manual retry is requested too early", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      let resumes = 0;
      const scheduler = new TileWorkerScheduler(layoutTarget(0), {
        provider: {
          request: () => ({ requestId: 1, cancel() {} }),
          resumeDeferred: () => {
            resumes += 1;
          },
        },
        createWorker: () => worker,
        retryDelayMs: 100,
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
        },
      });

      vi.advanceTimersByTime(100);
      scheduler.retryFailed();
      expect(resumes).toBe(0);
      expect(worker.commands.some(({ kind }) => kind === "retry")).toBe(false);
      expect(scheduler.debugState.retry.scheduled_delay_ms).toBe(1_000);

      vi.advanceTimersByTime(899);
      expect(resumes).toBe(0);
      vi.advanceTimersByTime(1);
      expect(resumes).toBe(1);
      expect(worker.commands.at(-1)).toEqual({ kind: "retry" });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts an exact legacy request deferred behind retry backoff", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const observers: Array<Parameters<TileProvider<string>["request"]>[1]> = [];
      const scheduler = new TileWorkerScheduler(layoutTarget(1), {
        provider: {
          request: (_tile, observer) => {
            observers.push(observer);
            return { requestId: observers.length, cancel() {} };
          },
        },
        createWorker: () => worker,
        retryDelayMs: 100,
        retryRandom: () => 0,
      });
      const exact = { z: 1, x: 0, y: 0 };
      worker.emit({
        kind: "event",
        event: {
          sequence: 1,
          revision: 0,
          kind: "failure",
          tile: { z: 1, x: 1, y: 0 },
          reason: "provider unavailable",
        },
      });
      worker.emit({
        kind: "resource-request",
        tile: exact,
        key: "1/0/0",
        requestId: 77,
      });
      expect(observers).toHaveLength(0);
      expect(scheduler.debugState.deferred_payload_count).toBe(1);

      vi.advanceTimersByTime(100);
      expect(observers).toHaveLength(1);
      observers[0]!({ phase: "response", resource: "exact-resource" });
      expect(worker.commands).toContainEqual({
        kind: "resource-result",
        key: "1/0/0",
        requestId: 77,
        result: { phase: "response", resource: undefined },
      });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a cancelled legacy attempt after the same bridge request restarts", () => {
    const worker = new FakeWorker();
    const observers: Array<Parameters<TileProvider<string>["request"]>[1]> = [];
    const cancellations: number[] = [];
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: {
        request: (_tile, observer) => {
          const attempt = observers.push(observer);
          return {
            requestId: attempt,
            cancel: () => cancellations.push(attempt),
          };
        },
      },
      createWorker: () => worker,
    });
    const tile = { z: 1, x: 0, y: 0 };
    scheduler.updateResourceDemand([tile]);
    worker.emit({
      kind: "resource-request",
      tile,
      key: "1/0/0",
      requestId: 88,
    });
    scheduler.updateResourceDemand([]);
    scheduler.updateResourceDemand([tile]);

    expect(cancellations).toEqual([1]);
    expect(observers).toHaveLength(2);
    observers[0]!({ phase: "response", resource: "stale" });
    expect(scheduler.committedResource(tile)).toBeUndefined();
    expect(worker.commands.filter(({ kind }) => kind === "resource-result"))
      .toHaveLength(0);

    observers[1]!({ phase: "response", resource: "current" });
    expect(scheduler.committedResource(tile)).toBe("current");
    expect(worker.commands).toContainEqual({
      kind: "resource-result",
      key: "1/0/0",
      requestId: 88,
      result: { phase: "response", resource: undefined },
    });
    scheduler.dispose();
  });

  it("keeps fatal provider state terminal across later demand changes", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const observers: Array<Parameters<TileProvider<string>["request"]>[1]> = [];
      const provider: TileProvider<string> = {
        request: (_tile, observer) => {
          observers.push(observer);
          return { requestId: observers.length, cancel() {} };
        },
      };
      const scheduler = new TileWorkerScheduler(layoutTarget(0), {
        provider,
        createWorker: () => worker,
        retryDelayMs: 250,
      });
      const first = { z: 1, x: 0, y: 0 };
      const second = { z: 1, x: 1, y: 0 };
      worker.emit({
        kind: "snapshot",
        snapshot: snapshot(1, [first, second]),
      });
      scheduler.updateResourceDemand([first]);
      observers[0]!({
        phase: "failure",
        reason: "forbidden",
        status: 403,
        retryable: false,
      });
      scheduler.updateResourceDemand([second]);
      worker.emit({
        kind: "resource-request",
        tile: second,
        key: "1/1/0",
        requestId: 91,
      });
      vi.advanceTimersByTime(60_000);

      expect(observers).toHaveLength(1);
      expect(worker.commands).toContainEqual({
        kind: "resource-result",
        key: "1/1/0",
        requestId: 91,
        result: {
          phase: "failure",
          reason: "forbidden",
          status: 403,
          retryable: false,
          scope: "provider",
        },
      });
      expect(worker.commands.some(({ kind }) => kind === "retry")).toBe(false);
      expect(scheduler.debugState.retry).toMatchObject({
        automatic_retry_enabled: false,
        last_status: 403,
      });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a terminal tile failure local to that exact resource", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const observers: Array<Parameters<TileProvider<string>["request"]>[1]> = [];
      const provider: TileProvider<string> = {
        request: (_tile, observer) => {
          observers.push(observer);
          return { requestId: observers.length, cancel() {} };
        },
      };
      const scheduler = new TileWorkerScheduler(layoutTarget(1), {
        provider,
        createWorker: () => worker,
        retryDelayMs: 250,
      });
      const missing = { z: 1, x: 0, y: 0 };
      const available = { z: 1, x: 1, y: 0 };
      scheduler.updateResourceDemand([missing]);
      worker.emit({
        kind: "snapshot",
        snapshot: snapshot(1, [missing, available]),
      });
      observers[0]!({
        phase: "failure",
        reason: "missing",
        status: 404,
        retryable: false,
        scope: "tile",
      });

      scheduler.updateResourceDemand([available]);

      expect(observers).toHaveLength(2);
      expect(scheduler.debugState.retry).toMatchObject({
        automatic_retry_enabled: true,
        scheduled_delay_ms: null,
      });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks requested and in-flight phases for transition and residency requests", () => {
    const worker = new FakeWorker();
    const observers = new Map<string, Parameters<TileProvider<unknown>["request"]>[1]>();
    const provider: TileProvider<unknown> = {
      request: (tile, observer) => {
        observers.set(`${tile.z}/${tile.x}/${tile.y}`, observer);
        return { requestId: observers.size, cancel() {} };
      },
    };
    const scheduler = new TileWorkerScheduler(
      layoutTarget(0),
      { provider, createWorker: () => worker },
    );

    const transition = { z: 1, x: 0, y: 0 };
    worker.emit({
      kind: "resource-request",
      tile: transition,
      key: "1/0/0",
      requestId: 7,
    });
    expect(scheduler.debugState.transition_owned).toEqual({
      requested: 1,
      in_flight: 0,
      total_outstanding: 1,
    });
    expect(scheduler.hasResidentOrInFlightResource(transition)).toBe(false);
    observers.get("1/0/0")!({ phase: "in-flight" });
    expect(scheduler.debugState.transition_owned).toEqual({
      requested: 0,
      in_flight: 1,
      total_outstanding: 1,
    });
    expect(scheduler.hasResidentOrInFlightResource(transition)).toBe(true);

    const committed = { z: 0, x: 0, y: 0 };
    worker.emit({ kind: "snapshot", snapshot: snapshot(1, [committed]) });
    scheduler.updateResourceDemand([committed]);
    expect(scheduler.debugState.residency_hydration).toEqual({
      requested: 1,
      in_flight: 0,
      total_outstanding: 1,
    });
    observers.get("0/0/0")!({ phase: "in-flight" });
    expect(scheduler.debugState).toMatchObject({
      residency_hydration: {
        requested: 0,
        in_flight: 1,
        total_outstanding: 1,
      },
      total: {
        requested: 0,
        in_flight: 1,
        total_outstanding: 1,
      },
      demanded_payload_count: 1,
    });
    observers.get("0/0/0")!({ phase: "response", resource: {} });
    expect(scheduler.hasResidentOrInFlightResource(committed)).toBe(true);
    scheduler.dispose();
  });

  it("starts hot hydration before the rest of the warm committed cut", () => {
    const worker = new FakeWorker();
    const requested: string[] = [];
    const provider: TileProvider<unknown> = {
      request: (tile) => {
        requested.push(`${tile.z}/${tile.x}/${tile.y}`);
        return { requestId: requested.length, cancel() {} };
      },
    };
    const warm = [
      { z: 2, x: 0, y: 0 },
      { z: 2, x: 1, y: 0 },
      { z: 2, x: 2, y: 0 },
    ];
    const scheduler = new TileWorkerScheduler(layoutTarget(2), {
      provider,
      createWorker: () => worker,
      hydrateInitialResources: false,
      initialResourceDemand: [],
    });
    worker.emit({ kind: "snapshot", snapshot: snapshot(0, warm) });

    scheduler.updateResourceDemand(warm, [warm[2]!]);
    expect(requested).toEqual(["2/2/0", "2/0/0", "2/1/0"]);
    scheduler.dispose();
  });

  it("hydrates only seeded initial demand after the first topology snapshot", () => {
    const worker = new FakeWorker();
    const requested: string[] = [];
    const provider: TileProvider<{ id: string }> = {
      request: (tile) => {
        requested.push(`${tile.z}/${tile.x}/${tile.y}`);
        return { requestId: requested.length, cancel() {} };
      },
    };
    const demanded = { z: 1, x: 0, y: 0 };
    const fallback = { z: 1, x: 1, y: 0 };
    const scheduler = new TileWorkerScheduler(
      layoutTarget(1),
      {
        provider,
        createWorker: () => worker,
        hydrateInitialResources: false,
        initialResourceDemand: [demanded],
      },
    );

    expect(requested).toEqual([]);
    worker.emit({
      kind: "snapshot",
      snapshot: snapshot(0, [demanded, fallback]),
    });
    expect(requested).toEqual(["1/0/0"]);
    expect(worker.commands[0]).toMatchObject({
      kind: "initialize",
      hydrateInitialResources: false,
    });
    scheduler.dispose();
  });

  it("keeps off-demand exact work unresolved until it becomes demanded", () => {
    const worker = new FakeWorker();
    let respond: ((resource: { id: string }) => void) | undefined;
    const provider: TileProvider<{ id: string }> = {
      request: (_tile, observer) => {
        respond = (resource) => observer({ phase: "response", resource });
        return { requestId: 21, cancel() {} };
      },
    };
    const scheduler = new TileWorkerScheduler(
      layoutTarget(0),
      { provider, createWorker: () => worker },
    );
    const tile = { z: 0, x: 0, y: 0 };
    scheduler.updateResourceDemand([]);
    worker.emit({
      kind: "resource-request",
      tile,
      key: "0/0/0",
      requestId: 7,
    });
    expect(respond).toBeUndefined();
    expect(worker.commands.some((command) =>
      command.kind === "resource-result" && command.requestId === 7
    )).toBe(false);

    worker.emit({ kind: "snapshot", snapshot: snapshot(1, [tile]) });
    scheduler.updateResourceDemand([tile]);
    expect(respond).toBeDefined();
    respond!({ id: "late-hydration" });
    expect(scheduler.committedResource(tile)).toEqual({ id: "late-hydration" });
  });

  it("lets a session provider satisfy an off-demand transition from cache", () => {
    const worker = new FakeWorker();
    let observer: Parameters<TileProvider<string>["request"]>[1] | undefined;
    const demands: string[][] = [];
    const provider: TileProvider<string> = {
      updateDemand(tiles) {
        demands.push([...tiles].map((tile) =>
          `${tile.z}/${tile.x}/${tile.y}`
        ));
      },
      request: (_tile, next) => {
        observer = next;
        return { requestId: 1, cancel() {} };
      },
    };
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider,
      createWorker: () => worker,
      resourceRetention: "session",
      initialResourceDemand: [],
    });
    const tile = { z: 1, x: 0, y: 0 };
    worker.emit({
      kind: "resource-request",
      tile,
      key: "1/0/0",
      requestId: 31,
    });

    expect(observer).toBeDefined();
    expect(demands).toEqual([[]]);
    expect(worker.commands.some((command) =>
      command.kind === "resource-result" && command.requestId === 31
    )).toBe(false);

    observer!({ phase: "response", resource: "browser-cache-hit" });
    expect(worker.commands).toContainEqual({
      kind: "resource-result",
      key: "1/0/0",
      requestId: 31,
      result: { phase: "response", resource: undefined },
    });
    expect(scheduler.committedResource(tile)).toBe("browser-cache-hit");
    scheduler.dispose();
  });

  it("shares live hydration with a later exact worker requirement", () => {
    const worker = new FakeWorker();
    let observer: Parameters<TileProvider<string>["request"]>[1] | undefined;
    let requestCount = 0;
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: {
        request: (_tile, next) => {
          requestCount += 1;
          observer = next;
          return { requestId: requestCount, cancel() {} };
        },
      },
      createWorker: () => worker,
    });
    const tile = { z: 1, x: 0, y: 0 };
    worker.emit({ kind: "snapshot", snapshot: snapshot(1, [tile]) });
    scheduler.updateResourceDemand([tile]);
    worker.emit({
      kind: "resource-request",
      tile,
      key: "1/0/0",
      requestId: 81,
    });

    expect(requestCount).toBe(1);
    observer!({ phase: "response", resource: "shared-live-resource" });
    expect(scheduler.committedResource(tile)).toBe("shared-live-resource");
    expect(worker.commands).toContainEqual({
      kind: "resource-result",
      key: "1/0/0",
      requestId: 81,
      result: { phase: "response", resource: undefined },
    });
    scheduler.dispose();
  });

  it("cancels shared provider work after its final worker recipient leaves", () => {
    const worker = new FakeWorker();
    let observer: Parameters<TileProvider<string>["request"]>[1] | undefined;
    let cancellationCount = 0;
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: {
        request: (_tile, next) => {
          observer = next;
          return {
            requestId: 1,
            cancel: () => {
              cancellationCount += 1;
            },
          };
        },
      },
      createWorker: () => worker,
    });
    const tile = { z: 1, x: 0, y: 0 };
    worker.emit({
      kind: "resource-request",
      tile,
      key: "1/0/0",
      requestId: 91,
    });
    worker.emit({
      kind: "resource-request",
      tile,
      key: "1/0/0",
      requestId: 92,
    });
    observer!({ phase: "in-flight" });

    worker.emit({ kind: "resource-cancel", key: "1/0/0", requestId: 91 });
    expect(cancellationCount).toBe(0);
    worker.emit({ kind: "resource-cancel", key: "1/0/0", requestId: 92 });

    expect(cancellationCount).toBe(1);
    expect(scheduler.debugState.total.total_outstanding).toBe(0);
    observer!({ phase: "response", resource: "late" });
    expect(scheduler.committedResource(tile)).toBeUndefined();
    scheduler.dispose();
  });

  it("releases direct hydration after demand and its joined worker leave", () => {
    const worker = new FakeWorker();
    let cancellationCount = 0;
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: {
        updateDemand() {},
        request: () => ({
          requestId: 1,
          cancel: () => {
            cancellationCount += 1;
          },
        }),
      },
      createWorker: () => worker,
    });
    const tile = { z: 1, x: 0, y: 0 };
    worker.emit({ kind: "snapshot", snapshot: snapshot(1, [tile]) });
    scheduler.updateResourceDemand([tile]);
    worker.emit({
      kind: "resource-request",
      tile,
      key: "1/0/0",
      requestId: 93,
    });

    scheduler.updateResourceDemand([]);
    worker.emit({ kind: "resource-cancel", key: "1/0/0", requestId: 93 });

    expect(cancellationCount).toBe(1);
    expect(scheduler.debugState.total.total_outstanding).toBe(0);
    scheduler.dispose();
  });

  it("discards live direct hydration that completes after demand leaves", () => {
    const worker = new FakeWorker();
    let observer: Parameters<TileProvider<string>["request"]>[1] | undefined;
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: {
        updateDemand() {},
        request: (_tile, next) => {
          observer = next;
          return { requestId: 1, cancel() {} };
        },
      },
      createWorker: () => worker,
    });
    const tile = { z: 1, x: 0, y: 0 };
    worker.emit({ kind: "snapshot", snapshot: snapshot(1, [tile]) });
    scheduler.updateResourceDemand([tile]);
    observer!({ phase: "in-flight" });

    scheduler.updateResourceDemand([]);
    observer!({ phase: "response", resource: "now-off-demand" });

    expect(scheduler.committedResource(tile)).toBeUndefined();
    expect(scheduler.debugState.total.total_outstanding).toBe(0);
    scheduler.dispose();
  });

  it("advances independent terrain and imagery instances without sharing targets or cuts", async () => {
    const terrainWorker = new FakeWorker();
    const imageryWorker = new FakeWorker();
    const provider: TileProvider<unknown> = {
      request: () => ({ requestId: 1, cancel() {} }),
    };
    const terrain = new TileWorkerScheduler(
      layoutTarget(8, 46, 9),
      { provider, createWorker: () => terrainWorker },
    );
    const imagery = new TileWorkerScheduler(
      layoutTarget(11, 46, 9),
      { provider, createWorker: () => imageryWorker },
    );

    terrain.updateTarget(layoutTarget(9, 47, 10));
    imagery.updateTarget(layoutTarget(13, 48, 11));
    await Promise.resolve();
    terrainWorker.emit({
      kind: "snapshot",
      snapshot: {
        ...snapshot(1, [{ z: 9, x: 241, y: 160 }]),
        target: layoutTarget(9, 47, 10),
      },
    });
    imageryWorker.emit({
      kind: "snapshot",
      snapshot: {
        ...snapshot(1, [{ z: 13, x: 4_100, y: 2_800 }]),
        target: layoutTarget(13, 48, 11),
      },
    });

    expect(terrainWorker.commands.at(-1)).toEqual({
      kind: "target",
      target: layoutTarget(9, 47, 10),
    });
    expect(imageryWorker.commands.at(-1)).toEqual({
      kind: "target",
      target: layoutTarget(13, 48, 11),
    });
    expect(terrain.snapshot.committedCut[0]?.z).toBe(9);
    expect(imagery.snapshot.committedCut[0]?.z).toBe(13);
    terrain.dispose();
    imagery.dispose();
  });

  it("coalesces a burst of targets to the latest target before sending it to the worker", async () => {
    const worker = new FakeWorker();
    const provider: TileProvider<{ id: string }> = {
      request: () => ({ requestId: 1, cancel() {} }),
    };
    const scheduler = new TileWorkerScheduler(
      layoutTarget(2),
      {
        provider,
        createWorker: () => worker,
      },
    );

    scheduler.updateTarget(layoutTarget(2, 1, 0));
    scheduler.updateTarget(layoutTarget(2, 2, 0));
    scheduler.updateTarget(layoutTarget(2, 3, 0));
    expect(scheduler.debugState.target_submission).toEqual({
      pending: true,
      in_flight: false,
    });
    await Promise.resolve();

    expect(scheduler.debugState.target_submission).toEqual({
      pending: false,
      in_flight: true,
    });

    expect(worker.commands.filter(({ kind }) => kind === "target")).toEqual([
      { kind: "target", target: layoutTarget(2, 3, 0) },
    ]);
    scheduler.updateTarget(layoutTarget(2, 0, 1));
    scheduler.updateTarget(layoutTarget(2, 1, 1));
    expect(scheduler.debugState.target_submission).toEqual({
      pending: true,
      in_flight: true,
    });
    await Promise.resolve();
    expect(
      worker.commands.filter(({ kind }) => kind === "target"),
    ).toHaveLength(1);
    worker.emit({ kind: "target-applied", target: layoutTarget(2, 3, 0) });
    await Promise.resolve();
    expect(scheduler.debugState.target_submission).toEqual({
      pending: false,
      in_flight: true,
    });
    expect(worker.commands.filter(({ kind }) => kind === "target")).toEqual([
      { kind: "target", target: layoutTarget(2, 3, 0) },
      { kind: "target", target: layoutTarget(2, 1, 1) },
    ]);
    worker.emit({ kind: "target-applied", target: layoutTarget(2, 1, 1) });
    expect(scheduler.debugState.target_submission).toEqual({
      pending: false,
      in_flight: false,
    });
  });

  it("records a no-op target acknowledgement without publishing a topology snapshot", async () => {
    const worker = new FakeWorker();
    const provider: TileProvider<unknown> = {
      request: () => ({ requestId: 1, cancel() {} }),
    };
    const scheduler = new TileWorkerScheduler(
      layoutTarget(2),
      { provider, createWorker: () => worker },
    );
    let notifications = 0;
    scheduler.subscribe(() => {
      notifications += 1;
    });

    scheduler.updateTarget(layoutTarget(2, 1, 0));
    await Promise.resolve();
    worker.emit({
      kind: "target-applied",
      target: layoutTarget(2, 1, 0),
    });

    expect(scheduler.snapshot).toMatchObject({
      revision: -1,
      target: layoutTarget(2, 1, 0),
    });
    expect(notifications).toBe(1);
    scheduler.dispose();
  });

  it("keeps resources on the main thread and ignores stale worker topology", () => {
    const worker = new FakeWorker();
    let resolve: ((resource: { id: string }) => void) | undefined;
    const provider: TileProvider<{ id: string }> = {
      request: (_tile, observer) => {
        resolve = (resource) => observer({ phase: "response", resource });
        return { requestId: 99, cancel() {} };
      },
    };
    const scheduler = new TileWorkerScheduler(
      layoutTarget(0),
      {
        provider,
        createWorker: () => worker,
      },
    );
    let notifications = 0;
    scheduler.subscribe(() => {
      notifications += 1;
    });
    worker.emit({ kind: "snapshot", snapshot: snapshot(3) });
    worker.emit({
      kind: "resource-request",
      tile: { z: 0, x: 0, y: 0 },
      key: "0/0/0",
      requestId: 7,
    });
    resolve!({ id: "image-resource" });
    // The provider may still invoke a terminal callback after cancellation or
    // completion; it must not resurrect a completed request.
    resolve!({ id: "late-resource" });
    worker.emit({
      kind: "event",
      event: { sequence: 1, revision: 3, kind: "response", requestId: 7 },
    });
    worker.emit({ kind: "snapshot", snapshot: snapshot(2, []) });

    expect(scheduler.committedResource({ z: 0, x: 0, y: 0 })).toEqual({
      id: "image-resource",
    });
    expect(
      worker.commands.filter(({ kind }) => kind === "resource-result"),
    ).toHaveLength(1);
    expect(scheduler.snapshot.revision).toBe(3);
    expect(notifications).toBe(3);
    expect(worker.commands.at(-1)).toEqual({
      kind: "resource-result",
      key: "0/0/0",
      requestId: 7,
      result: { phase: "response", resource: undefined },
    });
    worker.emit({
      kind: "event",
      event: {
        sequence: 2,
        revision: 3,
        kind: "discard",
        tile: { z: 0, x: 0, y: 0 },
        requestId: 7,
      },
    });
    expect(scheduler.committedResource({ z: 0, x: 0, y: 0 })).toBeUndefined();
  });

  it("retains completed session resources across demand, discard, and cut changes", () => {
    const worker = new FakeWorker();
    const observers: Array<Parameters<TileProvider<string>["request"]>[1]> = [];
    const provider: TileProvider<string> = {
      request: (_tile, observer) => {
        observers.push(observer);
        return { requestId: observers.length, cancel() {} };
      },
    };
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider,
      createWorker: () => worker,
      resourceRetention: "session",
    });
    const visited = { z: 1, x: 0, y: 0 };
    const elsewhere = { z: 1, x: 1, y: 0 };

    worker.emit({ kind: "snapshot", snapshot: snapshot(1, [visited]) });
    scheduler.updateResourceDemand([visited]);
    observers[0]!({ phase: "response", resource: "visited-image" });
    scheduler.updateResourceDemand([]);
    worker.emit({
      kind: "event",
      event: {
        sequence: 1,
        revision: 1,
        kind: "discard",
        tile: visited,
        requestId: 1,
      },
    });
    worker.emit({ kind: "snapshot", snapshot: snapshot(2, [elsewhere]) });

    expect(scheduler.committedResource(visited)).toBe("visited-image");
    expect(scheduler.debugState).toMatchObject({
      resident_payload_count: 1,
      session_retained_payload_count: 1,
      resource_retention: "session",
      resource_releases: { total: 0 },
    });

    worker.emit({ kind: "snapshot", snapshot: snapshot(3, [visited]) });
    scheduler.updateResourceDemand([visited]);
    worker.emit({
      kind: "resource-request",
      tile: visited,
      key: "1/0/0",
      requestId: 42,
    });

    expect(observers).toHaveLength(1);
    expect(worker.commands.at(-1)).toEqual({
      kind: "resource-result",
      key: "1/0/0",
      requestId: 42,
      result: { phase: "response", resource: undefined },
    });
    scheduler.dispose();
  });

  it("keeps started session work but still cancels queued speculative work", () => {
    const worker = new FakeWorker();
    const observers = new Map<
      string,
      Parameters<TileProvider<string>["request"]>[1]
    >();
    const cancelled: string[] = [];
    const provider: TileProvider<string> = {
      request: (tile, observer) => {
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        observers.set(key, observer);
        return {
          requestId: observers.size,
          cancel: () => cancelled.push(key),
        };
      },
    };
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider,
      createWorker: () => worker,
      resourceRetention: "session",
    });
    const started = { z: 1, x: 0, y: 0 };
    const queued = { z: 1, x: 1, y: 0 };
    scheduler.updateResourceDemand([started, queued]);
    worker.emit({
      kind: "resource-request",
      tile: started,
      key: "1/0/0",
      requestId: 10,
    });
    worker.emit({
      kind: "resource-request",
      tile: queued,
      key: "1/1/0",
      requestId: 11,
    });
    observers.get("1/0/0")!({ phase: "in-flight" });
    worker.emit({
      kind: "resource-request",
      tile: started,
      key: "1/0/0",
      requestId: 12,
    });

    scheduler.updateResourceDemand([]);
    worker.emit({ kind: "resource-cancel", key: "1/0/0", requestId: 10 });

    expect(cancelled).toEqual(["1/1/0"]);
    expect(scheduler.hasResidentOrInFlightResource(started)).toBe(true);
    observers.get("1/0/0")!({
      phase: "response",
      resource: "started-image",
    });
    expect(scheduler.committedResource(started)).toBe("started-image");
    expect(scheduler.committedResource(queued)).toBeUndefined();
    expect(worker.commands).toContainEqual({
      kind: "resource-result",
      key: "1/0/0",
      requestId: 12,
      result: { phase: "response", resource: undefined },
    });
    scheduler.dispose();
  });

  it("does not manufacture success when a cut cancels queued work", () => {
    const worker = new FakeWorker();
    let cancellationCount = 0;
    const scheduler = new TileWorkerScheduler(layoutTarget(1), {
      provider: {
        request: () => ({
          requestId: 1,
          cancel: () => {
            cancellationCount += 1;
          },
        }),
      },
      createWorker: () => worker,
      resourceRetention: "session",
    });
    const queued = { z: 1, x: 0, y: 0 };
    scheduler.updateResourceDemand([queued]);
    worker.emit({
      kind: "resource-request",
      tile: queued,
      key: "1/0/0",
      requestId: 20,
    });
    worker.emit({
      kind: "resource-request",
      tile: queued,
      key: "1/0/0",
      requestId: 21,
    });

    worker.emit({
      kind: "snapshot",
      snapshot: snapshot(1, [{ z: 1, x: 1, y: 0 }]),
    });

    expect(cancellationCount).toBe(1);
    expect(
      worker.commands.filter((command) =>
        command.kind === "resource-result" &&
        command.key === "1/0/0" &&
        (command.requestId === 20 || command.requestId === 21)
      ),
    ).toEqual([]);
    scheduler.dispose();
  });

  it("schedules retry when detached started session work fails", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      let observer: Parameters<TileProvider<string>["request"]>[1] | undefined;
      const scheduler = new TileWorkerScheduler(layoutTarget(1), {
        provider: {
          request: (_tile, next) => {
            observer = next;
            return { requestId: 1, cancel() {} };
          },
        },
        createWorker: () => worker,
        resourceRetention: "session",
        retryDelayMs: 100,
        retryRandom: () => 0,
      });
      const tile = { z: 1, x: 0, y: 0 };
      scheduler.updateResourceDemand([tile]);
      worker.emit({
        kind: "resource-request",
        tile,
        key: "1/0/0",
        requestId: 30,
      });
      observer!({ phase: "in-flight" });
      worker.emit({ kind: "resource-cancel", key: "1/0/0", requestId: 30 });
      observer!({ phase: "failure", reason: "offline" });

      expect(scheduler.debugState.retry.scheduled_delay_ms).toBe(100);
      vi.advanceTimersByTime(100);
      expect(worker.commands.at(-1)).toEqual({ kind: "retry" });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the default live-resource release policy", () => {
    const worker = new FakeWorker();
    let observer: Parameters<TileProvider<string>["request"]>[1] | undefined;
    const scheduler = new TileWorkerScheduler(layoutTarget(0), {
      provider: {
        request: (_tile, next) => {
          observer = next;
          return { requestId: 1, cancel() {} };
        },
      },
      createWorker: () => worker,
    });
    const tile = { z: 0, x: 0, y: 0 };
    worker.emit({ kind: "snapshot", snapshot: snapshot(1, [tile]) });
    scheduler.updateResourceDemand([tile]);
    observer!({ phase: "response", resource: "live" });

    scheduler.updateResourceDemand([]);

    expect(scheduler.committedResource(tile)).toBeUndefined();
    expect(scheduler.debugState).toMatchObject({
      resource_retention: "live",
      session_retained_payload_count: 0,
      resource_releases: { total: 1, demand: 1 },
    });
    scheduler.dispose();
  });

  it("retains topology resources across demand changes and releases obsolete cuts", () => {
    const worker = new FakeWorker();
    let observer: Parameters<TileProvider<string>["request"]>[1] | undefined;
    const scheduler = new TileWorkerScheduler(layoutTarget(0), {
      provider: {
        request: (_tile, next) => {
          observer = next;
          return { requestId: 1, cancel() {} };
        },
      },
      createWorker: () => worker,
      resourceRetention: "topology",
    });
    const first = { z: 0, x: 0, y: 0 };
    const next = { z: 1, x: 0, y: 0 };
    worker.emit({ kind: "snapshot", snapshot: snapshot(1, [first]) });
    scheduler.updateResourceDemand([first]);
    observer!({ phase: "response", resource: "topology-resource" });

    scheduler.updateResourceDemand([]);
    expect(scheduler.committedResource(first)).toBe("topology-resource");

    worker.emit({ kind: "snapshot", snapshot: snapshot(2, [next]) });
    expect(scheduler.committedResource(first)).toBeUndefined();
    expect(scheduler.debugState).toMatchObject({
      resource_retention: "topology",
      resource_releases: { total: 1, topology: 1 },
    });
    scheduler.dispose();
  });

  it("captures a provider response delivered synchronously from request", () => {
    const worker = new FakeWorker();
    const provider: TileProvider<{ id: string }> = {
      request: (_tile, observer) => {
        observer({ phase: "response", resource: { id: "synchronous" } });
        return { requestId: 12, cancel() {} };
      },
    };
    const scheduler = new TileWorkerScheduler(
      layoutTarget(0),
      { provider, createWorker: () => worker },
    );
    worker.emit({
      kind: "resource-request",
      tile: { z: 0, x: 0, y: 0 },
      key: "0/0/0",
      requestId: 4,
    });

    expect(scheduler.committedResource({ z: 0, x: 0, y: 0 })).toEqual({
      id: "synchronous",
    });
    expect(worker.commands.at(-1)).toEqual({
      kind: "resource-result",
      key: "0/0/0",
      requestId: 4,
      result: { phase: "response", resource: undefined },
    });
  });

  it("captures a synchronous provider in-flight phase on the provisional bridge request", () => {
    const worker = new FakeWorker();
    const provider: TileProvider<unknown> = {
      request: (_tile, observer) => {
        observer({ phase: "in-flight" });
        return { requestId: 12, cancel() {} };
      },
    };
    const scheduler = new TileWorkerScheduler(
      layoutTarget(0),
      { provider, createWorker: () => worker },
    );
    worker.emit({
      kind: "resource-request",
      tile: { z: 0, x: 0, y: 0 },
      key: "0/0/0",
      requestId: 4,
    });

    expect(scheduler.debugState.transition_owned).toEqual({
      requested: 0,
      in_flight: 1,
      total_outstanding: 1,
    });
    scheduler.dispose();
  });

  it("retries transient failures without assigning resource semantics to the bridge", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const provider: TileProvider<unknown> = {
        request: () => ({ requestId: 1, cancel() {} }),
      };
      const scheduler = new TileWorkerScheduler(
        layoutTarget(0),
        {
          provider,
          createWorker: () => worker,
          retryDelayMs: 250,
          retryRandom: () => 0,
        },
      );
      worker.emit({
        kind: "event",
        event: {
          sequence: 1,
          revision: 0,
          kind: "failure",
          tile: { z: 1, x: 0, y: 0 },
          reason: "temporary",
        },
      });

      vi.advanceTimersByTime(249);
      expect(worker.commands.some(({ kind }) => kind === "retry")).toBe(false);
      vi.advanceTimersByTime(1);
      expect(worker.commands.at(-1)).toEqual({ kind: "retry" });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the provider retry wake-up when demand moves away", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      let circuitState: "closed" | "open" = "open";
      let resumes = 0;
      const provider: TileProvider<unknown> = {
        get retryDiagnostics() {
          return {
            state: circuitState,
            last_status: null,
            status_counts: {},
            opaque_failure_count: 1,
            network_failure_count: 1,
            cooldown_until_ms: Date.now() + 100,
            probe_in_flight: false,
          };
        },
        request: () => ({ requestId: 1, cancel() {} }),
        resumeDeferred: () => {
          resumes += 1;
          circuitState = "closed";
        },
      };
      const scheduler = new TileWorkerScheduler(layoutTarget(1), {
        provider,
        createWorker: () => worker,
        resourceRetention: "session",
        retryDelayMs: 100,
        retryRandom: () => 0,
      });
      const failed = { z: 1, x: 0, y: 0 };
      worker.emit({
        kind: "event",
        event: {
          sequence: 1,
          revision: 0,
          kind: "failure",
          tile: failed,
          reason: "opaque fetch failure",
        },
      });
      scheduler.updateResourceDemand([]);

      expect(scheduler.debugState.retry.scheduled_delay_ms).toBe(100);
      vi.advanceTimersByTime(100);

      expect(resumes).toBe(1);
      expect(worker.commands.at(-1)).toEqual({ kind: "retry" });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off failed residency rounds and resets after demand succeeds", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const observers: Array<Parameters<TileProvider<string>["request"]>[1]> = [];
      const provider: TileProvider<string> = {
        request: (_tile, observer) => {
          observers.push(observer);
          return { requestId: observers.length, cancel() {} };
        },
      };
      const scheduler = new TileWorkerScheduler(
        layoutTarget(0),
        {
          provider,
          createWorker: () => worker,
          retryDelayMs: 250,
          retryMaxDelayMs: 1_000,
          retryRandom: () => 0,
        },
      );
      const first = { z: 1, x: 0, y: 0 };
      const second = { z: 1, x: 1, y: 0 };
      worker.emit({
        kind: "snapshot",
        snapshot: snapshot(1, [first, second]),
      });
      scheduler.updateResourceDemand([first]);

      observers[0]!({ phase: "failure", reason: "offline" });
      expect(scheduler.debugState.retry).toMatchObject({
        failed_rounds: 0,
        scheduled_delay_ms: 250,
      });
      scheduler.updateResourceDemand([second]);
      expect(observers).toHaveLength(1);
      vi.advanceTimersByTime(250);
      expect(observers).toHaveLength(2);

      observers[1]!({ phase: "failure", reason: "still offline" });
      expect(scheduler.debugState.retry).toMatchObject({
        failed_rounds: 1,
        scheduled_delay_ms: 500,
      });
      vi.advanceTimersByTime(500);
      expect(observers).toHaveLength(3);

      observers[2]!({ phase: "response", resource: "loaded" });
      expect(scheduler.debugState.retry).toMatchObject({
        failed_rounds: 0,
        scheduled_delay_ms: null,
      });
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
