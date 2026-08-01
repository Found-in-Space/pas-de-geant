import { describe, expect, it } from "vitest";
import {
  FakeTileProvider,
  type FakeTileResource,
} from "../apps/pas-de-geant/src/construct-fake-tile-provider.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "../apps/pas-de-geant/src/construct-tile-provider.js";
import {
  TileTransitionScheduler,
  type LayoutSource,
  type SchedulerEvent,
  type SchedulerSnapshot,
} from "../apps/pas-de-geant/src/construct-transition-scheduler.js";
import {
  assertAdmissibleCut,
  tileIdentityKey,
  type TileIdentity,
} from "../apps/pas-de-geant/src/construct-transition-planner.js";
import { calculateTileOnionPlan } from "../apps/pas-de-geant/src/tile-onion-core.js";

function uniformCut(zoom: number): TileIdentity[] {
  const width = 2 ** zoom;
  return Array.from({ length: width * width }, (_, index) => ({
    z: zoom,
    x: index % width,
    y: Math.floor(index / width),
  }));
}

function refine(
  cut: readonly TileIdentity[],
  parent: TileIdentity,
): TileIdentity[] {
  return [
    ...cut.filter((tile) => tileIdentityKey(tile) !== tileIdentityKey(parent)),
    ...[0, 1, 2, 3].map((index) => ({
      z: parent.z + 1,
      x: parent.x * 2 + index % 2,
      y: parent.y * 2 + Math.floor(index / 2),
    })),
  ];
}

class FixtureLayoutSource implements LayoutSource<string> {
  constructor(private readonly cuts: Readonly<Record<string, readonly TileIdentity[]>>) {}
  calculate(target: string): readonly TileIdentity[] {
    const cut = this.cuts[target];
    if (!cut) throw new Error(`Unknown fixture ${target}.`);
    return cut;
  }
}

function eventCollector(events: SchedulerEvent[]) {
  return (_snapshot: unknown, event?: SchedulerEvent): void => {
    if (event) events.push(event);
  };
}

describe("The Construct deterministic fake tile provider", () => {
  it("emits request, in-flight, then deterministic response", () => {
    const provider = new FakeTileProvider({ latencyMs: 100, jitterMs: 0 });
    const phases: string[] = [];
    provider.subscribe((event) => phases.push(event.phase));
    provider.request({ z: 2, x: 1, y: 1 }, (result) => phases.push(`observer:${result.phase}`));

    expect(phases).toEqual(["request"]);
    provider.advanceBy(50);
    expect(phases).toEqual(["request", "in-flight", "observer:in-flight"]);
    provider.advanceBy(50);
    expect(phases).toEqual([
      "request",
      "in-flight",
      "observer:in-flight",
      "response",
      "observer:response",
    ]);
  });

  it("fails every first attempt reproducibly and succeeds on retry", () => {
    const provider = new FakeTileProvider({
      latencyMs: 10,
      jitterMs: 0,
      failureMode: "transient-first-attempt",
    });
    const results: string[] = [];
    const request = (): void => {
      provider.request({ z: 3, x: 2, y: 4 }, (result) => {
        if (result.phase !== "in-flight") results.push(result.phase);
      });
      provider.advanceBy(10);
    };
    request();
    request();
    expect(results).toEqual(["failure", "response"]);
  });

  it("cancels without later delivering a response", () => {
    const provider = new FakeTileProvider({ latencyMs: 10, jitterMs: 0 });
    const phases: string[] = [];
    const handle = provider.request({ z: 1, x: 0, y: 0 }, (result) =>
      phases.push(result.phase),
    );
    handle.cancel();
    provider.advanceBy(20);
    expect(phases).toEqual([]);
  });
});

describe("The Construct transition scheduler", () => {
  it("hydrates the initial committed fallback without changing its cut", () => {
    const base = uniformCut(1);
    const provider = new FakeTileProvider({ latencyMs: 10, jitterMs: 0 });
    const scheduler = new TileTransitionScheduler<string, FakeTileResource>(
      "base",
      new FixtureLayoutSource({ base }),
      provider,
      { hydrateInitialResources: true },
    );
    const events: SchedulerEvent[] = [];
    scheduler.subscribe(eventCollector(events));

    expect(scheduler.snapshot.requirements).toHaveLength(base.length);
    expect(scheduler.snapshot.graph.groups).toEqual([]);
    provider.advanceBy(10);

    expect(scheduler.snapshot.requirements).toEqual([]);
    expect(scheduler.snapshot.committedCut.map(tileIdentityKey).sort()).toEqual(
      base.map(tileIdentityKey).sort(),
    );
    expect(events.some(({ kind }) => kind === "atomic-swap")).toBe(false);
    for (const tile of base) {
      expect(scheduler.committedResource(tile)?.tile).toEqual(tile);
    }
  });

  it("keeps a failed initial tile as a retryable committed gap", () => {
    const base = uniformCut(1);
    const provider = new FakeTileProvider({
      latencyMs: 10,
      jitterMs: 0,
      failureMode: "transient-first-attempt",
    });
    const scheduler = new TileTransitionScheduler<string, FakeTileResource>(
      "base",
      new FixtureLayoutSource({ base }),
      provider,
      { hydrateInitialResources: true },
    );

    provider.advanceBy(10);
    expect(scheduler.snapshot.requirements.every(({ state }) => state === "failed"))
      .toBe(true);
    expect(scheduler.snapshot.committedCut).toHaveLength(base.length);

    scheduler.retryFailed();
    provider.advanceBy(10);
    expect(scheduler.snapshot.requirements).toEqual([]);
    expect(base.every((tile) => scheduler.committedResource(tile))).toBe(true);
  });

  it("never punches a hole and commits a group only when every child is ready", () => {
    const base = uniformCut(1);
    const parent = { z: 1, x: 0, y: 0 };
    const desired = refine(base, parent);
    const provider = new FakeTileProvider({ latencyMs: 100, jitterMs: 0 });
    const scheduler = new TileTransitionScheduler<string, FakeTileResource>(
      "base",
      new FixtureLayoutSource({ base, desired }),
      provider,
    );
    const committedCuts: Array<readonly TileIdentity[]> = [];
    const events: SchedulerEvent[] = [];
    let lastNotified: SchedulerSnapshot<string> | undefined;
    scheduler.subscribe((snapshot, event) => {
      if (event) events.push(event);
      committedCuts.push(snapshot.committedCut);
      lastNotified = snapshot;
    });

    scheduler.updateTarget("desired");
    provider.advanceBy(99);
    expect(scheduler.snapshot.committedCut).toEqual(
      expect.arrayContaining([expect.objectContaining(parent)]),
    );
    expect(events.some(({ kind }) => kind === "atomic-swap")).toBe(false);
    provider.advanceBy(1);

    expect(events.filter(({ kind }) => kind === "atomic-swap")).toHaveLength(1);
    expect(scheduler.snapshot.committedCut.map(tileIdentityKey)).not.toContain("1/0/0");
    expect(lastNotified!.graph.groups).toEqual([]);
    for (const cut of committedCuts) {
      expect(() => assertAdmissibleCut(cut, "Emitted committed cut")).not.toThrow();
    }
  });

  it("reuses exact still-needed requests across a new target and cancels obsolete work", () => {
    const base = uniformCut(1);
    const first = refine(base, { z: 1, x: 0, y: 0 });
    const latest = refine(first, { z: 1, x: 1, y: 1 });
    const provider = new FakeTileProvider({ latencyMs: 100, jitterMs: 0 });
    const providerEvents: { phase: string; key: string; requestId: number }[] = [];
    provider.subscribe((event) => providerEvents.push({
      phase: event.phase,
      key: tileIdentityKey(event.tile),
      requestId: event.requestId,
    }));
    const scheduler = new TileTransitionScheduler<string, FakeTileResource>(
      "base",
      new FixtureLayoutSource({ base, first, latest }),
      provider,
    );

    scheduler.updateTarget("first");
    const reusedKey = "2/0/0";
    const reusedRequestId = providerEvents.find(({ key }) => key === reusedKey)!.requestId;
    scheduler.updateTarget("latest");

    expect(providerEvents.filter(({ phase, key }) => phase === "request" && key === reusedKey))
      .toHaveLength(1);
    expect(scheduler.snapshot.requirements.find(({ tile }) => tileIdentityKey(tile) === reusedKey)?.requestId)
      .toBe(reusedRequestId);

    scheduler.updateTarget("base");
    expect(providerEvents.filter(({ phase }) => phase === "cancellation").length).toBeGreaterThan(0);
    provider.advanceBy(200);
    expect(scheduler.snapshot.committedCut.map(tileIdentityKey).sort()).toEqual(
      base.map(tileIdentityKey).sort(),
    );
  });

  it("ignores a stale response from a cancelled request token", () => {
    class HostileProvider implements TileProvider<FakeTileResource> {
      nextId = 1;
      observers = new Map<number, (result: TileProviderResult<FakeTileResource>) => void>();
      tiles = new Map<number, TileIdentity>();
      request(
        tile: TileIdentity,
        observer: (result: TileProviderResult<FakeTileResource>) => void,
      ): TileRequestHandle {
        const requestId = this.nextId++;
        this.observers.set(requestId, observer);
        this.tiles.set(requestId, tile);
        return { requestId, cancel() {} };
      }
      respond(requestId: number): void {
        this.observers.get(requestId)?.({
          phase: "response",
          resource: { tile: this.tiles.get(requestId)!, requestId, attempt: 1 },
        });
      }
    }
    const base = uniformCut(1);
    const desired = refine(base, { z: 1, x: 0, y: 0 });
    const provider = new HostileProvider();
    const scheduler = new TileTransitionScheduler<string, FakeTileResource>(
      "base",
      new FixtureLayoutSource({ base, desired }),
      provider,
    );
    scheduler.updateTarget("desired");
    const staleIds = scheduler.snapshot.requirements.map(({ requestId }) => requestId);
    scheduler.updateTarget("base");
    for (const requestId of staleIds) provider.respond(requestId);

    expect(scheduler.snapshot.requirements).toEqual([]);
    expect(scheduler.snapshot.committedCut.map(tileIdentityKey).sort()).toEqual(
      base.map(tileIdentityKey).sort(),
    );
  });

  it("lets an independent group commit while a failed group stays covered", () => {
    const base = uniformCut(1);
    const blockedParent = { z: 1, x: 0, y: 0 };
    const freeParent = { z: 1, x: 1, y: 1 };
    const desired = refine(refine(base, blockedParent), freeParent);
    const provider = new FakeTileProvider({
      latencyMs: 10,
      jitterMs: 0,
      failureMode: "persistent-selected",
      selectedFailureKey: "2/0/0",
    });
    const scheduler = new TileTransitionScheduler<string, FakeTileResource>(
      "base",
      new FixtureLayoutSource({ base, desired }),
      provider,
    );
    scheduler.updateTarget("desired");
    provider.advanceBy(10);

    const committed = scheduler.snapshot.committedCut.map(tileIdentityKey);
    expect(committed).toContain("1/0/0");
    expect(committed).not.toContain("1/1/1");
    expect(committed).toEqual(expect.arrayContaining(["2/2/2", "2/3/2", "2/2/3", "2/3/3"]));
    expect(scheduler.snapshot.requirements.some(({ state }) => state === "failed")).toBe(true);
    expect(() => assertAdmissibleCut(scheduler.snapshot.committedCut)).not.toThrow();
  });

  it("retries a transient failure and then commits the blocked group", () => {
    const base = uniformCut(1);
    const desired = refine(base, { z: 1, x: 0, y: 0 });
    const provider = new FakeTileProvider({
      latencyMs: 10,
      jitterMs: 0,
      failureMode: "transient-first-attempt",
    });
    const scheduler = new TileTransitionScheduler<string, FakeTileResource>(
      "base",
      new FixtureLayoutSource({ base, desired }),
      provider,
    );
    scheduler.updateTarget("desired");
    provider.advanceBy(10);
    expect(scheduler.snapshot.requirements.every(({ state }) => state === "failed")).toBe(true);
    expect(scheduler.snapshot.committedCut.map(tileIdentityKey)).toContain("1/0/0");

    scheduler.retryFailed();
    provider.advanceBy(10);
    expect(scheduler.snapshot.requirements).toEqual([]);
    expect(scheduler.snapshot.graph.groups).toEqual([]);
    expect(scheduler.snapshot.committedCut.map(tileIdentityKey)).not.toContain("1/0/0");
  });

  it("does not retain a released resource as a warm cache entry", () => {
    const base = uniformCut(1);
    const refined = refine(base, { z: 1, x: 0, y: 0 });
    const provider = new FakeTileProvider({ latencyMs: 10, jitterMs: 0 });
    const requests: string[] = [];
    provider.subscribe((event) => {
      if (event.phase === "request") requests.push(tileIdentityKey(event.tile));
    });
    const scheduler = new TileTransitionScheduler<string, FakeTileResource>(
      "base",
      new FixtureLayoutSource({ base, refined }),
      provider,
    );

    scheduler.updateTarget("refined");
    provider.advanceBy(10);
    scheduler.updateTarget("base");
    provider.advanceBy(10);
    scheduler.updateTarget("refined");
    provider.advanceBy(10);

    expect(requests.filter((key) => key === "2/0/0")).toHaveLength(2);
    expect(requests.filter((key) => key === "1/0/0")).toHaveLength(1);
  });

  it("keeps every progressive complex swap admissible and commits before global completion", () => {
    const first = calculateTileOnionPlan({
      latitudeDegrees: 10,
      longitudeDegrees: 0,
      maxZoom: 5,
    }).leaves;
    const second = calculateTileOnionPlan({
      latitudeDegrees: 10,
      longitudeDegrees: 90,
      maxZoom: 5,
    }).leaves;
    const provider = new FakeTileProvider({ latencyMs: 120, jitterMs: 90 });
    const scheduler = new TileTransitionScheduler<string, FakeTileResource>(
      "first",
      new FixtureLayoutSource({ first, second }),
      provider,
    );
    const swapSnapshots: Array<readonly TileIdentity[]> = [];
    let committedWhileWorkRemained = false;
    scheduler.subscribe((snapshot, event) => {
      if (event?.kind !== "atomic-swap") return;
      swapSnapshots.push(snapshot.committedCut);
      if (snapshot.graph.groups.length > 0) committedWhileWorkRemained = true;
    });

    scheduler.updateTarget("second");
    for (let index = 0; index < 20 && scheduler.snapshot.graph.groups.length > 0; index += 1) {
      provider.advanceBy(25);
    }

    expect(swapSnapshots.length).toBeGreaterThan(1);
    expect(committedWhileWorkRemained).toBe(true);
    for (const cut of swapSnapshots) {
      expect(() => assertAdmissibleCut(cut, "Progressive committed cut")).not.toThrow();
    }
    expect(scheduler.snapshot.graph.groups).toEqual([]);
    expect(new Set(scheduler.snapshot.committedCut.map(tileIdentityKey))).toEqual(
      new Set(second.map(tileIdentityKey)),
    );
  });
});
