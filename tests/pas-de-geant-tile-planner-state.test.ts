import { describe, expect, it } from "vitest";
import { summarizeTilePlannerSnapshot } from "../apps/pas-de-geant/src/tile-planner-state.js";
import type { SchedulerSnapshot } from "../apps/pas-de-geant/src/tile-transition-scheduler.js";
import type { TileLayoutTarget } from "../apps/pas-de-geant/src/tile-layout-source.js";

const target = {
  maxZoom: 1,
  latitudeDegrees: 89,
  longitudeDegrees: 42,
};

describe("tile planner state summary", () => {
  it("separates requirement phases and reports only incomplete phases as blocking", () => {
    const committed = [{ z: 0, x: 0, y: 0 }];
    const requested = [
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ];
    const states = ["requested", "in-flight", "ready", "failed"] as const;
    const snapshot: SchedulerSnapshot<TileLayoutTarget> = {
      revision: 7,
      target,
      committedCut: committed,
      requestedCut: requested,
      graph: {
        retained: [],
        groups: [{
          id: "replace-root",
          region: committed[0]!,
          before: committed,
          after: requested,
        }],
        batches: [{
          id: "root-batch",
          groupIds: ["replace-root"],
          dependsOn: [],
        }],
      },
      requirements: requested.map((tile, index) => ({
        tile,
        state: states[index]!,
        requestId: index + 1,
      })),
    };

    expect(summarizeTilePlannerSnapshot(snapshot)).toEqual({
      planner_revision: 7,
      planner_target: target,
      topology: {
        committed_tile_count: 1,
        requested_tile_count: 4,
        retained_tile_count: 0,
        replacement_group_count: 1,
        pending_batch_count: 1,
        transition_complete: false,
      },
      transition_requirements: {
        requested: 1,
        in_flight: 1,
        ready: 1,
        failed: 1,
        blocking_or_incomplete: 3,
        total: 4,
      },
    });
  });

  it("requires matching cuts and an empty graph before reporting completion", () => {
    const cut = [
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
    ];
    const snapshot: SchedulerSnapshot<TileLayoutTarget> = {
      revision: 3,
      target,
      committedCut: cut,
      requestedCut: [...cut].reverse(),
      graph: { retained: cut, groups: [], batches: [] },
      requirements: [],
    };

    expect(summarizeTilePlannerSnapshot(snapshot).topology)
      .toMatchObject({ transition_complete: true, retained_tile_count: 2 });
  });
});
