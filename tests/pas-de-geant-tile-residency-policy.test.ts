import { describe, expect, it } from "vitest";
import {
  TileResidencyPolicy,
} from "../apps/pas-de-geant/src/tile-residency-policy.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "../apps/pas-de-geant/src/tile-transition-planner.js";

const view = {
  underfoot: { latitudeDegrees: 0, longitudeDegrees: 0 },
  footprint: [{ latitudeDegrees: 0, longitudeDegrees: 0 }],
  displayRadiusM: 1_000,
  observerHeightWorldM: 1,
};
const noTiles: readonly TileIdentity[] = [];
const noRequirements: readonly { tile: TileIdentity }[] = [];

function update(
  policy: TileResidencyPolicy,
  input: {
    committedTiles: readonly TileIdentity[];
    requestedTiles?: readonly TileIdentity[];
    requirements?: readonly { tile: TileIdentity }[];
    deltaZoomCap?: number | null;
    deferSpeculativeWarm?: boolean;
    forecastDisplacement?: { x: number; y: number };
    revision?: number;
    view?: typeof view;
    viewDistanceEnabled?: boolean;
  },
) {
  return policy.update({
    committedTiles: input.committedTiles,
    requestedTiles: input.requestedTiles ?? noTiles,
    requirements: input.requirements ?? noRequirements,
    targetZoom: 5,
    revision: input.revision ?? 1,
    view: input.view ?? view,
    overheadPercent: 25,
    viewDistanceEnabled: input.viewDistanceEnabled ?? false,
    deltaZoomCap: input.deltaZoomCap ?? null,
    deferSpeculativeWarm: input.deferSpeculativeWarm ?? false,
    forecastDisplacement: input.forecastDisplacement,
    forecastSignature: input.forecastDisplacement ? 1 : 0,
    isResidentOrInFlight: () => false,
  });
}

describe("shared tile residency policy", () => {
  it("admits exact transition requirements through LOD and motion filters", () => {
    const ordinary = { z: 5, x: 16, y: 16 };
    const intermediate = { z: 2, x: 0, y: 0 };
    const policy = new TileResidencyPolicy();
    update(policy, {
      committedTiles: [ordinary],
      deltaZoomCap: 1,
      deferSpeculativeWarm: true,
      view: { ...view, footprint: [] },
      viewDistanceEnabled: true,
    });
    const result = update(policy, {
      committedTiles: [ordinary],
      requirements: [{ tile: intermediate }],
      deltaZoomCap: 1,
      deferSpeculativeWarm: true,
      revision: 1,
      view: { ...view, footprint: [] },
      viewDistanceEnabled: true,
    });

    expect(result?.demandedTiles?.map(tileIdentityKey)).toContain(
      tileIdentityKey(intermediate),
    );
    expect(result?.priorityTiles.map(tileIdentityKey)).toContain(
      tileIdentityKey(intermediate),
    );
    expect(result?.deferredTileCount).toBeGreaterThanOrEqual(0);
    expect(result?.fullDemandedTileCount).toBe(
      result?.demandedTiles?.length,
    );
  });

  it("uses the same urgent order and leaves ordinary warm tiles rampable", () => {
    const tiles = Array.from({ length: 8 }, (_, x) => ({ z: 3, x, y: 4 }));
    const firstPolicy = new TileResidencyPolicy();
    const secondPolicy = new TileResidencyPolicy();
    const input = {
      committedTiles: tiles,
      forecastDisplacement: { x: 0.25, y: 0 },
    };
    const first = update(firstPolicy, input)!;
    const second = update(secondPolicy, input)!;

    expect(second.priorityTiles).toEqual(first.priorityTiles);
    expect(second.demandedTiles).toEqual(first.demandedTiles);

    const tier = (tile: TileIdentity): number => {
      const key = tileIdentityKey(tile);
      if (firstPolicy.hotKeys.has(key)) return 0;
      if (firstPolicy.forecastKeys.has(key)) return 1;
      return 2;
    };
    const tiers = first.priorityTiles.map(tier);
    expect(firstPolicy.hotKeys.size).toBeGreaterThan(0);
    expect(tiers).toContain(1);
    expect(tiers).not.toContain(2);
    expect(tiers).toEqual([...tiers].sort());
    expect(first.demandedTiles?.some((tile) =>
      !first.priorityTiles.some((urgent) =>
        tileIdentityKey(urgent) === tileIdentityKey(tile)
      )
    )).toBe(true);
  });

  it("replans a same-revision atomic cut swap from immutable snapshot identity", () => {
    const policy = new TileResidencyPolicy();
    const previous = [{ z: 5, x: 16, y: 16 }];
    const replacement = [{ z: 5, x: 17, y: 16 }];
    update(policy, { committedTiles: previous });

    const result = update(policy, { committedTiles: replacement });

    expect(result?.demandedTiles?.map(tileIdentityKey)).toEqual([
      tileIdentityKey(replacement[0]!),
    ]);
  });

  it("does no new cut classification while its signatures are unchanged", () => {
    const policy = new TileResidencyPolicy();
    const tiles = [{ z: 5, x: 16, y: 16 }];
    expect(update(policy, { committedTiles: tiles })).toBeDefined();
    expect(update(policy, { committedTiles: tiles })).toBeUndefined();
    expect(policy.metrics.classificationTotal).toBe(1);
  });
});
