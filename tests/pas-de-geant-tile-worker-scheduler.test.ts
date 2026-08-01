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
    target: { z: 0, x: 0, y: 0 },
    committedCut,
    requestedCut: committedCut,
    graph: { retained: committedCut, groups: [], batches: [] },
    requirements: [],
  } as const;
}

describe("Tile worker scheduler bridge", () => {
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
      demanded,
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

  it("commits off-demand fallback and hydrates an unchanged committed tile on demand", () => {
    const worker = new FakeWorker();
    let respond: ((resource: { id: string }) => void) | undefined;
    const provider: TileProvider<{ id: string }> = {
      request: (_tile, observer) => {
        respond = (resource) => observer({ phase: "response", resource });
        return { requestId: 21, cancel() {} };
      },
    };
    const scheduler = new TileWorkerScheduler(
      { z: 0, x: 0, y: 0 },
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
    expect(worker.commands.at(-1)).toMatchObject({
      kind: "resource-result",
      requestId: 7,
      result: { phase: "response" },
    });

    worker.emit({ kind: "snapshot", snapshot: snapshot(1, [tile]) });
    scheduler.updateResourceDemand([tile]);
    respond!({ id: "late-hydration" });
    expect(scheduler.committedResource(tile)).toEqual({ id: "late-hydration" });
  });

  it("advances independent terrain and imagery instances without sharing targets or cuts", async () => {
    const terrainWorker = new FakeWorker();
    const imageryWorker = new FakeWorker();
    const provider: TileProvider<unknown> = {
      request: () => ({ requestId: 1, cancel() {} }),
    };
    const terrain = new TileWorkerScheduler(
      { z: 8, x: 120, y: 80 },
      { provider, createWorker: () => terrainWorker },
    );
    const imagery = new TileWorkerScheduler(
      { z: 11, x: 1_024, y: 700 },
      { provider, createWorker: () => imageryWorker },
    );

    terrain.updateTarget({ z: 9, x: 241, y: 160 });
    imagery.updateTarget({ z: 13, x: 4_100, y: 2_800 });
    await Promise.resolve();
    terrainWorker.emit({
      kind: "snapshot",
      snapshot: {
        ...snapshot(1, [{ z: 9, x: 241, y: 160 }]),
        target: { z: 9, x: 241, y: 160 },
      },
    });
    imageryWorker.emit({
      kind: "snapshot",
      snapshot: {
        ...snapshot(1, [{ z: 13, x: 4_100, y: 2_800 }]),
        target: { z: 13, x: 4_100, y: 2_800 },
      },
    });

    expect(terrainWorker.commands.at(-1)).toEqual({
      kind: "target",
      target: { z: 9, x: 241, y: 160 },
    });
    expect(imageryWorker.commands.at(-1)).toEqual({
      kind: "target",
      target: { z: 13, x: 4_100, y: 2_800 },
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
      { z: 2, x: 0, y: 0 },
      {
        provider,
        createWorker: () => worker,
      },
    );

    scheduler.updateTarget({ z: 2, x: 1, y: 0 });
    scheduler.updateTarget({ z: 2, x: 2, y: 0 });
    scheduler.updateTarget({ z: 2, x: 3, y: 0 });
    await Promise.resolve();

    expect(worker.commands.filter(({ kind }) => kind === "target")).toEqual([
      { kind: "target", target: { z: 2, x: 3, y: 0 } },
    ]);
    scheduler.updateTarget({ z: 2, x: 0, y: 1 });
    scheduler.updateTarget({ z: 2, x: 1, y: 1 });
    await Promise.resolve();
    expect(
      worker.commands.filter(({ kind }) => kind === "target"),
    ).toHaveLength(1);
    worker.emit({ kind: "target-applied" });
    await Promise.resolve();
    expect(worker.commands.filter(({ kind }) => kind === "target")).toEqual([
      { kind: "target", target: { z: 2, x: 3, y: 0 } },
      { kind: "target", target: { z: 2, x: 1, y: 1 } },
    ]);
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
      { z: 0, x: 0, y: 0 },
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

  it("captures a provider response delivered synchronously from request", () => {
    const worker = new FakeWorker();
    const provider: TileProvider<{ id: string }> = {
      request: (_tile, observer) => {
        observer({ phase: "response", resource: { id: "synchronous" } });
        return { requestId: 12, cancel() {} };
      },
    };
    const scheduler = new TileWorkerScheduler(
      { z: 0, x: 0, y: 0 },
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

  it("retries transient failures without assigning resource semantics to the bridge", () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const provider: TileProvider<unknown> = {
        request: () => ({ requestId: 1, cancel() {} }),
      };
      const scheduler = new TileWorkerScheduler(
        { z: 0, x: 0, y: 0 },
        { provider, createWorker: () => worker, retryDelayMs: 250 },
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
});
