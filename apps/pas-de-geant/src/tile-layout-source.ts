import {
  TILE_ONION_FINE_MARGIN,
  TILE_ONION_FINE_SIZE,
  WEB_MERCATOR_MAX_LATITUDE,
  calculateTileOnionPlan,
  mercatorPoint,
  tileOnionAnchorOrigin,
  wrapTileX,
  wrapLongitude,
  type TileOnionState,
} from "./tile-onion-core.js";
import type { LayoutSource } from "./tile-transition-scheduler.js";
import type { TileIdentity } from "./tile-transition-planner.js";

export interface TileLayoutTarget {
  readonly maxZoom: number;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export function normalizeTileLayoutTarget(
  target: TileLayoutTarget,
): TileLayoutTarget {
  const maxZoom = Number.isFinite(target.maxZoom)
    ? Math.max(0, Math.floor(target.maxZoom))
    : 0;
  const latitudeDegrees = Number.isFinite(target.latitudeDegrees)
    ? Math.max(-90, Math.min(90, target.latitudeDegrees))
    : 0;
  const longitudeDegrees = Number.isFinite(target.longitudeDegrees)
    ? wrapLongitude(target.longitudeDegrees)
    : 0;
  return Object.freeze({ maxZoom, latitudeDegrees, longitudeDegrees });
}

/**
 * Returns whether a view change warrants another worker plan. Normal movement
 * is gated by the stride-four onion anchor so movement within the stable fine
 * patch does not create worker traffic. Boundary movement remains geographic
 * because latitude and the last stable longitude are planner inputs there.
 */
export function tileLayoutTargetNeedsSubmission(
  previousSourceTarget: TileLayoutTarget,
  nextSourceTarget: TileLayoutTarget,
): boolean {
  const previous = normalizeTileLayoutTarget(previousSourceTarget);
  const next = normalizeTileLayoutTarget(nextSourceTarget);
  if (previous.maxZoom !== next.maxZoom) return true;
  if (
    previous.latitudeDegrees === next.latitudeDegrees &&
    previous.longitudeDegrees === next.longitudeDegrees
  ) return false;

  const width = 2 ** next.maxZoom;
  const normalAnchor = (target: TileLayoutTarget) => {
    if (Math.abs(target.latitudeDegrees) > WEB_MERCATOR_MAX_LATITUDE) {
      return undefined;
    }
    const point = mercatorPoint(
      target.latitudeDegrees,
      target.longitudeDegrees,
      target.maxZoom,
    );
    const y = Math.max(0, Math.min(width - 1, Math.floor(point.y)));
    if (
      width >= TILE_ONION_FINE_SIZE &&
      (y < TILE_ONION_FINE_MARGIN ||
        y > width - TILE_ONION_FINE_MARGIN - 1)
    ) return undefined;
    if (width < TILE_ONION_FINE_SIZE) return { x: 0, y: 0 };
    return {
      x: wrapTileX(tileOnionAnchorOrigin(Math.floor(point.x)), target.maxZoom),
      y: tileOnionAnchorOrigin(y),
    };
  };
  const previousAnchor = normalAnchor(previous);
  const nextAnchor = normalAnchor(next);
  return !previousAnchor || !nextAnchor ||
    previousAnchor.x !== nextAnchor.x || previousAnchor.y !== nextAnchor.y;
}

/**
 * Delegates a geographic observer target to the canonical tile-onion planner.
 * Neither the scheduler nor transition planner imports this adapter.
 */
export class TileOnionLayoutSource implements LayoutSource<TileLayoutTarget> {
  private previousState: TileOnionState | undefined;

  calculate(
    sourceTarget: Readonly<TileLayoutTarget>,
  ): readonly TileIdentity[] {
    const target = normalizeTileLayoutTarget(sourceTarget);
    const plan = calculateTileOnionPlan({
      latitudeDegrees: target.latitudeDegrees,
      longitudeDegrees: target.longitudeDegrees,
      maxZoom: target.maxZoom,
      previousState: this.previousState,
    });
    this.previousState = plan.state;
    return plan.leaves.map(({ z, x, y }) => ({ z, x, y }));
  }
}
