import { balancedQuadtreeLeaves } from "./tile-onion-core.js";
import { tileIdentityKey, type TileIdentity } from "./tile-transition-planner.js";

/** Inclusive source-tile rectangles, on the provider's XYZ grid. */
export type TileCoverageRange = readonly [number, number, number, number, number];
export interface TileSourceCoverage {
  readonly globalMaximumZoom: number;
  readonly ranges: readonly TileCoverageRange[];
}

/** The rectangle uses source coordinates; its last value is geometry/detail zoom. */
export type TileRefinementRange = readonly [number, number, number, number, number, number];
export interface TileRefinementLimits {
  readonly globalMaximumZoom: number;
  readonly ranges: readonly TileRefinementRange[];
}

export function sourceRefinementLimits(
  coverage: TileSourceCoverage,
  topologyZoom: (sourceZoom: number) => number = (zoom) => zoom,
): TileRefinementLimits {
  return {
    globalMaximumZoom: topologyZoom(coverage.globalMaximumZoom),
    ranges: coverage.ranges.map(([z, minX, minY, maxX, maxY]) =>
      [z, minX, minY, maxX, maxY, topologyZoom(z)]),
  };
}

/** Compact exact tile lists without filling holes or widening their coverage. */
export function tileCoverageRanges(levels: readonly {
  readonly zoom: number;
  readonly tiles: readonly (readonly [number, number])[];
}[]): readonly TileCoverageRange[] {
  const result: TileCoverageRange[] = [];
  for (const level of levels) {
    const rows = new Map<number, number[]>();
    for (const [x, y] of level.tiles) {
      const row = rows.get(y) ?? [];
      row.push(x);
      rows.set(y, row);
    }
    const rectangles = new Map<string, [number, number, number, number, number]>();
    for (const [y, row] of [...rows].sort(([a], [b]) => a - b)) {
      const xs = [...new Set(row)].sort((a, b) => a - b);
      for (let start = 0; start < xs.length;) {
        let end = start;
        while (end + 1 < xs.length && xs[end + 1] === xs[end]! + 1) end++;
        const minX = xs[start]!, maxX = xs[end]!;
        const key = `${minX}/${maxX}`;
        const previous = rectangles.get(key);
        if (previous && previous[4] === y - 1) previous[4] = y;
        else {
          const range: [number, number, number, number, number] = [level.zoom, minX, y, maxX, y];
          rectangles.set(key, range);
          result.push(range);
        }
        start = end + 1;
      }
    }
  }
  return result;
}

function intersects(tile: TileIdentity, range: TileRefinementRange): boolean {
  const scale = 2 ** (range[0] - tile.z);
  return tile.x * scale < range[3] + 1 && (tile.x + 1) * scale > range[1] &&
    tile.y * scale < range[4] + 1 && (tile.y + 1) * scale > range[2];
}

/** Prune only existing desired splits, then restore the scheduler's 2:1 seams.
 * Descendant coverage is considered across the entire tile, so an island of
 * detail remains reachable even when its parent or the observer lacks data.
 */
export function constrainTileRefinement(
  cut: readonly TileIdentity[],
  limits: TileRefinementLimits,
): readonly TileIdentity[] {
  const leaves = new Set(cut.map(tileIdentityKey));
  const retained: TileIdentity[] = [];
  const visit = (tile: TileIdentity, ranges: readonly TileRefinementRange[]): void => {
    if (leaves.has(tileIdentityKey(tile))) {
      retained.push(tile);
      return;
    }
    const finer = ranges.filter((range) => range[5] > tile.z && intersects(tile, range));
    if (tile.z >= limits.globalMaximumZoom && finer.length === 0) {
      retained.push(tile);
      return;
    }
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      visit({ z: tile.z + 1, x: tile.x * 2 + x, y: tile.y * 2 + y }, finer);
    }
  };
  visit({ z: 0, x: 0, y: 0 }, limits.ranges);
  return balancedQuadtreeLeaves(retained).map(({ z, x, y }) => ({ z, x, y }));
}
