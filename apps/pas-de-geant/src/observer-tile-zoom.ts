export const DEFAULT_VERTICAL_LOD_HYSTERESIS_WORLD_M = 0.2;

export interface VerticalZoomHysteresisOptions {
  /** Perspective demand at the current room-space eye height. */
  readonly continuousZoom: number;
  readonly observerHeightWorldM: number;
  /** Independent detail floor, such as native imagery texel density. */
  readonly minimumContinuousZoom?: number;
  readonly previousZoom?: number;
  readonly minimumZoom?: number;
  readonly maximumZoom?: number | null;
  readonly coarsenHysteresisWorldM?: number;
}

export interface ObserverTileZoomOptions {
  readonly observerHeightWorldM: number;
  readonly displayRadiusM: number;
  readonly latitudeDegrees: number;
  readonly projectedFocalLengthPixels: number;
  readonly tilePixels: number;
  readonly targetScreenPixelsPerSourcePixel?: number;
  readonly previousZoom?: number;
  readonly minimumZoom?: number;
  readonly maximumZoom?: number | null;
  readonly coarsenHysteresisWorldM?: number;
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

function normalizedZoomBound(value: number | undefined, fallback: number): number {
  return value === undefined
    ? fallback
    : Math.max(0, Math.floor(value));
}

function boundedZoom(value: number, minimum: number, maximum: number): number {
  if (value === Number.NEGATIVE_INFINITY) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

/**
 * Selects an integer zoom with a room-space, fine-biased Schmitt trigger.
 * Refinement uses the normal half-level boundary. Coarsening retains the fine
 * level until the eye is the configured distance above that same boundary.
 */
export function selectZoomWithVerticalHysteresis(
  options: VerticalZoomHysteresisOptions,
): number {
  if (
    !Number.isFinite(options.observerHeightWorldM) ||
    options.observerHeightWorldM <= 0
  ) {
    throw new RangeError("Observer room-space height must be positive.");
  }
  if (
    Number.isNaN(options.continuousZoom) ||
    options.continuousZoom === Number.POSITIVE_INFINITY
  ) {
    throw new RangeError("Perspective zoom demand must be finite or negative infinity.");
  }
  const minimumContinuousZoom = options.minimumContinuousZoom ??
    Number.NEGATIVE_INFINITY;
  if (
    Number.isNaN(minimumContinuousZoom) ||
    minimumContinuousZoom === Number.POSITIVE_INFINITY
  ) {
    throw new RangeError("Minimum zoom demand must be finite or negative infinity.");
  }
  const hysteresis = options.coarsenHysteresisWorldM ??
    DEFAULT_VERTICAL_LOD_HYSTERESIS_WORLD_M;
  if (!Number.isFinite(hysteresis) || hysteresis < 0) {
    throw new RangeError("Coarsening hysteresis must be non-negative.");
  }

  const configuredMinimum = normalizedZoomBound(options.minimumZoom, 0);
  const maximum = options.maximumZoom === undefined ||
      options.maximumZoom === null
    ? Number.POSITIVE_INFINITY
    : normalizedZoomBound(options.maximumZoom, 0);
  const minimum = Math.min(configuredMinimum, maximum);
  const demand = Math.max(options.continuousZoom, minimumContinuousZoom);
  if (options.previousZoom === undefined) {
    return boundedZoom(demand, minimum, maximum);
  }
  if (!Number.isFinite(options.previousZoom)) {
    throw new RangeError("Previous zoom must be finite.");
  }

  let zoom = Math.max(
    minimum,
    Math.min(maximum, Math.floor(options.previousZoom)),
  );
  while (zoom < maximum && demand >= zoom + 0.5) zoom += 1;
  while (zoom > minimum) {
    const boundaryZoom = zoom - 0.5;
    if (minimumContinuousZoom >= boundaryZoom) break;
    const neutralBoundaryHeightWorldM = options.observerHeightWorldM *
      2 ** (options.continuousZoom - boundaryZoom);
    if (
      options.observerHeightWorldM <
        neutralBoundaryHeightWorldM + hysteresis
    ) break;
    zoom -= 1;
  }
  return zoom;
}

/**
 * Selects surface-tile detail from the ratio between the displayed body radius
 * and room-space eye height. No celestial-body reference radius participates.
 */
export function observerTileZoom(
  options: ObserverTileZoomOptions,
): ObserverTileZoom {
  const targetScreenPixelsPerSourcePixel =
    options.targetScreenPixelsPerSourcePixel ?? 1;
  for (const [name, value] of [
    ["Observer room-space height", options.observerHeightWorldM],
    ["Display radius", options.displayRadiusM],
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
  const continuousZoom = Math.log2(
    2 * Math.PI * Math.cos(latitudeRadians) * options.displayRadiusM *
      options.projectedFocalLengthPixels /
      (options.tilePixels * options.observerHeightWorldM *
        targetScreenPixelsPerSourcePixel),
  );

  return Object.freeze({
    continuousZoom,
    zoom: selectZoomWithVerticalHysteresis({
      continuousZoom,
      observerHeightWorldM: options.observerHeightWorldM,
      previousZoom: options.previousZoom,
      minimumZoom: options.minimumZoom,
      maximumZoom: options.maximumZoom,
      coarsenHysteresisWorldM: options.coarsenHysteresisWorldM,
    }),
  });
}
