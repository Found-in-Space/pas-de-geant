import type { TileIdentity } from "./tile-transition-planner.js";

export const IMAGERY_TARGET_METRES_PER_TEXEL = 0.005;
export const IMAGERY_REFERENCE_TILE_PIXELS = 512;
export const IMAGERY_COARSEN_FACTOR = 1.75 / 2.56;
export const IMAGERY_REFINE_FACTOR = 3.75 / 2.56;
export const IMAGERY_PAGE_TABLE_SIZE = 64;
export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

export type ImageryAddress = TileIdentity;

export interface ImageryView {
  readonly displayRadiusM: number;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export interface ImageryZoomOptions extends ImageryView {
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly tilePixels: number;
  readonly previousZoom?: number;
}

export function imageryKey(address: ImageryAddress): string {
  return `${address.z}/${address.x}/${address.y}`;
}

export function wrapImageryX(x: number, zoom: number): number {
  const width = 2 ** zoom;
  return ((x % width) + width) % width;
}

export function wrapImageryPageX(
  pageX: number,
  referenceX: number,
  worldWidth: number,
): number {
  return pageX + Math.round((referenceX - pageX) / worldWidth) * worldWidth;
}

export function normalizedMercatorYForLatitude(latitudeDegrees: number): number {
  const latitude =
    Math.max(
      -WEB_MERCATOR_MAX_LATITUDE,
      Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
    ) *
    Math.PI /
    180;
  return (
    1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI
  ) / 2;
}

export function mercatorPointForImagery(
  latitudeDegrees: number,
  longitudeDegrees: number,
  zoom: number,
): { x: number; y: number } {
  const width = 2 ** zoom;
  const wrappedLongitude =
    ((((longitudeDegrees + 180) % 360) + 360) % 360) - 180;
  return {
    x: ((wrappedLongitude + 180) / 360) * width,
    y: normalizedMercatorYForLatitude(latitudeDegrees) * width,
  };
}

export function renderedImageryTileWidthM(
  latitudeDegrees: number,
  displayRadiusM: number,
  zoom: number,
): number {
  const latitude =
    Math.max(
      -WEB_MERCATOR_MAX_LATITUDE,
      Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
    ) *
    Math.PI /
    180;
  return (
    2 *
    Math.PI *
    Math.max(0.001, displayRadiusM) *
    Math.max(1e-6, Math.cos(latitude)) /
    2 ** Math.max(0, Math.floor(zoom))
  );
}

export function selectImageryZoom(options: ImageryZoomOptions): number {
  const minZoom = Math.max(0, Math.floor(options.minZoom));
  const targetWidth =
    Math.max(1, options.tilePixels) * IMAGERY_TARGET_METRES_PER_TEXEL;
  let zoom =
    options.previousZoom === undefined
      ? Math.max(
          minZoom,
          Math.round(
            Math.log2(
              renderedImageryTileWidthM(
                options.latitudeDegrees,
                options.displayRadiusM,
                0,
              ) / targetWidth,
            ),
          ),
        )
      : Math.max(minZoom, Math.floor(options.previousZoom));
  let width = renderedImageryTileWidthM(
    options.latitudeDegrees,
    options.displayRadiusM,
    zoom,
  );
  while (width > targetWidth * IMAGERY_REFINE_FACTOR) {
    zoom += 1;
    width *= 0.5;
  }
  while (width < targetWidth * IMAGERY_COARSEN_FACTOR && zoom > minZoom) {
    zoom -= 1;
    width *= 2;
  }
  return zoom;
}

export function ancestorAtZoom(
  address: ImageryAddress,
  zoom: number,
): ImageryAddress {
  const resolved = Math.max(0, Math.min(address.z, Math.floor(zoom)));
  const scale = 2 ** (address.z - resolved);
  return {
    z: resolved,
    x: Math.floor(address.x / scale),
    y: Math.floor(address.y / scale),
  };
}

export interface ResolvedPageEntry {
  readonly layer: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export function resolvePageEntry(
  target: ImageryAddress,
  source: ImageryAddress,
  layer: number,
): ResolvedPageEntry {
  if (source.z > target.z) {
    throw new Error("A visible imagery source must contain its target.");
  }
  const scale = 2 ** (target.z - source.z);
  if (
    Math.floor(target.x / scale) !== source.x ||
    Math.floor(target.y / scale) !== source.y
  ) {
    throw new Error("The imagery source does not contain its target.");
  }
  return {
    layer,
    scale,
    offsetX: target.x - source.x * scale,
    offsetY: target.y - source.y * scale,
  };
}
