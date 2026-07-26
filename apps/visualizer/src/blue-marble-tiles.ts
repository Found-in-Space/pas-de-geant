export const BLUE_MARBLE_WMTS_BASE_URL =
  "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/default/500m";

export const BLUE_MARBLE_MAX_ZOOM = 7;

const GIBS_TILE_SIZE = 512;
const LEAFLET_TILE_SIZE = 256;
const LEAFLET_ZOOM_ZERO_TILE_WIDTH_DEGREES = 180;
const GIBS_ZOOM_ZERO_DEGREES_PER_PIXEL = 0.5625;

// Both grids halve their geographic resolution at each zoom, so this ratio is
// constant: one Leaflet tile covers 320 source pixels at every level.
const GIBS_PIXELS_PER_LEAFLET_TILE =
  LEAFLET_ZOOM_ZERO_TILE_WIDTH_DEGREES /
  GIBS_ZOOM_ZERO_DEGREES_PER_PIXEL;

export interface TileCoordinates {
  x: number;
  y: number;
  z: number;
}

export interface BlueMarbleTileFragment {
  url: string;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  destinationX: number;
  destinationY: number;
  destinationWidth: number;
  destinationHeight: number;
}

export function blueMarbleTileUrl(
  zoom: number,
  row: number,
  column: number,
): string {
  return `${BLUE_MARBLE_WMTS_BASE_URL}/${zoom}/${row}/${column}.jpeg`;
}

export function blueMarbleTileFragments(
  coordinates: TileCoordinates,
): BlueMarbleTileFragment[] {
  const sourceLeft = coordinates.x * GIBS_PIXELS_PER_LEAFLET_TILE;
  const sourceTop = coordinates.y * GIBS_PIXELS_PER_LEAFLET_TILE;
  const sourceRight = sourceLeft + GIBS_PIXELS_PER_LEAFLET_TILE;
  const sourceBottom = sourceTop + GIBS_PIXELS_PER_LEAFLET_TILE;
  const firstColumn = Math.floor(sourceLeft / GIBS_TILE_SIZE);
  const lastColumn = Math.ceil(sourceRight / GIBS_TILE_SIZE) - 1;
  const firstRow = Math.floor(sourceTop / GIBS_TILE_SIZE);
  const lastRow = Math.ceil(sourceBottom / GIBS_TILE_SIZE) - 1;
  const destinationScale =
    LEAFLET_TILE_SIZE / GIBS_PIXELS_PER_LEAFLET_TILE;
  const fragments: BlueMarbleTileFragment[] = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    const tileTop = row * GIBS_TILE_SIZE;
    const fragmentTop = Math.max(sourceTop, tileTop);
    const fragmentBottom = Math.min(sourceBottom, tileTop + GIBS_TILE_SIZE);

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const tileLeft = column * GIBS_TILE_SIZE;
      const fragmentLeft = Math.max(sourceLeft, tileLeft);
      const fragmentRight = Math.min(
        sourceRight,
        tileLeft + GIBS_TILE_SIZE,
      );

      fragments.push({
        url: blueMarbleTileUrl(coordinates.z, row, column),
        sourceX: fragmentLeft - tileLeft,
        sourceY: fragmentTop - tileTop,
        sourceWidth: fragmentRight - fragmentLeft,
        sourceHeight: fragmentBottom - fragmentTop,
        destinationX: (fragmentLeft - sourceLeft) * destinationScale,
        destinationY: (fragmentTop - sourceTop) * destinationScale,
        destinationWidth: (fragmentRight - fragmentLeft) * destinationScale,
        destinationHeight: (fragmentBottom - fragmentTop) * destinationScale,
      });
    }
  }

  return fragments;
}
