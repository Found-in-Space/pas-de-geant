import type { TileProjection } from "./tile-onion-core.js";

/** Dataset grid identity. Projection is independent of the body's mesh shape. */
export interface TileGrid {
  readonly formatVersion: 1;
  readonly projection: TileProjection;
  readonly radiusMetres: number;
}

export function tileGrid(value: unknown): TileGrid {
  const raw = value as Partial<TileGrid> | null;
  if (!raw || raw.formatVersion !== 1 ||
    (raw.projection !== "web-mercator" && raw.projection !== "geographic") ||
    typeof raw.radiusMetres !== "number" || !Number.isFinite(raw.radiusMetres) || raw.radiusMetres <= 0) {
    throw new Error("Unsupported or incomplete tile-grid identity.");
  }
  return Object.freeze({ formatVersion: 1, projection: raw.projection, radiusMetres: raw.radiusMetres });
}

export function tileGridKey(grid: TileGrid): string {
  return `${grid.projection}-xyz-v${grid.formatVersion}-r${grid.radiusMetres}`;
}

export function sameTileGrid(first: TileGrid | undefined, second: TileGrid | undefined): boolean {
  return first === undefined ? second === undefined : second !== undefined && tileGridKey(first) === tileGridKey(second);
}

/** Scope browser/persistent URLs as well as in-memory provider keys. Local API
 * paths can otherwise retain old geographic bytes after a source switch. */
export function surfaceSourceUrl(template: string, grid: TileGrid, identity: string): string {
  const fragmentIndex = template.indexOf("#");
  const base = fragmentIndex < 0 ? template : template.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? "" : template.slice(fragmentIndex);
  return `${base}${base.includes("?") ? "&" : "?"}surface-product=${encodeURIComponent(`${tileGridKey(grid)}:${identity}`)}${fragment}`;
}

/** Version 1 explicitly means the historical geographic grid. Version 2 must
 * declare its grid; changing the descriptor never reinterprets old bytes. */
export function productTileGrid(version: number, declared: unknown, radiusMetres: number): TileGrid {
  if (version !== 1 && version !== 2) throw new Error("Unsupported surface product version.");
  const grid = version === 1 ? tileGrid(declared ?? { formatVersion: 1, projection: "geographic", radiusMetres: 1_737_400 }) : tileGrid(declared);
  if ((version === 1 && grid.projection !== "geographic") || grid.radiusMetres !== radiusMetres || (declared !== undefined && !sameTileGrid(grid, tileGrid(declared)))) {
    throw new Error("Product grid does not match its body or version.");
  }
  return grid;
}
