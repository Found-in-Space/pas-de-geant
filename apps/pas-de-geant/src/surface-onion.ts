export interface SurfaceTileAddress {
  z: number;
  x: number;
  y: number;
}

export interface SurfaceOnionCell extends SurfaceTileAddress {
  ring: number;
  row: number;
  column: number;
  priority: number;
  unwrappedX: number;
  finestX: number;
  finestY: number;
  finestSpan: number;
}

export interface SurfaceOnionPlan {
  finestZoom: number;
  levels: number;
  outerTiles: number;
  holeTiles: number;
  finestOriginX: number;
  finestOriginY: number;
  underfootOriginX: number;
  underfootOriginY: number;
  origins: ReadonlyArray<{ x: number; y: number }>;
  cells: SurfaceOnionCell[];
  signature: string;
}

export interface SurfaceOnionPlanOptions {
  latitudeDegrees: number;
  longitudeDegrees: number;
  finestZoom: number;
  outerTiles: number;
  holeTiles: number;
  levels?: number;
}

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

function wrapLongitude(longitudeDegrees: number): number {
  return ((((longitudeDegrees + 180) % 360) + 360) % 360) - 180;
}

function wrapX(x: number, zoom: number): number {
  const width = 2 ** zoom;
  return ((x % width) + width) % width;
}

function mercatorPoint(
  latitudeDegrees: number,
  longitudeDegrees: number,
  zoom: number,
): { x: number; y: number } {
  const latitude =
    Math.max(
      -WEB_MERCATOR_MAX_LATITUDE,
      Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
    ) *
    Math.PI /
    180;
  const width = 2 ** zoom;
  return {
    x: (wrapLongitude(longitudeDegrees) + 180) / 360 * width,
    y:
      (1 -
        Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) /
      2 *
      width,
  };
}

function holeOffsetFor(outerTiles: number, holeTiles: number): number {
  return Math.floor((outerTiles - holeTiles) * 0.5);
}

/**
 * Plans a fixed, non-overlapping Web Mercator onion. Every parent ring has the
 * same cell dimensions as the finest cap and omits a centred hole exactly
 * covered by the preceding child level.
 */
export function planSurfaceOnion(
  options: SurfaceOnionPlanOptions,
): SurfaceOnionPlan {
  const finestZoom = Math.max(0, Math.round(options.finestZoom));
  const outerTiles = Math.max(2, Math.round(options.outerTiles));
  const holeTiles = Math.max(0, Math.min(
    outerTiles - 2,
    Math.round(options.holeTiles),
  ));
  const requestedLevels = Math.max(1, Math.round(options.levels ?? 3));
  const levels = Math.min(requestedLevels, finestZoom + 1);
  const point = mercatorPoint(
    options.latitudeDegrees,
    options.longitudeDegrees,
    finestZoom,
  );
  const worldWidth = 2 ** finestZoom;
  const anchorStride = 2 ** (levels - 1);
  const anchorMargin = Math.round((outerTiles - anchorStride) * 0.5);
  const anchorOffset =
    (holeOffsetFor(outerTiles, holeTiles) * (2 ** levels - 2)) %
    anchorStride;
  let originX =
    Math.floor(
      (Math.floor(point.x) - anchorMargin - anchorOffset) / anchorStride,
    ) *
      anchorStride +
    anchorOffset;
  let originY =
    Math.floor(
      (Math.floor(point.y) - anchorMargin - anchorOffset) / anchorStride,
    ) *
      anchorStride +
    anchorOffset;
  originY = Math.max(0, Math.min(worldWidth - outerTiles, originY));

  const finestOriginX = originX;
  const finestOriginY = originY;
  const origins: Array<{ x: number; y: number }> = [];
  const cells: SurfaceOnionCell[] = [];
  const holeOffset = holeOffsetFor(outerTiles, holeTiles);
  for (let ring = 0; ring < levels; ring += 1) {
    const zoom = finestZoom - ring;
    const ringWidth = 2 ** zoom;
    const ringOrigin = {
      x: originX,
      y: Math.max(0, Math.min(ringWidth - outerTiles, originY)),
    };
    originY = ringOrigin.y;
    origins.push(ringOrigin);
    for (let row = 0; row < outerTiles; row += 1) {
      for (let column = 0; column < outerTiles; column += 1) {
        if (
          ring > 0 &&
          row >= holeOffset &&
          row < holeOffset + holeTiles &&
          column >= holeOffset &&
          column < holeOffset + holeTiles
        ) {
          continue;
        }
        const unwrappedX = ringOrigin.x + column;
        const y = ringOrigin.y + row;
        if (y < 0 || y >= ringWidth) continue;
        const finestSpan = 2 ** ring;
        cells.push({
          z: zoom,
          x: wrapX(unwrappedX, zoom),
          y,
          ring,
          row,
          column,
          priority:
            ring * outerTiles +
            Math.hypot(
              column - (outerTiles - 1) * 0.5,
              row - (outerTiles - 1) * 0.5,
            ),
          unwrappedX,
          finestX: unwrappedX * finestSpan,
          finestY: y * finestSpan,
          finestSpan,
        });
      }
    }
    originX = Math.floor(originX / 2) - holeOffset;
    originY = Math.floor(originY / 2) - holeOffset;
  }

  const underfootOriginX = Math.floor(point.x - 0.5);
  const underfootOriginY = Math.max(
    0,
    Math.min(worldWidth - 2, Math.floor(point.y - 0.5)),
  );
  return {
    finestZoom,
    levels,
    outerTiles,
    holeTiles,
    finestOriginX,
    finestOriginY,
    underfootOriginX,
    underfootOriginY,
    origins,
    cells,
    signature: [
      finestZoom,
      levels,
      outerTiles,
      holeTiles,
      underfootOriginX,
      underfootOriginY,
      ...origins.flatMap((origin) => [origin.x, origin.y]),
    ].join(":"),
  };
}
