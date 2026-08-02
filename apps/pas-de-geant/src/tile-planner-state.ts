import type { TileLayoutTarget } from "./tile-layout-source.js";
import { tileIdentityKey } from "./tile-transition-planner.js";
import type {
  SchedulerSnapshot,
  TileRequirementState,
} from "./tile-transition-scheduler.js";

export interface TilePlannerSnapshotSummary {
  readonly planner_revision: number;
  readonly planner_target: TileLayoutTarget;
  readonly topology: {
    readonly committed_tile_count: number;
    readonly requested_tile_count: number;
    readonly retained_tile_count: number;
    readonly replacement_group_count: number;
    readonly pending_batch_count: number;
    readonly transition_complete: boolean;
  };
  readonly transition_requirements: {
    readonly requested: number;
    readonly in_flight: number;
    readonly ready: number;
    readonly failed: number;
    readonly blocking_or_incomplete: number;
    readonly total: number;
  };
}

function cutsMatch(
  committed: SchedulerSnapshot<TileLayoutTarget>["committedCut"],
  requested: SchedulerSnapshot<TileLayoutTarget>["requestedCut"],
): boolean {
  if (committed.length !== requested.length) return false;
  const committedKeys = new Set(committed.map(tileIdentityKey));
  return requested.every((tile) => committedKeys.has(tileIdentityKey(tile)));
}

export function summarizeTilePlannerSnapshot(
  snapshot: SchedulerSnapshot<TileLayoutTarget>,
): TilePlannerSnapshotSummary {
  const requirements: Record<TileRequirementState, number> = {
    requested: 0,
    "in-flight": 0,
    ready: 0,
    failed: 0,
  };
  for (const requirement of snapshot.requirements) {
    requirements[requirement.state] += 1;
  }
  return {
    planner_revision: snapshot.revision,
    planner_target: {
      maxZoom: snapshot.target.maxZoom,
      latitudeDegrees: snapshot.target.latitudeDegrees,
      longitudeDegrees: snapshot.target.longitudeDegrees,
    },
    topology: {
      committed_tile_count: snapshot.committedCut.length,
      requested_tile_count: snapshot.requestedCut.length,
      retained_tile_count: snapshot.graph.retained.length,
      replacement_group_count: snapshot.graph.groups.length,
      pending_batch_count: snapshot.graph.batches.length,
      transition_complete:
        cutsMatch(snapshot.committedCut, snapshot.requestedCut) &&
        snapshot.graph.groups.length === 0 &&
        snapshot.graph.batches.length === 0,
    },
    transition_requirements: {
      requested: requirements.requested,
      in_flight: requirements["in-flight"],
      ready: requirements.ready,
      failed: requirements.failed,
      blocking_or_incomplete:
        requirements.requested + requirements["in-flight"] +
        requirements.failed,
      total: snapshot.requirements.length,
    },
  };
}
