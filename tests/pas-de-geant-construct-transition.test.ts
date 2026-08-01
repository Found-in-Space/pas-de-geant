import { describe, expect, it } from "vitest";
import {
  assertAdmissibleCut,
  planTransition,
  tileIdentityKey,
  tilesTouch,
  type ReplacementGroup,
  type TileIdentity,
} from "../apps/pas-de-geant/src/construct-transition-planner.js";
import { calculateTileOnionPlan } from "../apps/pas-de-geant/src/tile-onion-core.js";

function labels(tiles: readonly TileIdentity[]): string[] {
  return tiles.map(tileIdentityKey);
}

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

function normalizedArea(tiles: readonly TileIdentity[]): number {
  return tiles.reduce((area, tile) => area + 1 / 4 ** tile.z, 0);
}

function applyGroups(
  cut: readonly TileIdentity[],
  groups: readonly ReplacementGroup[],
): TileIdentity[] {
  const leaves = new Map(cut.map((tile) => [tileIdentityKey(tile), tile]));
  for (const group of groups) {
    for (const tile of group.before) leaves.delete(tileIdentityKey(tile));
    for (const tile of group.after) leaves.set(tileIdentityKey(tile), tile);
  }
  return [...leaves.values()];
}

function commonGridBounds(tile: TileIdentity, zoom: number) {
  const scale = 2 ** (zoom - tile.z);
  return {
    west: tile.x * scale,
    east: (tile.x + 1) * scale,
    north: tile.y * scale,
    south: (tile.y + 1) * scale,
  };
}

function touchesAtCorner(first: TileIdentity, second: TileIdentity): boolean {
  const zoom = Math.max(first.z, second.z);
  const width = 2 ** zoom;
  const firstBounds = commonGridBounds(first, zoom);
  const secondBounds = commonGridBounds(second, zoom);
  return [-width, 0, width].some((offset) => {
    const xCorner =
      firstBounds.east === secondBounds.west + offset ||
      secondBounds.east + offset === firstBounds.west;
    const yCorner =
      firstBounds.south === secondBounds.north ||
      secondBounds.south === firstBounds.north;
    return xCorner && yCorner;
  });
}

function touchesAcrossSeam(first: TileIdentity, second: TileIdentity): boolean {
  const zoom = Math.max(first.z, second.z);
  const width = 2 ** zoom;
  const firstBounds = commonGridBounds(first, zoom);
  const secondBounds = commonGridBounds(second, zoom);
  const yTouches =
    firstBounds.north <= secondBounds.south &&
    secondBounds.north <= firstBounds.south;
  return yTouches &&
    (firstBounds.west === 0 && secondBounds.east === width ||
      secondBounds.west === 0 && firstBounds.east === width);
}

describe("The Construct topology-only transition planner", () => {
  it("retains an identical admissible cut without replacement groups", () => {
    const layout = refine(uniformCut(1), { z: 1, x: 0, y: 0 });
    const graph = planTransition(layout, [...layout].reverse());

    expect(labels(graph.retained)).toEqual(labels(layout).sort((a, b) => {
      const [az, ax, ay] = a.split("/").map(Number);
      const [bz, bx, by] = b.split("/").map(Number);
      return az! - bz! || ay! - by! || ax! - bx!;
    }));
    expect(graph.groups).toEqual([]);
    expect(graph.batches).toEqual([]);
  });

  it("makes one exact-region atomic group for refinement", () => {
    const committed = uniformCut(1);
    const parent = { z: 1, x: 0, y: 0 };
    const requested = refine(committed, parent);
    const graph = planTransition(committed, requested);

    expect(graph.groups).toHaveLength(1);
    expect(graph.groups[0]!.region).toEqual(parent);
    expect(labels(graph.groups[0]!.before)).toEqual(["1/0/0"]);
    expect(labels(graph.groups[0]!.after)).toEqual([
      "2/0/0",
      "2/1/0",
      "2/0/1",
      "2/1/1",
    ]);
    expect(normalizedArea(graph.groups[0]!.before)).toBe(
      normalizedArea(graph.groups[0]!.after),
    );
  });

  it("makes the inverse exact-region group for coarsening", () => {
    const requested = uniformCut(1);
    const parent = { z: 1, x: 1, y: 1 };
    const committed = refine(requested, parent);
    const graph = planTransition(committed, requested);

    expect(graph.groups).toHaveLength(1);
    expect(graph.groups[0]!.region).toEqual(parent);
    expect(graph.groups[0]!.before).toHaveLength(4);
    expect(labels(graph.groups[0]!.after)).toEqual(["1/1/1"]);
    expect(normalizedArea(graph.groups[0]!.before)).toBe(
      normalizedArea(graph.groups[0]!.after),
    );
  });

  it("recurses when both cuts subdivide and keeps independent regions minimal", () => {
    const base = uniformCut(1);
    const committed = refine(base, { z: 1, x: 0, y: 0 });
    const requested = refine(base, { z: 1, x: 1, y: 1 });
    const graph = planTransition(committed, requested);

    expect(graph.groups.map((group) => tileIdentityKey(group.region))).toEqual([
      "1/0/0",
      "1/1/1",
    ]);
    expect(graph.batches).toHaveLength(2);
    expect(graph.batches.every((batch) => batch.dependsOn.length === 0)).toBe(true);
  });

  it("accepts an admissible hybrid cut produced by a prior regional commit", () => {
    const base = uniformCut(1);
    const first = { z: 1, x: 0, y: 0 };
    const second = { z: 1, x: 1, y: 1 };
    const requested = refine(refine(base, first), second);
    const hybrid = refine(base, first);

    expect(() => assertAdmissibleCut(hybrid, "Hybrid")).not.toThrow();
    const graph = planTransition(hybrid, requested);
    expect(graph.groups.map((group) => tileIdentityKey(group.region))).toEqual([
      "1/1/1",
    ]);
  });

  it("is immutable and deterministic independent of input ordering", () => {
    const committed = uniformCut(2);
    const requested = refine(committed, { z: 2, x: 3, y: 2 });
    const first = planTransition(committed, requested);
    const second = planTransition(
      [...committed].reverse(),
      [...requested].reverse(),
    );

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.groups)).toBe(true);
    expect(Object.isFrozen(first.groups[0])).toBe(true);
    expect(Object.isFrozen(first.groups[0]!.after)).toBe(true);
  });

  it("rejects holes, overlap, and an unbalanced cut", () => {
    expect(() => planTransition([{ z: 1, x: 0, y: 0 }], uniformCut(1))).toThrow(
      /completely cover/,
    );
    expect(() =>
      planTransition(
        [{ z: 0, x: 0, y: 0 }, ...uniformCut(1)],
        uniformCut(1),
      ),
    ).toThrow(/overlaps ancestor|overlaps descendants/);

    let unbalanced = uniformCut(1);
    unbalanced = refine(unbalanced, { z: 1, x: 0, y: 0 });
    unbalanced = refine(unbalanced, { z: 2, x: 1, y: 1 });
    expect(() => assertAdmissibleCut(unbalanced)).toThrow(/not 2:1 balanced/);
  });

  it("derives safe ordering and SCC batches for diagonal and seam constraints", () => {
    const committed = calculateTileOnionPlan({
      latitudeDegrees: 20,
      longitudeDegrees: 179,
      maxZoom: 5,
    }).leaves;
    const requested = calculateTileOnionPlan({
      latitudeDegrees: 20,
      longitudeDegrees: -90,
      maxZoom: 5,
    }).leaves;
    const graph = planTransition(committed, requested);
    const groupById = new Map(graph.groups.map((group) => [group.id, group]));
    const batchById = new Map(graph.batches.map((batch) => [batch.id, batch]));

    const unsafeDependentPairs = graph.batches.flatMap((batch) =>
      batch.dependsOn.flatMap((dependencyId) => {
        const dependency = batchById.get(dependencyId)!;
        return batch.groupIds.flatMap((groupId) =>
          dependency.groupIds.flatMap((dependencyGroupId) => {
            const changed = groupById.get(groupId)!;
            const stillCommitted = groupById.get(dependencyGroupId)!;
            return changed.after.flatMap((after) =>
              stillCommitted.before.flatMap((before) =>
                tilesTouch(after, before) && Math.abs(after.z - before.z) > 1
                  ? [[after, before] as const]
                  : [],
              ),
            );
          }),
        );
      }),
    );

    expect(graph.batches.some((batch) => batch.groupIds.length > 1)).toBe(true);
    expect(unsafeDependentPairs.some(([first, second]) =>
      touchesAtCorner(first, second),
    )).toBe(true);
    expect(unsafeDependentPairs.some(([first, second]) =>
      touchesAcrossSeam(first, second),
    )).toBe(true);

    // Any topological order of the batch DAG remains a complete balanced cut.
    let hybrid: readonly TileIdentity[] = committed;
    const pending = new Map(graph.batches.map((batch) => [batch.id, batch]));
    const committedBatchIds = new Set<string>();
    while (pending.size > 0) {
      const batch = [...pending.values()].find((candidate) =>
        candidate.dependsOn.every((id) => committedBatchIds.has(id)),
      );
      expect(batch).toBeDefined();
      const groups = batch!.groupIds.map((id) => groupById.get(id)!);
      hybrid = applyGroups(hybrid, groups);
      expect(() => assertAdmissibleCut(hybrid, "Partial commit")).not.toThrow();
      committedBatchIds.add(batch!.id);
      pending.delete(batch!.id);
    }
    expect(new Set(labels(hybrid))).toEqual(new Set(labels(requested)));
  });

  it("wraps adjacency only in x and never across north/south", () => {
    expect(tilesTouch({ z: 3, x: 0, y: 3 }, { z: 3, x: 7, y: 3 })).toBe(true);
    expect(tilesTouch({ z: 3, x: 2, y: 0 }, { z: 3, x: 2, y: 7 })).toBe(false);
    expect(tilesTouch({ z: 3, x: 0, y: 0 }, { z: 3, x: 7, y: 1 })).toBe(true);
  });
});
