import type { TileLayoutTarget } from "./tile-layout-source.js";
import type { SchedulerSnapshot } from "./tile-transition-scheduler.js";
import { tileIdentityKey, type TileIdentity } from "./tile-transition-planner.js";
import type { TileWorkerSchedulerDebugState } from "./tile-worker-scheduler.js";
import type { TerrainSurfaceView } from "./terrain-surface.js";

/** Detail selected by the existing planner, within the source's declared coverage. */
export interface SurfaceLayerReadiness {
  readonly status: "absent" | "loading" | "ready" | "degraded" | "suspended";
  readonly target: Readonly<TileLayoutTarget> | null;
  readonly revision: number | null;
  readonly pendingTileCount: number;
  /** Required tiles retained by the planner's horizon/transition working set. */
  readonly requiredTileCount: number;
  /** Current planner failures, not the provider's lifetime failure counter. */
  readonly failedTileCount: number;
  /** Temporary display placeholders or confirmed missing source samples. */
  readonly fallbackTileCount: number;
}
export type SurfaceLayer = "imagery" | "nightImagery" | "terrain";
export interface WorldSurfaceReadiness {
  readonly disposed: boolean;
  readonly view: TerrainSurfaceView;
  readonly base: { readonly usable: boolean; readonly fallback: boolean };
  readonly layers: Readonly<Record<SurfaceLayer, SurfaceLayerReadiness>>;
}

export function absentSurfaceLayer(): SurfaceLayerReadiness {
  return { status: "absent", target: null, revision: null, pendingTileCount: 0, requiredTileCount: 0, failedTileCount: 0, fallbackTileCount: 0 };
}

/** Shared evidence calculation; never changes planner targets, budgets or requests. */
export function tileLayerReadiness(options: {
  snapshot: SchedulerSnapshot<TileLayoutTarget>;
  scheduling: Pick<TileWorkerSchedulerDebugState, "planner_requests" | "target_submission">;
  workingSet: readonly TileIdentity[];
  suspended: boolean;
  published: boolean;
  failedTileCount: number;
  fallbackTileCount: number;
}): SurfaceLayerReadiness {
  const { snapshot, scheduling } = options;
  const pendingTileCount = scheduling.planner_requests.total_outstanding;
  const failedTileCount = options.failedTileCount;
  const working = new Set(options.workingSet.map(tileIdentityKey));
  const committed = new Set(snapshot.committedCut.map(tileIdentityKey).filter(key => working.has(key)));
  const requested = snapshot.requestedCut.map(tileIdentityKey).filter(key => working.has(key));
  const selected = requested.length > 0 && requested.length === committed.size && requested.every(key => committed.has(key));
  const uncovered = snapshot.requestedCut.length > 0 && requested.length === 0;
  const planning = scheduling.target_submission.pending || scheduling.target_submission.in_flight;
  // A failure in the old generation is not a failure of an unacknowledged new view.
  const status = options.suspended ? "suspended" : planning ? "loading"
    : uncovered || failedTileCount > 0 || (selected && options.fallbackTileCount > 0) ? "degraded"
      : selected && pendingTileCount === 0 && options.published ? "ready" : "loading";
  return { status, target: { ...snapshot.target }, revision: snapshot.revision,
    pendingTileCount, requiredTileCount: requested.length, failedTileCount, fallbackTileCount: options.fallbackTileCount };
}

export interface SurfaceReadinessAssessment {
  readonly status: "loading" | "ready" | "degraded";
  readonly unmet: readonly SurfaceLayer[];
}

/** A base is usable independently of whether explicitly required detail is ready. */
export function assessSurfaceReadiness(readiness: WorldSurfaceReadiness, required: readonly SurfaceLayer[]): SurfaceReadinessAssessment {
  if (readiness.disposed) throw new Error("The world has been disposed.");
  const unmet = [...new Set(required)].filter(layer => {
    if (!Object.hasOwn(readiness.layers, layer)) throw new RangeError(`Unknown surface layer: ${layer}`);
    return readiness.layers[layer].status !== "ready";
  });
  const degraded = unmet.some(layer => ["absent", "degraded"].includes(readiness.layers[layer].status));
  return { status: !readiness.base.usable ? "loading" : degraded ? "degraded" : unmet.length ? "loading" : "ready", unmet };
}
