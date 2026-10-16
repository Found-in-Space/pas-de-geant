import type { TileIdentity } from "./tile-transition-planner.js";

export type TileAddressing = "xyz" | "tms";

/** Interpolate only tile-address tokens, preserving the provider's path and query. */
export function tileUrl(template: string, addressing: TileAddressing, tile: TileIdentity): string {
  const row = addressing === "tms" ? 2 ** tile.z - 1 - tile.y : tile.y;
  return template.replaceAll("{z}", String(tile.z))
    .replaceAll("{x}", String(tile.x))
    .replaceAll("{y}", String(row));
}
