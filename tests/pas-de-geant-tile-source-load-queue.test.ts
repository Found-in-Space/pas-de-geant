import { describe, expect, it, vi } from "vitest";
import {
  TileSourceLoadQueue,
  type TileSourceLoadEvent,
} from "../packages/pas-de-geant/src/worlds/tile-source-load-queue.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function eventsFor<T>(): TileSourceLoadEvent<T>[] {
  return [];
}

describe("TileSourceLoadQueue", () => {
  it("starts every acquisition while processing by priority within its own limit", async () => {
    const acquisitions: string[] = [];
    const processingStarts: string[] = [];
    const processingReleases = new Map<string, () => void>();
    const responses: string[] = [];
    let activeProcessing = 0;
    let maximumActiveProcessing = 0;
    const queue = new TileSourceLoadQueue<string, string, string>({
      processingConcurrency: 2,
      loadFromNetwork: async (source) => {
        acquisitions.push(source);
        return `payload-${source}`;
      },
      process: async (source) => {
        processingStarts.push(source);
        activeProcessing += 1;
        maximumActiveProcessing = Math.max(
          maximumActiveProcessing,
          activeProcessing,
        );
        await new Promise<void>((resolve) => {
          processingReleases.set(source, resolve);
        });
        activeProcessing -= 1;
        return `ready-${source}`;
      },
    });
    for (let priority = 0; priority < 8; priority += 1) {
      const source = String(priority);
      queue.request({ key: source, source, priority }, (event) => {
        if (event.phase === "response") responses.push(event.value);
      });
    }

    await vi.waitFor(() => {
      expect(acquisitions).toHaveLength(8);
      expect(processingStarts).toEqual(["7", "6"]);
    });
    expect(queue.metrics).toMatchObject({
      acquisitionActive: 0,
      processingActive: 2,
      processingQueued: 6,
    });

    for (const expected of [["5", "4"], ["3", "2"], ["1", "0"]]) {
      for (const source of processingStarts.slice(-2)) {
        processingReleases.get(source)!();
      }
      await vi.waitFor(() => {
        expect(processingStarts.slice(-2)).toEqual(expected);
      });
    }
    for (const source of processingStarts.slice(-2)) {
      processingReleases.get(source)!();
    }
    await vi.waitFor(() => expect(responses).toHaveLength(8));
    expect(maximumActiveProcessing).toBe(2);
    expect(queue.metrics.inFlight).toBe(0);
  });

  it("treats a cached processing failure as a miss", async () => {
    const networkLoads: string[] = [];
    const events = eventsFor<string>();
    const queue = new TileSourceLoadQueue<string, string, string>({
      processingConcurrency: 1,
      loadFromCache: async () => "corrupt",
      loadFromNetwork: async (source) => {
        networkLoads.push(source);
        return "valid";
      },
      process: async (_source, payload) => {
        if (payload === "corrupt") throw new Error("invalid cache payload");
        return "decoded";
      },
      classifyNetworkFailure: () => ({ systemic: false }),
    });
    queue.request({ key: "tile", source: "tile" }, (event) => events.push(event));

    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({
      phase: "response",
      value: "decoded",
      source: "network",
    }));
    expect(networkLoads).toEqual(["tile"]);
    expect(queue.metrics).toMatchObject({
      cacheLookupTotal: 1,
      cacheHitTotal: 0,
      sourceLoadTotal: 1,
      failureTotal: 0,
    });
  });

  it("coalesces processing and cancels queued or active work after the last consumer", async () => {
    const acquisitions: string[] = [];
    const processingStarts: string[] = [];
    let activeSignal: AbortSignal | undefined;
    const queue = new TileSourceLoadQueue<string, string, string>({
      processingConcurrency: 1,
      loadFromNetwork: async (source) => {
        acquisitions.push(source);
        return source;
      },
      process: async (source, _payload, signal) => {
        processingStarts.push(source);
        if (source !== "shared") return source;
        activeSignal = signal;
        return await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const first = queue.request(
      { key: "shared", source: "shared", priority: 2 },
      () => {},
    );
    const joined = queue.request(
      { key: "shared", source: "shared", priority: 2 },
      () => {},
    );
    const queued = queue.request(
      { key: "queued", source: "queued", priority: 1 },
      () => {},
    );

    await vi.waitFor(() => {
      expect(acquisitions).toEqual(["shared", "queued"]);
      expect(processingStarts).toEqual(["shared"]);
      expect(queue.metrics.processingQueued).toBe(1);
    });
    queued.cancel();
    expect(queue.metrics.processingQueued).toBe(0);
    first.cancel();
    expect(activeSignal?.aborted).toBe(false);
    joined.cancel();
    expect(activeSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(queue.metrics.inFlight).toBe(0));
    expect(processingStarts).toEqual(["shared"]);
    expect(queue.metrics.sharedRequestTotal).toBe(1);
    expect(queue.metrics.sourceCancellationTotal).toBe(1);
  });

  it("serves a cache hit while the provider circuit is open", async () => {
    const networkLoads: string[] = [];
    const queue = new TileSourceLoadQueue<string, string>({
      loadConcurrency: 2,
      wallNow: () => 0,
      loadFromCache: async (source) =>
        source === "cached" ? "from-cache" : undefined,
      loadFromNetwork: async (source) => {
        networkLoads.push(source);
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
      classifyNetworkFailure: (error) => ({
        systemic: true,
        status: (error as { status?: number }).status,
        retryAfterMs: 60_000,
      }),
    });
    const failed = eventsFor<string>();
    queue.request({ key: "trip", source: "trip" }, (event) =>
      failed.push(event)
    );
    await vi.waitFor(() => {
      expect(failed.at(-1)?.phase).toBe("failure");
    });
    expect(queue.retryDiagnostics.state).toBe("open");

    const cached = eventsFor<string>();
    queue.request({ key: "cached", source: "cached" }, (event) =>
      cached.push(event)
    );
    await vi.waitFor(() => {
      expect(cached.at(-1)).toMatchObject({
        phase: "response",
        value: "from-cache",
        source: "cache",
      });
    });

    expect(networkLoads).toEqual(["trip"]);
    expect(queue.metrics.cacheHitTotal).toBe(1);
    expect(queue.retryDiagnostics.state).toBe("open");
  });

  it("closes a half-open probe on a tile-local failure while failing that tile", async () => {
    const attempts: string[] = [];
    const queue = new TileSourceLoadQueue<string, string>({
      loadConcurrency: 2,
      wallNow: () => 0,
      loadFromNetwork: async (source) => {
        attempts.push(source);
        if (source === "systemic") {
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }
        if (source === "missing") {
          throw Object.assign(new Error("not found"), { status: 404 });
        }
        return "ready";
      },
      classifyNetworkFailure: (error) => {
        const status = (error as { status?: number }).status;
        return {
          systemic: status !== 404,
          status,
          ...(status === 429 ? { retryAfterMs: 0 } : {}),
        };
      },
    });
    const systemic = eventsFor<string>();
    queue.request(
      { key: "systemic", source: "systemic" },
      (event) => systemic.push(event),
    );
    await vi.waitFor(() => expect(queue.retryDiagnostics.state).toBe("open"));

    queue.resumeDeferred();
    const missing = eventsFor<string>();
    queue.request({ key: "missing", source: "missing" }, (event) =>
      missing.push(event)
    );
    await vi.waitFor(() => {
      expect(missing.at(-1)).toMatchObject({
        phase: "failure",
        metadata: { systemic: false, status: 404 },
      });
    });

    expect(queue.retryDiagnostics.state).toBe("closed");
    const ready = eventsFor<string>();
    queue.request({ key: "ready", source: "ready" }, (event) =>
      ready.push(event)
    );
    await vi.waitFor(() => expect(ready.at(-1)?.phase).toBe("response"));
    expect(attempts).toEqual(["systemic", "missing", "ready"]);
  });

  it("keeps an aborted job's slot until it settles and aborts after the last consumer", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let firstSignal: AbortSignal | undefined;
    const queue = new TileSourceLoadQueue<string, string>({
      loadConcurrency: 1,
      loadFromNetwork: async (source, signal) => {
        started.push(source);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (source === "first") firstSignal = signal;
        try {
          return await (source === "first" ? first.promise : second.promise);
        } finally {
          active -= 1;
        }
      },
    });

    const firstHandle = queue.request(
      { key: "first", source: "first" },
      () => {},
    );
    const joinedHandle = queue.request(
      { key: "first", source: "first" },
      () => {},
    );
    await vi.waitFor(() => expect(started).toEqual(["first"]));

    firstHandle.cancel();
    expect(firstSignal?.aborted).toBe(false);
    joinedHandle.cancel();
    expect(firstSignal?.aborted).toBe(true);

    queue.request({ key: "second", source: "second" }, () => {});
    await settle();
    expect(started).toEqual(["first"]);
    expect(queue.metrics.inFlight).toBe(1);

    first.reject(new DOMException("aborted", "AbortError"));
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    expect(maximumActive).toBe(1);
    second.resolve("ready");
    await vi.waitFor(() => expect(queue.metrics.inFlight).toBe(0));
  });

  it("leaves unattempted jobs deferred after a systemic failure", async () => {
    const attempts: string[] = [];
    const firstEvents = eventsFor<string>();
    const deferredEvents = eventsFor<string>();
    const queue = new TileSourceLoadQueue<string, string>({
      loadConcurrency: 1,
      wallNow: () => 0,
      loadFromNetwork: async (source) => {
        attempts.push(source);
        throw Object.assign(new Error("provider unavailable"), { status: 503 });
      },
      classifyNetworkFailure: (error) => ({
        systemic: true,
        status: (error as { status?: number }).status,
        retryAfterMs: 60_000,
      }),
    });

    queue.request({ key: "attempted", source: "attempted" }, (event) =>
      firstEvents.push(event)
    );
    const deferredHandle = queue.request(
      { key: "deferred", source: "deferred" },
      (event) => deferredEvents.push(event),
    );
    await vi.waitFor(() => {
      expect(firstEvents.at(-1)?.phase).toBe("failure");
    });

    expect(attempts).toEqual(["attempted"]);
    expect(deferredEvents).toEqual([]);
    expect(queue.metrics.networkDeferred).toBe(1);
    expect(queue.metrics.queued).toBe(1);
    expect(queue.retryDiagnostics.state).toBe("open");
    deferredHandle.cancel();
  });
});
