import {
  calculateTileOnionPlan,
  tileBounds,
} from "./tile-onion-core.js";
import type { LayoutSource } from "./tile-transition-scheduler.js";
import type { TileIdentity } from "./tile-transition-planner.js";

export interface TileTarget {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export function normalizeTileTarget(target: TileTarget): TileTarget {
  const z = Number.isFinite(target.z) ? Math.max(0, Math.floor(target.z)) : 0;
  const width = 2 ** z;
  const x = ((Math.floor(target.x) % width) + width) % width;
  const y = Math.max(0, Math.min(width - 1, Math.floor(target.y)));
  return Object.freeze({ z, x, y });
}

/**
 * Converts an XYZ target into a coordinate and delegates canonical layout
 * calculation to the standalone tile-onion module.
 * Neither the scheduler nor transition planner imports this adapter.
 */
export class TileOnionLayoutSource implements LayoutSource<TileTarget> {
  calculate(sourceTarget: Readonly<TileTarget>): readonly TileIdentity[] {
    const target = normalizeTileTarget(sourceTarget);
    const bounds = tileBounds(target);
    const plan = calculateTileOnionPlan({
      latitudeDegrees: (bounds.north + bounds.south) / 2,
      longitudeDegrees: (bounds.west + bounds.east) / 2,
      maxZoom: target.z,
    });
    return plan.leaves.map(({ z, x, y }) => ({ z, x, y }));
  }
}
