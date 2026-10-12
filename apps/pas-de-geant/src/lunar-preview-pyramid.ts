import { lunarStudyTileBounds, type GeographicBounds } from "./lunar-imagery-study.js";
import type { LunarRegionalImagery } from "./lunar-regional-imagery-metadata.js";
import { paintLunarRegionalTile } from "./lunar-regional-imagery.js";
import { productTileGrid, type TileGrid } from "@found-in-space/worlds/tile-grid";

export interface LunarPreviewProduct {
  readonly formatVersion: 1 | 2;
  readonly grid?: TileGrid;
  readonly kind: "sparse-detail-preview";
  readonly bounds: GeographicBounds;
  readonly tileSize: number;
  readonly minimumZoom: number;
  readonly maximumZoom: number;
  readonly contextMaximumZoom: number;
  readonly contextMetresPerPixel: number;
  readonly contextSourceUrl: string;
  readonly pathTemplate: string;
  readonly resolutionCoverage: readonly { id: string; metresPerPixel: number; coveragePercent: number }[];
  readonly levels: readonly { zoom: number; tiles: readonly (readonly [number, number])[] }[];
  readonly details: readonly { id: string; bounds: GeographicBounds; maximumZoom: number; priority: number; region: LunarRegionalImagery }[];
}

/** This 2D archive comparison is geographic; the 3D consumer admits both grids. */
export function geographicStudyPreview(value: LunarPreviewProduct): LunarPreviewProduct {
  const grid = productTileGrid(value.formatVersion, value.grid, 1_737_400);
  if (grid.projection !== "geographic") {
    throw new Error("The comparison page requires a geographic study preview; the selected source uses Mercator.");
  }
  return value;
}

export interface PreviewAddress { readonly z: number; readonly x: number; readonly y: number }

export function previewAncestor(address: PreviewAddress, maximumZoom: number): PreviewAddress {
  const z = Math.min(address.z, maximumZoom);
  const factor = 2 ** (address.z - z);
  return { z, x: Math.floor(address.x / factor), y: Math.floor(address.y / factor) };
}

export function previewBoundsIntersect(first: GeographicBounds, second: GeographicBounds): boolean {
  return first[0] < second[2] && first[2] > second[0] && first[1] < second[3] && first[3] > second[1];
}

export function previewContextAddress(product: LunarPreviewProduct, address: PreviewAddress): PreviewAddress | undefined {
  const ancestor = previewAncestor(address, product.contextMaximumZoom);
  const level = product.levels.find((entry) => entry.zoom === ancestor.z);
  return level?.tiles.some(([x, y]) => x === ancestor.x && y === ancestor.y) ? ancestor : undefined;
}

function clipBounds(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, tile: GeographicBounds, bounds: GeographicBounds): void {
  context.beginPath();
  context.rect((bounds[0] - tile[0]) / (tile[2] - tile[0]) * canvas.width,
    (tile[3] - bounds[3]) / (tile[3] - tile[1]) * canvas.height,
    (bounds[2] - bounds[0]) / (tile[2] - tile[0]) * canvas.width,
    (bounds[3] - bounds[1]) / (tile[3] - tile[1]) * canvas.height);
  context.clip();
}

function drawAncestor(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, bitmap: ImageBitmap | HTMLCanvasElement, address: PreviewAddress, ancestor: PreviewAddress): void {
  const factor = 2 ** (address.z - ancestor.z);
  context.drawImage(bitmap,
    (address.x - ancestor.x * factor) * bitmap.width / factor,
    (address.y - ancestor.y * factor) * bitmap.height / factor,
    bitmap.width / factor, bitmap.height / factor,
    0, 0, canvas.width, canvas.height);
}

/** A preview of a sparse geographic pyramid. Each source retains its best
 * parent when zooming past its resolution cap. Pixel masks reveal the context
 * or the global base; a request failure is reported separately from a hole.
 */
export async function paintLunarPreviewTile(canvas: HTMLCanvasElement, address: PreviewAddress, signal: AbortSignal, product: LunarPreviewProduct): Promise<readonly string[]> {
  const tile = lunarStudyTileBounds(address.z, address.x, address.y);
  if (!previewBoundsIntersect(tile, product.bounds)) return [];
  const context = canvas.getContext("2d")!;
  const errors: string[] = [];
  context.save();
  clipBounds(context, canvas, tile, product.bounds);
  try {
    const ancestor = previewContextAddress(product, address);
    if (ancestor) {
      try {
        const url = product.pathTemplate.replaceAll("{z}", String(ancestor.z)).replaceAll("{x}", String(ancestor.x)).replaceAll("{y}", String(ancestor.y));
        const response = await fetch(`/lunar-preview/${url}`, { signal });
        if (!response.ok) throw new Error(`Kaguya tile: HTTP ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob());
        try { if (!signal.aborted) drawAncestor(context, canvas, bitmap, address, ancestor); }
        finally { bitmap.close(); }
      } catch (error) { if (signal.aborted) throw error; errors.push(String(error)); }
    }
    for (const detail of [...product.details].sort((first, second) => first.priority - second.priority)) {
      if (!previewBoundsIntersect(tile, detail.bounds) || !previewBoundsIntersect(tile, detail.region.bounds as unknown as GeographicBounds)) continue;
      const sourceAddress = previewAncestor(address, detail.maximumZoom);
      const sourceTile = lunarStudyTileBounds(sourceAddress.z, sourceAddress.x, sourceAddress.y);
      const source = document.createElement("canvas");
      source.width = source.height = product.tileSize;
      try {
        await paintLunarRegionalTile(source, sourceTile, signal, detail.region);
        if (signal.aborted) return errors;
        context.save();
        clipBounds(context, canvas, tile, detail.bounds);
        drawAncestor(context, canvas, source, address, sourceAddress);
        context.restore();
      } catch (error) { if (signal.aborted) throw error; errors.push(`${detail.id}: ${String(error)}`); }
    }
  } finally { context.restore(); }
  return errors;
}
