import type { TileIdentity } from "./tile-transition-planner.js";
import type { TileProjection } from "./tile-onion-core.js";
import { projectedTileSpanM } from "./projected-tile-span.js";
import {
  selectZoomWithVerticalHysteresis,
} from "./observer-tile-zoom.js";

export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

export type ImageryAddress = TileIdentity;

export interface ImageryView {
  readonly displayRadiusM: number;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly projection?: TileProjection;
  /** Room-space distance from the eye to the local body surface. */
  readonly observerHeightWorldM: number;
  /** Active camera projection focal length in render pixels. */
  readonly focalLengthPixels: number;
}

export interface ImageryZoomOptions extends ImageryView {
  readonly minZoom: number;
  /** Provider source maximum; deliberately does not cap topology zoom. */
  readonly maxZoom: number;
  readonly tilePixels: number;
  readonly previousZoom?: number;
  readonly targetScreenPixelsPerSourcePixel?: number;
  readonly maxTopologyZoom?: number | null;
}

export function imageryKey(address: ImageryAddress): string {
  return `${address.z}/${address.x}/${address.y}`;
}

export function wrapImageryX(x: number, zoom: number): number {
  const width = 2 ** zoom;
  return ((x % width) + width) % width;
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
  projection: TileProjection = "web-mercator",
): number {
  const latitude =
    Math.max(
      -WEB_MERCATOR_MAX_LATITUDE,
      Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
    ) *
    Math.PI /
    180;
  return projectedTileSpanM(
    projection === "geographic" ? latitudeDegrees : latitude * 180 / Math.PI,
    Math.max(0.001, displayRadiusM),
    Math.max(0, Math.floor(zoom)),
    projection,
  );
}

/** Eye height where one source texel at a zoom occupies one screen pixel. */
export function observerHeightForImageryZoom(options: {
  readonly projection?: TileProjection;
  readonly displayRadiusM: number;
  readonly latitudeDegrees: number;
  readonly focalLengthPixels: number;
  readonly tilePixels: number;
  readonly zoom: number;
  readonly targetScreenPixelsPerSourcePixel?: number;
}): number {
  const focalLengthPixels = Math.max(1, options.focalLengthPixels);
  const tilePixels = Math.max(1, options.tilePixels);
  const targetScreenPixelsPerSourcePixel =
    options.targetScreenPixelsPerSourcePixel ?? 1;
  if (
    !Number.isFinite(targetScreenPixelsPerSourcePixel) ||
    targetScreenPixelsPerSourcePixel <= 0
  ) {
    throw new RangeError("Target screen/source density must be positive.");
  }
  return renderedImageryTileWidthM(
    options.latitudeDegrees,
    options.displayRadiusM,
    options.zoom,
    options.projection,
  ) * focalLengthPixels /
    (tilePixels * targetScreenPixelsPerSourcePixel);
}

export function selectImageryZoom(options: ImageryZoomOptions): number {
  if (!Number.isFinite(options.focalLengthPixels) || options.focalLengthPixels <= 0) {
    throw new RangeError("Imagery focal length must be positive.");
  }
  const targetScreenPixelsPerSourcePixel =
    options.targetScreenPixelsPerSourcePixel ?? 1;
  const renderedWidthAtZoomZero = renderedImageryTileWidthM(
    options.latitudeDegrees,
    options.displayRadiusM,
    0,
    options.projection,
  );
  const projectedTargetWidth = Math.max(1, options.tilePixels) *
    options.observerHeightWorldM * targetScreenPixelsPerSourcePixel /
    options.focalLengthPixels;
  // Distance determines visible detail. A room-space texel-density floor
  // would keep distant bodies streaming surface-resolution imagery.
  return selectZoomWithVerticalHysteresis({
    continuousZoom: Math.log2(
      renderedWidthAtZoomZero / projectedTargetWidth,
    ),
    observerHeightWorldM: options.observerHeightWorldM,
    previousZoom: options.previousZoom,
    minimumZoom: options.minZoom,
    maximumZoom: options.maxTopologyZoom,
  });
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
