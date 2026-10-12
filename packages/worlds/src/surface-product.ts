import type { CelestialBodyDefinition } from "./solar-system.js";
import { productTileGrid, sameTileGrid, type TileGrid } from "./tile-grid.js";
import type { HeightEncoding } from "./surface-model.js";
import type { ElevationProviderMetadata } from "./image-tile-provider.js";

type ProductBody = Pick<CelestialBodyDefinition, "id" | "referenceRadiusM" | "shape">;
const bodyGridRadius = (body: ProductBody): number => body.shape.kind === "sphere"
  ? body.shape.radiusM : body.shape.equatorialRadiusM;
export interface DisplayTextureSource {
  readonly identity: string;
  readonly formatVersion: number;
  readonly grid: TileGrid;
  readonly tileSize: number;
  readonly maximumZoom: number;
  readonly basePath: string;
}
export interface ElevationSource {
  readonly identity: string;
  readonly grid: TileGrid;
  readonly heightEncoding: HeightEncoding;
  readonly metadata: ElevationProviderMetadata;
}

/** Admit the producer's display contract, including explicit legacy semantics. */
export function displayTextureSource(value: unknown, body: ProductBody): DisplayTextureSource {
  const product = value as any;
  if (!product || product.target?.id !== body.id || product.tiles?.addressing !== "XYZ" ||
    product.tiles?.matrix !== "2^z x 2^z" || product.tiles?.opaque !== true ||
    product.tiles?.format !== "png" || !Number.isSafeInteger(product.tiles?.tile_size) || product.tiles.tile_size <= 0 ||
    !Number.isSafeInteger(product.tiles?.maximum_zoom) || product.tiles.maximum_zoom < 0 ||
    typeof product.product_identity_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(product.product_identity_sha256)) {
    throw new Error("Incomplete display-texture source descriptor.");
  }
  const grid = productTileGrid(product.format_version, product.grid, bodyGridRadius(body));
  const base = product.baseTexture;
  if (product.format_version === 2 && (!base || base.projection !== "equirectangular" || base.path !== "base.png" ||
    !Number.isSafeInteger(base.width) || base.width <= 0 || !Number.isSafeInteger(base.height) || base.height <= 0 ||
    typeof base.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(base.sha256))) {
    throw new Error("Mercator products require an authenticated equirectangular base texture.");
  }
  return { identity: product.product_identity_sha256, formatVersion: product.format_version, grid, tileSize: product.tiles.tile_size,
    maximumZoom: product.tiles.maximum_zoom,
    basePath: product.format_version === 1 ? "imagery/0/0/0.png" : base.path };
}

/** Heights use their own value-preserving contract, never the display contract. */
export function elevationSource(value: unknown, body: ProductBody): ElevationSource {
  const product = value as any;
  if (!product || product.kind !== "elevation-xyz" || product.formatVersion !== 2 ||
    product.target !== body.id || product.units !== "metres" ||
    product.verticalDatum?.kind !== "reference-surface" || product.verticalDatum.radiusMetres !== bodyGridRadius(body) ||
    product.encoding?.kind !== "rg16" || typeof product.encoding.scaleM !== "number" || product.encoding.scaleM <= 0 ||
    !Number.isFinite(product.encoding.scaleM) || !Number.isFinite(product.encoding.offsetM) ||
    !Number.isSafeInteger(product.tileSize) || product.tileSize <= 0 ||
    !Number.isSafeInteger(product.maximumZoom) || product.maximumZoom < 0 ||
    !Number.isFinite(product.elevationBoundsMetres?.minimum) || !Number.isFinite(product.elevationBoundsMetres?.maximum) ||
    product.elevationBoundsMetres.minimum > product.elevationBoundsMetres.maximum ||
    typeof product.identity !== "string" || !/^[a-f0-9]{64}$/.test(product.identity)) {
    throw new Error("Incomplete or unsupported elevation source descriptor.");
  }
  return { identity: product.identity, grid: productTileGrid(2, product.grid, bodyGridRadius(body)),
    heightEncoding: { kind: "rg16", scaleM: product.encoding.scaleM, offsetM: product.encoding.offsetM },
    metadata: { tilePixels: product.tileSize, maxSourceZoom: product.maximumZoom,
      elevationBoundsMetres: product.elevationBoundsMetres, attribution: product.attribution ?? "Elevation source" } };
}

export function requireCompatibleSurfaceSources(imagery: DisplayTextureSource | undefined, elevation: ElevationSource | undefined): void {
  if (imagery && elevation && !sameTileGrid(imagery.grid, elevation.grid)) {
    throw new Error("Imagery and elevation use different body grids; regrid the producer inputs first.");
  }
}
