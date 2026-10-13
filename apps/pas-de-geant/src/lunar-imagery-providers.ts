import { assertDevelopmentTileSource } from "./development-tile-policy.js";
import { imageryKey } from "@found-in-space/worlds/imagery-core";
import { XyzImageryProvider, type ImageryProvider } from "@found-in-space/worlds/imagery-provider";
import { SparseImageryProvider } from "@found-in-space/worlds/sparse-imagery-provider";
import { productTileGrid, sameTileGrid, surfaceSourceUrl, type TileGrid } from "@found-in-space/worlds/tile-grid";
import type { TileAddressing } from "@found-in-space/worlds/tile-url";
import { descriptorTileTemplate } from "./session-config.js";

export interface LunarImageryTileProduct {
  readonly kind: "sparse-opaque-xyz";
  readonly formatVersion: 1 | 2;
  readonly grid?: TileGrid;
  readonly identity: string;
  readonly tileSize: number;
  readonly sources: readonly {
    readonly id: string;
    readonly attribution: string;
    readonly priority: number;
    readonly minimumZoom: number;
    readonly maximumZoom: number;
    readonly pathTemplate: string;
    readonly levels: readonly {
      readonly zoom: number;
      readonly tiles: readonly (readonly [number, number])[];
    }[];
  }[];
}

export function lunarImageryProviders(core: ImageryProvider, product: LunarImageryTileProduct, productUrl: string, addressing: TileAddressing = "xyz"): ImageryProvider {
  if (product.kind !== "sparse-opaque-xyz" || ![1, 2].includes(product.formatVersion)) {
    throw new Error("Apollo imagery requires prepared opaque XYZ tiles.");
  }
  const grid = productTileGrid(product.formatVersion, product.grid, core.grid?.radiusMetres ?? 1_737_400);
  if (!core.grid || !sameTileGrid(core.grid, grid)) throw new Error("Apollo and global imagery grids differ.");
  return new SparseImageryProvider(core, product.sources.map((source) => {
    const available = new Set(source.levels.flatMap((level) =>
      level.tiles.map(([x, y]) => imageryKey({ z: level.zoom, x, y }))));
    return {
      provider: new XyzImageryProvider({
        id: `${source.id}-${product.identity}`,
        attribution: source.attribution,
        tileSize: product.tileSize,
        minZoom: source.minimumZoom,
        maxZoom: source.maximumZoom,
        grid,
        urlTemplate: surfaceSourceUrl(descriptorTileTemplate(source.pathTemplate, productUrl), grid, product.identity),
        addressing,
      }),
      hasTile: (tile) => available.has(imageryKey(tile)),
      priority: source.priority,
    };
  }));
}

export async function loadLunarImageryProviders(core: ImageryProvider, productUrl: string, addressing: TileAddressing, tileSize: number): Promise<ImageryProvider> {
  assertDevelopmentTileSource(productUrl, { development: import.meta.env.DEV });
  const response = await fetch(productUrl);
  if (!response.ok) throw new Error("The prepared Apollo 11 XYZ tiles are unavailable.");
  const product = await response.json() as LunarImageryTileProduct;
  if (product.tileSize !== tileSize) throw new Error("Apollo imagery tile size differs from the session provider.");
  return lunarImageryProviders(core, product, productUrl, addressing);
}
