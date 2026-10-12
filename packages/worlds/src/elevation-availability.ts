import type { TileIdentity } from "./tile-transition-planner.js";

/** Inclusive XYZ ranges above a complete global height pyramid. */
export interface ElevationAvailability {
  readonly globalMaximumZoom: number;
  readonly ranges: readonly (readonly [number, number, number, number, number])[];
}

export function elevationAvailability(value: unknown, maximumZoom: number): ElevationAvailability {
  const raw = value as Partial<ElevationAvailability> | null;
  if (!raw || !Number.isSafeInteger(raw.globalMaximumZoom) || raw.globalMaximumZoom! < 0 ||
    raw.globalMaximumZoom! > maximumZoom || !Array.isArray(raw.ranges)) {
    throw new Error("Incomplete elevation availability.");
  }
  const ranges = raw.ranges.map((range) => {
    if (!Array.isArray(range) || range.length !== 5 || !range.every(Number.isSafeInteger)) {
      throw new Error("Invalid elevation availability range.");
    }
    const [z, minX, minY, maxX, maxY] = range;
    if (z! <= raw.globalMaximumZoom! || z! > maximumZoom || minX! < 0 || minY! < 0 ||
      minX! > maxX! || minY! > maxY! || maxX! >= 2 ** z! || maxY! >= 2 ** z!) {
      throw new Error("Elevation availability range is outside its grid.");
    }
    return Object.freeze([...range]) as readonly [number, number, number, number, number];
  });
  return Object.freeze({ globalMaximumZoom: raw.globalMaximumZoom!, ranges: Object.freeze(ranges) });
}

export function availableElevationAncestor(tile: TileIdentity, maximumZoom: number,
  availability?: ElevationAvailability): TileIdentity {
  for (let z = Math.min(tile.z, maximumZoom); z >= 0; z--) {
    const divisor = 2 ** (tile.z - z);
    const x = Math.floor(tile.x / divisor), y = Math.floor(tile.y / divisor);
    if (!availability || z <= availability.globalMaximumZoom || availability.ranges.some(
      ([level, minX, minY, maxX, maxY]) => z === level && x >= minX && x <= maxX && y >= minY && y <= maxY,
    )) return { z, x, y };
  }
  throw new Error("Elevation source has no global ancestor.");
}
