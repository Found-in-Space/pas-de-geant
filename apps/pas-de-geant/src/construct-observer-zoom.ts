import { EARTH_MEAN_RADIUS_KM } from "./tile-onion-core.js";

export interface ObserverTileZoomOptions {
  readonly observerHeightMeters: number;
  readonly latitudeDegrees: number;
  readonly projectedFocalLengthPixels: number;
  readonly tilePixels: number;
  readonly targetScreenPixelsPerSourcePixel?: number;
}

export interface ObserverTileZoom {
  readonly continuousZoom: number;
  readonly zoom: number;
}

/**
 * Converts a vertical perspective field of view and viewport height into the
 * focal length of the rendered projection, measured in pixels.
 */
export function projectedFocalLengthPixels(
  viewportHeightPixels: number,
  verticalFieldOfViewDegrees: number,
): number {
  if (!Number.isFinite(viewportHeightPixels) || viewportHeightPixels <= 0) {
    throw new RangeError("Viewport height must be positive.");
  }
  if (
    !Number.isFinite(verticalFieldOfViewDegrees) ||
    verticalFieldOfViewDegrees <= 0 ||
    verticalFieldOfViewDegrees >= 180
  ) {
    throw new RangeError("Vertical field of view must be between 0 and 180 degrees.");
  }
  return viewportHeightPixels /
    (2 * Math.tan(verticalFieldOfViewDegrees * Math.PI / 360));
}

/**
 * Selects the Web Mercator level whose source-pixel density is closest to the
 * requested screen-pixel density at the point directly below the observer.
 *
 * The integer result is rounded to the nearest level, matching the existing
 * production tile selectors. Zoom zero is the mathematical lower bound of an
 * XYZ pyramid; no provider-specific upper bound is imposed here.
 */
export function observerTileZoom(
  options: ObserverTileZoomOptions,
): ObserverTileZoom {
  const targetScreenPixelsPerSourcePixel =
    options.targetScreenPixelsPerSourcePixel ?? 1;
  for (const [name, value] of [
    ["Observer height", options.observerHeightMeters],
    ["Projected focal length", options.projectedFocalLengthPixels],
    ["Tile resolution", options.tilePixels],
    ["Target screen/source density", targetScreenPixelsPerSourcePixel],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be positive.`);
    }
  }
  if (!Number.isFinite(options.latitudeDegrees)) {
    throw new RangeError("Latitude must be finite.");
  }
  const latitudeRadians = Math.max(
    -Math.PI / 2,
    Math.min(Math.PI / 2, options.latitudeDegrees * Math.PI / 180),
  );
  const earthRadiusMeters = EARTH_MEAN_RADIUS_KM * 1_000;
  const heightToRadius = options.observerHeightMeters / earthRadiusMeters;
  const continuousZoom = Math.log2(
    2 * Math.PI * Math.cos(latitudeRadians) *
      options.projectedFocalLengthPixels /
      (options.tilePixels * heightToRadius *
        targetScreenPixelsPerSourcePixel),
  );

  return Object.freeze({
    continuousZoom,
    zoom: Math.max(0, Math.round(continuousZoom)),
  });
}
