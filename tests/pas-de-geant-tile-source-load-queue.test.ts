import { describe, expect, it, vi } from "vitest";
import {
  TileSourceLoadQueue,
  type TileSourceLoadEvent,
} from "../apps/pas-de-geant/src/tile-source-load-queue.js";

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
  it("does not carry an empty warm plan into a later request burst", async () => {
    const pending = Array.from({ length: 4 }, () => deferred<string>());
    const starts: string[] = [];
    const queue = new TileSourceLoadQueue<string, string>({
      concurrency: 4,
      warmRamp: {},
      loadFromNetwork: async (source) => {
        starts.push(source);
        return await pending[Number(source)]!.promise;
      },
    });
    queue.beginWarmRamp();
    await Promise.resolve();
    expect(queue.metrics).toMatchObject({
      warmRampActive: false,
      warmRampLimit: 4,
    });

    for (let index = 0; index < 4; index += 1) {
      queue.request({ key: String(index), source: String(index) }, () => {});
    }
    await vi.waitFor(() => expect(starts).toHaveLength(4));
    pending.forEach((job) => job.resolve("ready"));
  });

  it("ends a completed short warm ramp before a later stationary burst", async () => {
    const first = deferred<string>();
    const later = Array.from({ length: 4 }, () => deferred<string>());
    const starts: string[] = [];
    const queue = new TileSourceLoadQueue<string, string>({
      concurrency: 4,
      warmRamp: {},
      loadFromNetwork: async (source) => {
        starts.push(source);
        if (source === "first") return await first.promise;
        return await later[Number(source.slice(5))]!.promise;
      },
    });
    queue.beginWarmRamp();
    queue.request({ key: "first", source: "first" }, () => {});
    await vi.waitFor(() => expect(starts).toEqual(["first"]));

    first.resolve("ready");
    await vi.waitFor(() => {
      expect(queue.metrics).toMatchObject({
        inFlight: 0,
        warmRampActive: false,
        warmRampLimit: 4,
      });
    });
    for (let index = 0; index < 4; index += 1) {
      queue.request({
        key: `later${index}`,
        source: `later${index}`,
      }, () => {});
    }
    await vi.waitFor(() => expect(starts).toHaveLength(5));
    expect(queue.metrics.inFlight).toBe(4);
    later.forEach((job) => job.resolve("ready"));
  });

  it("starts an admitted hot network miss before colder queued cache work", async () => {
    const hotNetwork = deferred<string>();
    const starts: string[] = [];
    const queue = new TileSourceLoadQueue<string, string>({
      concurrency: 1,
      loadFromCache: async (source) => {
        starts.push(`cache:${source}`);
        return undefined;
      },
      loadFromNetwork: async (source) => {
        starts.push(`network:${source}`);
        if (source === "hot") return await hotNetwork.promise;
        return "cold-ready";
      },
    });

    queue.request({ key: "hot", source: "hot", hot: true }, () => {});
    queue.request({ key: "cold", source: "cold" }, () => {});

    await vi.waitFor(() => {
      expect(starts).toEqual(["cache:hot", "network:hot"]);
    });
    expect(queue.metrics).toMatchObject({
      cacheQueued: 1,
      networkActive: 1,
    });

    hotNetwork.resolve("hot-ready");
    await vi.waitFor(() => {
      expect(starts).toEqual([
        "cache:hot",
        "network:hot",
        "cache:cold",
        "network:cold",
      ]);
    });
  });

  it("serves a cache hit while the provider circuit is open", async () => {
    const networkLoads: string[] = [];
    const queue = new TileSourceLoadQueue<string, string>({
      concurrency: 2,
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

    queue.updateDemand(["trip"]);
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
      concurrency: 2,
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
      concurrency: 1,
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
      concurrency: 1,
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
