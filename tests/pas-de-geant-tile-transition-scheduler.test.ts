import { describe, expect, it } from "vitest";
import {
  FakeTileProvider,
  type FakeTileResource,
} from "../apps/pas-de-geant/src/fake-tile-provider.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "../apps/pas-de-geant/src/tile-provider.js";
import {
  TileTransitionScheduler,
  type LayoutSource,
  type SchedulerEvent,
} from "../apps/pas-de-geant/src/tile-transition-scheduler.js";
import {
  assertAdmissibleCut,
  tileIdentityKey,
  type TileIdentity,
} from "../apps/pas-de-geant/src/tile-transition-planner.js";
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

class ControlledProvider implements TileProvider<{ readonly key: string }> {
  private nextRequestId = 1;
  readonly requested: string[] = [];
  readonly cancelled: string[] = [];
  private readonly pending = new Map<
    string,
    {
      readonly requestId: number;
      readonly observer: (
        result: TileProviderResult<{ readonly key: string }>,
      ) => void;
    }
  >();

  get pendingKeys(): readonly string[] {
    return [...this.pending.keys()];
  }

  request(
    tile: TileIdentity,
    observer: (result: TileProviderResult<{ readonly key: string }>) => void,
  ): TileRequestHandle {
    const key = tileIdentityKey(tile);
    const requestId = this.nextRequestId++;
    this.requested.push(key);
    this.pending.set(key, { requestId, observer });
    return {
      requestId,
      cancel: () => {
        this.pending.delete(key);
        this.cancelled.push(key);
      },
    };
  }

  respond(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) throw new Error(`No pending request for ${key}.`);
    this.pending.delete(key);
    pending.observer({ phase: "response", resource: { key } });
  }

  fail(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) throw new Error(`No pending request for ${key}.`);
    this.pending.delete(key);
    pending.observer({ phase: "failure", reason: "fixture failure" });
  }
}

function createScheduler<Resource>(
  cuts: Readonly<Record<string, readonly TileIdentity[]>>,
  provider: TileProvider<Resource>,
): TileTransitionScheduler<string, Resource> {
  return new TileTransitionScheduler<string, Resource>(
    "base",
    new FixtureLayoutSource(cuts),
    provider,
  );
}

describe("planner-and-horizon tile transition scheduler", () => {
  it("performs no work for beyond-horizon planner groups or tiles outside planner output", () => {
    const base = uniformCut(1);
    const desired = refine(base, base[0]!);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, desired }, provider);

    scheduler.updateTarget("desired");
    expect(scheduler.snapshot.graph.groups).not.toHaveLength(0);
    expect(scheduler.snapshot.requirements).toEqual([]);
    expect(provider.requested).toEqual([]);

    scheduler.updateHorizonCulling([{ z: 8, x: 100, y: 100 }]);
    expect(scheduler.snapshot.requirements).toEqual([]);
    expect(provider.requested).toEqual([]);
  });

  it("hydrates only horizon-retained members of the planner-owned committed cut", () => {
    const base = uniformCut(1);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base }, provider);

    scheduler.updateHorizonCulling([base[2]!, { z: 9, x: 1, y: 1 }]);

    expect(provider.requested).toEqual([tileIdentityKey(base[2]!)]);
    expect(scheduler.snapshot.requirements.map(({ tile }) => tileIdentityKey(tile)))
      .toEqual([tileIdentityKey(base[2]!)]);
    provider.respond(tileIdentityKey(base[2]!));
    expect(scheduler.snapshot.requirements).toEqual([]);
    expect(scheduler.committedResource(base[2]!)).toEqual({
      key: tileIdentityKey(base[2]!),
    });
    for (const tile of base.filter((tile) => tile !== base[2])) {
      expect(scheduler.committedResource(tile)).toBeUndefined();
    }
  });

  it("activates the full planner batch when one replacement intersects the horizon", () => {
    const base = uniformCut(1);
    const desired = refine(base, base[0]!);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, desired }, provider);
    scheduler.updateTarget("desired");
    const graph = scheduler.snapshot.graph;
    expect(graph.batches).toHaveLength(1);

    scheduler.updateHorizonCulling([graph.groups[0]!.after[0]!]);

    const declared = graph.batches[0]!.groupIds.flatMap((groupId) =>
      graph.groups.find(({ id }) => id === groupId)!.after.map(tileIdentityKey)
    ).sort();
    expect([...provider.requested].sort()).toEqual(declared);
    expect(scheduler.snapshot.requirements.map(({ tile }) => tileIdentityKey(tile)).sort())
      .toEqual(declared);
  });

  it("activates exactly the planner-declared dependency closure", () => {
    const base = calculateTileOnionPlan({
      latitudeDegrees: 20,
      longitudeDegrees: 179,
      maxZoom: 5,
    }).leaves;
    const desired = calculateTileOnionPlan({
      latitudeDegrees: 20,
      longitudeDegrees: -90,
      maxZoom: 5,
    }).leaves;
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, desired }, provider);
    scheduler.updateTarget("desired");
    const graph = scheduler.snapshot.graph;
    const selected = graph.batches.find(({ dependsOn }) => dependsOn.length > 0)!;
    expect(selected).toBeDefined();
    const batchesById = new Map(graph.batches.map((batch) => [batch.id, batch]));
    const horizonBatchIds = new Set<string>();
    const include = (batchId: string): void => {
      if (horizonBatchIds.has(batchId)) return;
      const batch = batchesById.get(batchId)!;
      horizonBatchIds.add(batchId);
      for (const dependencyId of batch.dependsOn) include(dependencyId);
    };
    include(selected.id);
    expect(horizonBatchIds.size).toBeLessThan(graph.batches.length);
    const selectedGroup = graph.groups.find(
      ({ id }) => selected.groupIds.includes(id),
    )!;

    scheduler.updateHorizonCulling([selectedGroup.after[0]!]);

    const expected = graph.batches
      .filter(({ id }) => horizonBatchIds.has(id))
      .flatMap(({ groupIds }) => groupIds)
      .flatMap((groupId) =>
        graph.groups.find(({ id }) => id === groupId)!.after.map(tileIdentityKey)
      )
      .sort();
    expect([...provider.requested].sort()).toEqual(expected);
    expect(provider.requested.length).toBeLessThan(
      graph.groups.flatMap(({ after }) => after).length,
    );
  });

  it("executes a horizon-retained dependent batch chain as exact planner swaps", () => {
    const base = calculateTileOnionPlan({
      latitudeDegrees: 20,
      longitudeDegrees: 179,
      maxZoom: 5,
    }).leaves;
    const desired = calculateTileOnionPlan({
      latitudeDegrees: 20,
      longitudeDegrees: -90,
      maxZoom: 5,
    }).leaves;
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, desired }, provider);
    scheduler.updateTarget("desired");
    const initialGraph = scheduler.snapshot.graph;
    const dependentBatch = initialGraph.batches.find(
      ({ dependsOn }) => dependsOn.length > 0,
    )!;
    expect(initialGraph.batches.length).toBeGreaterThan(1);
    expect(dependentBatch).toBeDefined();

    const batchPlans = new Map<string, {
      readonly groupIds: readonly string[];
      readonly groups: typeof initialGraph.groups;
    }>();
    const rememberBatches = (snapshot: typeof scheduler.snapshot): void => {
      for (const batch of snapshot.graph.batches) {
        batchPlans.set(batch.id, {
          groupIds: batch.groupIds,
          groups: snapshot.graph.groups,
        });
      }
    };
    rememberBatches(scheduler.snapshot);
    const swaps: Array<{
      readonly batchFound: boolean;
      readonly before: readonly string[];
      readonly expectedBefore: readonly string[];
      readonly after: readonly string[];
      readonly expectedAfter: readonly string[];
    }> = [];
    scheduler.subscribe((nextSnapshot, event) => {
      if (event?.kind === "atomic-swap") {
        const batch = batchPlans.get(event.batchId!);
        const groups = batch?.groupIds.map((groupId) =>
          batch.groups.find(({ id }) => id === groupId)!
        ) ?? [];
        swaps.push({
          batchFound: batch !== undefined,
          before: event.before?.map(tileIdentityKey).sort() ?? [],
          expectedBefore: groups.flatMap(({ before }) => before)
            .map(tileIdentityKey).sort(),
          after: event.after?.map(tileIdentityKey).sort() ?? [],
          expectedAfter: groups.flatMap(({ after }) => after)
            .map(tileIdentityKey).sort(),
        });
      }
      rememberBatches(nextSnapshot);
    });
    scheduler.updateHorizonCulling(
      initialGraph.groups.flatMap(({ after }) => after),
    );

    const dependentKeys = new Set(
      dependentBatch.groupIds.flatMap((groupId) =>
        initialGraph.groups.find(({ id }) => id === groupId)!.after
          .map(tileIdentityKey)
      ),
    );
    for (const key of [...provider.pendingKeys].filter((candidate) =>
      dependentKeys.has(candidate)
    )) provider.respond(key);
    expect(swaps).toEqual([]);
    while (scheduler.snapshot.graph.groups.length > 0) {
      if (provider.pendingKeys.length === 0) {
        scheduler.updateHorizonCulling(
          scheduler.snapshot.graph.groups.flatMap(({ after }) => after),
          scheduler.snapshot.revision,
        );
      }
      expect(provider.pendingKeys.length).toBeGreaterThan(0);
      provider.respond(provider.pendingKeys[0]!);
    }

    expect(swaps.length).toBeGreaterThan(1);
    for (const swap of swaps) {
      expect(swap.batchFound).toBe(true);
      expect(swap.before).toEqual(swap.expectedBefore);
      expect(swap.after).toEqual(swap.expectedAfter);
    }
    expect(new Set(scheduler.snapshot.committedCut.map(tileIdentityKey))).toEqual(
      new Set(desired.map(tileIdentityKey)),
    );
    expect(scheduler.snapshot.graph.groups).toEqual([]);
  });

  it("changes horizon retention by intersection and cancels removed work without failing it", () => {
    const base = uniformCut(1);
    const desired = refine(refine(base, base[0]!), base[3]!);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, desired }, provider);
    const events: SchedulerEvent[] = [];
    scheduler.subscribe((_snapshot, event) => {
      if (event) events.push(event);
    });
    scheduler.updateTarget("desired");
    const firstGroup = scheduler.snapshot.graph.groups[0]!;
    const horizonKeys = firstGroup.after.map(tileIdentityKey).sort();

    scheduler.updateHorizonCulling([firstGroup.after[0]!]);
    expect([...provider.requested].sort()).toEqual(horizonKeys);
    scheduler.updateHorizonCulling([{ z: 7, x: 1, y: 1 }]);

    expect([...provider.cancelled].sort()).toEqual(horizonKeys);
    expect(scheduler.snapshot.requirements).toEqual([]);
    expect(scheduler.snapshot.graph.groups).not.toHaveLength(0);
    expect(events.filter(({ kind }) => kind === "failure")).toEqual([]);
  });

  it("keeps an atomic replacement covered until every declared tile is ready", () => {
    const base = uniformCut(1);
    const parent = base[0]!;
    const desired = refine(base, parent);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, desired }, provider);
    scheduler.updateTarget("desired");
    const group = scheduler.snapshot.graph.groups[0]!;
    scheduler.updateHorizonCulling([group.after[0]!]);

    for (const key of group.after.slice(0, -1).map(tileIdentityKey)) {
      provider.respond(key);
    }
    expect(scheduler.snapshot.committedCut.map(tileIdentityKey)).toContain(
      tileIdentityKey(parent),
    );
    provider.respond(tileIdentityKey(group.after.at(-1)!));

    expect(scheduler.snapshot.committedCut.map(tileIdentityKey)).not.toContain(
      tileIdentityKey(parent),
    );
    expect(new Set(scheduler.snapshot.committedCut.map(tileIdentityKey))).toEqual(
      new Set(desired.map(tileIdentityKey)),
    );
    expect(() => assertAdmissibleCut(scheduler.snapshot.committedCut)).not.toThrow();
  });

  it("lets one horizon-retained group commit while a beyond-horizon group stays unresolved", () => {
    const base = uniformCut(1);
    const beyondHorizonParent = base[0]!;
    const horizonParent = base[3]!;
    const desired = refine(refine(base, beyondHorizonParent), horizonParent);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, desired }, provider);
    scheduler.updateTarget("desired");
    const horizonGroup = scheduler.snapshot.graph.groups.find(
      ({ before }) => before.some(
        (tile) => tileIdentityKey(tile) === tileIdentityKey(horizonParent),
      ),
    )!;

    scheduler.updateHorizonCulling([horizonGroup.after[0]!]);
    for (const tile of horizonGroup.after) provider.respond(tileIdentityKey(tile));

    const committed = scheduler.snapshot.committedCut.map(tileIdentityKey);
    expect(committed).toContain(tileIdentityKey(beyondHorizonParent));
    expect(committed).not.toContain(tileIdentityKey(horizonParent));
    expect(provider.requested.sort()).toEqual(
      horizonGroup.after.map(tileIdentityKey).sort(),
    );
    expect(scheduler.snapshot.graph.groups).not.toHaveLength(0);
  });

  it("keeps a failed group local while another horizon-retained group progresses", () => {
    const base = uniformCut(1);
    const blockedParent = base[0]!;
    const freeParent = base[3]!;
    const desired = refine(refine(base, blockedParent), freeParent);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, desired }, provider);
    scheduler.updateTarget("desired");
    const groups = scheduler.snapshot.graph.groups;
    const blocked = groups.find(({ before }) =>
      before.some((tile) => tileIdentityKey(tile) === tileIdentityKey(blockedParent))
    )!;
    const free = groups.find(({ before }) =>
      before.some((tile) => tileIdentityKey(tile) === tileIdentityKey(freeParent))
    )!;
    scheduler.updateHorizonCulling([blocked.after[0]!, free.after[0]!]);

    provider.fail(tileIdentityKey(blocked.after[0]!));
    for (const tile of blocked.after.slice(1)) provider.respond(tileIdentityKey(tile));
    for (const tile of free.after) provider.respond(tileIdentityKey(tile));

    const committed = scheduler.snapshot.committedCut.map(tileIdentityKey);
    expect(committed).toContain(tileIdentityKey(blockedParent));
    expect(committed).not.toContain(tileIdentityKey(freeParent));
    expect(scheduler.snapshot.requirements).toContainEqual(
      expect.objectContaining({
        tile: blocked.after[0],
        state: "failed",
      }),
    );
  });

  it("drops out-of-plan horizon input across replans until the current plan is classified", () => {
    const base = uniformCut(1);
    const desired = refine(base, base[0]!);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, desired }, provider);
    const horizonReplacement = desired.find(({ z }) => z === 2)!;
    scheduler.updateHorizonCulling([horizonReplacement]);
    expect(provider.requested).toEqual([]);

    scheduler.updateTarget("desired");

    const group = scheduler.snapshot.graph.groups[0]!;
    expect(provider.requested).toEqual([]);
    expect(scheduler.updateHorizonCulling(
      [group.after[0]!],
      scheduler.snapshot.revision - 1,
    )).toBe(false);
    expect(provider.requested).toEqual([]);

    scheduler.updateHorizonCulling(
      [group.after[0]!],
      scheduler.snapshot.revision,
    );

    expect(provider.requested.sort()).toEqual(group.after.map(tileIdentityKey).sort());
    expect(provider.requested).not.toContain("2/2/0");
  });

  it("retains overlapping horizon work when a new planner revision is created", () => {
    const base = uniformCut(1);
    const first = refine(base, base[0]!);
    const second = refine(first, base[3]!);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, first, second }, provider);
    scheduler.updateTarget("first");
    const firstGroup = scheduler.snapshot.graph.groups[0]!;
    scheduler.updateHorizonCulling([firstGroup.after[0]!]);
    const firstRequests = firstGroup.after.map(tileIdentityKey).sort();
    expect([...provider.requested].sort()).toEqual(firstRequests);

    scheduler.updateTarget("second");

    expect(provider.cancelled).toEqual([]);
    expect(scheduler.snapshot.requirements.map(({ tile }) =>
      tileIdentityKey(tile)
    ).sort()).toEqual(firstRequests);
    expect(provider.requested).toHaveLength(firstRequests.length);

    const overlappingGroup = scheduler.snapshot.graph.groups.find(({ before }) =>
      before.some((tile) => tileIdentityKey(tile) === tileIdentityKey(base[0]!))
    )!;
    scheduler.updateHorizonCulling(
      [overlappingGroup.after[0]!],
      scheduler.snapshot.revision,
    );
    expect(provider.requested).toHaveLength(firstRequests.length);
    expect(provider.cancelled).toEqual([]);
  });

  it("reconciles only the requirement diff when targets partially overlap", () => {
    const base = uniformCut(1);
    const sharedParent = base[0]!;
    const removedParent = base[1]!;
    const addedParent = base[3]!;
    const first = refine(refine(base, sharedParent), removedParent);
    const second = refine(refine(base, sharedParent), addedParent);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, first, second }, provider);
    scheduler.updateTarget("first");
    const firstGroups = scheduler.snapshot.graph.groups;
    scheduler.updateHorizonCulling(
      firstGroups.flatMap(({ after }) => after),
      scheduler.snapshot.revision,
    );
    const sharedKeys = firstGroups.find(({ before }) =>
      before.some((tile) => tileIdentityKey(tile) === tileIdentityKey(sharedParent))
    )!.after.map(tileIdentityKey).sort();
    const removedKeys = firstGroups.find(({ before }) =>
      before.some((tile) => tileIdentityKey(tile) === tileIdentityKey(removedParent))
    )!.after.map(tileIdentityKey).sort();

    scheduler.updateTarget("second");

    expect([...provider.cancelled].sort()).toEqual(removedKeys);
    expect(scheduler.snapshot.requirements.map(({ tile }) =>
      tileIdentityKey(tile)
    ).sort()).toEqual(sharedKeys);
    expect(provider.requested.filter((key) => sharedKeys.includes(key)).sort())
      .toEqual(sharedKeys);

    const addedGroup = scheduler.snapshot.graph.groups.find(({ before }) =>
      before.some((tile) => tileIdentityKey(tile) === tileIdentityKey(addedParent))
    )!;
    scheduler.updateHorizonCulling(
      [
        ...scheduler.snapshot.graph.groups.find(({ before }) =>
          before.some((tile) =>
            tileIdentityKey(tile) === tileIdentityKey(sharedParent)
          )
        )!.after,
        ...addedGroup.after,
      ],
      scheduler.snapshot.revision,
    );

    const addedKeys = addedGroup.after.map(tileIdentityKey).sort();
    expect(provider.requested.filter((key) => sharedKeys.includes(key)).sort())
      .toEqual(sharedKeys);
    expect(provider.requested.filter((key) => addedKeys.includes(key)).sort())
      .toEqual(addedKeys);
    expect([...provider.cancelled].sort()).toEqual(removedKeys);
  });

  it("keeps active horizon-retained work intact when a new target has the same cut", () => {
    const base = uniformCut(1);
    const desired = refine(base, base[0]!);
    const provider = new ControlledProvider();
    const scheduler = createScheduler({ base, desired, alias: desired }, provider);
    scheduler.updateTarget("desired");
    const group = scheduler.snapshot.graph.groups[0]!;
    scheduler.updateHorizonCulling([group.after[0]!]);
    const revision = scheduler.snapshot.revision;
    const requested = [...provider.requested];
    const requirementKeys = scheduler.snapshot.requirements
      .map(({ tile }) => tileIdentityKey(tile)).sort();

    expect(scheduler.updateTarget("alias")).toBe(false);

    expect(scheduler.snapshot.revision).toBe(revision);
    expect(provider.requested).toEqual(requested);
    expect(provider.cancelled).toEqual([]);
    expect(scheduler.snapshot.requirements.map(({ tile }) =>
      tileIdentityKey(tile)
    ).sort()).toEqual(requirementKeys);
  });

  it("reloads committed hydration after it leaves and re-enters the horizon", () => {
    const base = uniformCut(1);
    const provider = new FakeTileProvider({ latencyMs: 1, jitterMs: 0 });
    const requested: string[] = [];
    provider.subscribe((event) => {
      if (event.phase === "request") requested.push(tileIdentityKey(event.tile));
    });
    const scheduler = createScheduler<string | FakeTileResource>(
      { base },
      provider as TileProvider<string | FakeTileResource>,
    );

    scheduler.updateHorizonCulling([base[0]!]);
    provider.advanceBy(1);
    scheduler.updateHorizonCulling([]);
    scheduler.updateHorizonCulling([base[0]!]);

    expect(requested).toEqual([
      tileIdentityKey(base[0]!),
      tileIdentityKey(base[0]!),
    ]);
  });

});
