import type { TileProjection } from "./tile-onion-core.js";

/** Largest local tile dimension; geographic latitude spacing stays finite at a pole. */
export function projectedTileSpanM(
  latitudeDegrees: number,
  displayRadiusM: number,
  zoom: number,
  projection: TileProjection = "web-mercator",
): number {
  const latitude = Math.max(-90, Math.min(90, latitudeDegrees)) * Math.PI / 180;
  const longitudeSpan = 2 * Math.PI * Math.cos(latitude) * displayRadiusM;
  const span = projection === "geographic"
    ? Math.max(longitudeSpan, Math.PI * displayRadiusM)
    : longitudeSpan;
  return span / 2 ** zoom;
}
