import {
  calculateTileOnionPlan,
  tileBounds,
} from "./tile-onion-core.js";
import type { LayoutSource } from "./construct-transition-scheduler.js";
import type { TileIdentity } from "./construct-transition-planner.js";

export interface ConstructTarget {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export function normalizeConstructTarget(target: ConstructTarget): ConstructTarget {
  const z = Number.isFinite(target.z) ? Math.max(0, Math.floor(target.z)) : 0;
  const width = 2 ** z;
  const x = ((Math.floor(target.x) % width) + width) % width;
  const y = Math.max(0, Math.min(width - 1, Math.floor(target.y)));
  return Object.freeze({ z, x, y });
}

/**
 * UI composition adapter only. It converts an XYZ target into a coordinate and
 * delegates canonical layout calculation to the standalone tile-onion module.
 * Neither the scheduler nor transition planner imports this adapter.
 */
export class TileOnionLayoutSource implements LayoutSource<ConstructTarget> {
  calculate(sourceTarget: Readonly<ConstructTarget>): readonly TileIdentity[] {
    const target = normalizeConstructTarget(sourceTarget);
    const bounds = tileBounds(target);
    const plan = calculateTileOnionPlan({
      latitudeDegrees: (bounds.north + bounds.south) / 2,
      longitudeDegrees: (bounds.west + bounds.east) / 2,
      maxZoom: target.z,
    });
    return plan.leaves.map(({ z, x, y }) => ({ z, x, y }));
  }
}
