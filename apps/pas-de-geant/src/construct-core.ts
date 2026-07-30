import {
  INITIAL_DISPLAY_RADIUS_M,
  normalizedRadialOffsetForMetres,
} from "./planet-state.js";
import {
  LOCAL_TILE_COARSEN_WIDTH_M,
  LOCAL_TILE_REFINE_WIDTH_M,
  LOCAL_TILE_TARGET_WIDTH_M,
  mercatorPointForCoordinates,
  wrapMercatorX,
  type LocalEdgeMask,
  type MercatorTileAddress,
  type TerrainEdge,
  type TerrainEdgeConstraints,
} from "./local-terrain-core.js";
import { planSurfaceOnion } from "./surface-onion.js";

export const CONSTRUCT_LATITUDE_DEGREES = 45.9;
export const CONSTRUCT_LONGITUDE_DEGREES = 9.25;
export const CONSTRUCT_MAX_ZOOM = 14;
export const CONSTRUCT_SCALE_FACTORS = [1, 100, 250, 500, 1000] as const;
export const CONSTRUCT_OUTER_TILES = 8;
export const CONSTRUCT_HOLE_TILES = 4;
export const CONSTRUCT_RING_LEVELS = 3;
export const CONSTRUCT_UNDERFOOT_SEGMENTS = 512;
export const CONSTRUCT_FINE_SEGMENTS = 64;
export const CONSTRUCT_PARENT_SEGMENTS = 32;
export const CONSTRUCT_OUTER_SEGMENTS = 16;
export const CONSTRUCT_OUTER_SKIRT_DEPTH_M = 750;
export const CONSTRUCT_SEAM_SKIRT_DEPTH_WORLD_M = 0.0005;

export interface ConstructTerrainTile extends MercatorTileAddress {
  ring: number;
  priority: number;
  meshSegments: number;
  outerEdges: LocalEdgeMask;
  skirtEdges: LocalEdgeMask;
  edgeConstraints: TerrainEdgeConstraints;
}

export interface ConstructTerrainPlan {
  zoom: number;
  originX: number;
  originY: number;
  tileWidthM: number;
  rendered: ConstructTerrainTile[];
  required: MercatorTileAddress[];
  signature: string;
}

interface ConstructTileFootprint {
  tile: ConstructTerrainTile;
  west: number;
  east: number;
  north: number;
  south: number;
  density: number;
}

const CONSTRUCT_EDGES = [
  "north",
  "east",
  "south",
  "west",
] as const satisfies readonly TerrainEdge[];

const OPPOSITE_EDGE: Record<TerrainEdge, TerrainEdge> = {
  north: "south",
  east: "west",
  south: "north",
  west: "east",
};

function emptyConstructEdgeMask(): LocalEdgeMask {
  return { north: 0, east: 0, south: 0, west: 0 };
}

function constructTileFootprints(
  tiles: readonly ConstructTerrainTile[],
  finestZoom: number,
  referenceX: number,
): ConstructTileFootprint[] {
  const worldWidth = 2 ** finestZoom;
  return tiles.map((tile) => {
    const width = 2 ** (finestZoom - tile.z);
    const wrappedWest = tile.x * width;
    const west =
      wrappedWest +
      Math.round((referenceX - (wrappedWest + width * 0.5)) / worldWidth) *
        worldWidth;
    return {
      tile,
      west,
      east: west + width,
      north: tile.y * width,
      south: (tile.y + 1) * width,
      density: tile.meshSegments / width,
    };
  });
}

function footprintsShareEdge(
  tile: ConstructTileFootprint,
  neighbour: ConstructTileFootprint,
  edge: TerrainEdge,
): boolean {
  if (edge === "north" || edge === "south") {
    const touching =
      edge === "north"
        ? tile.north === neighbour.south
        : tile.south === neighbour.north;
    return (
      touching &&
      Math.min(tile.east, neighbour.east) >
        Math.max(tile.west, neighbour.west)
    );
  }
  const touching =
    edge === "east"
      ? tile.east === neighbour.west
      : tile.west === neighbour.east;
  return (
    touching &&
    Math.min(tile.south, neighbour.south) >
      Math.max(tile.north, neighbour.north)
  );
}

function applyConstructEdgeStitching(
  tiles: ConstructTerrainTile[],
  finestZoom: number,
  referenceX: number,
): void {
  const footprints = constructTileFootprints(
    tiles,
    finestZoom,
    referenceX,
  );
  for (const footprint of footprints) {
    for (const edge of CONSTRUCT_EDGES) {
      const neighbours = footprints.filter(
        (candidate) =>
          candidate !== footprint &&
          footprintsShareEdge(footprint, candidate, edge),
      );
      if (neighbours.length === 0) {
        footprint.tile.outerEdges[edge] = 1;
        footprint.tile.skirtEdges[edge] = 1;
        continue;
      }
      const coarsestNeighbour = neighbours.reduce((coarsest, candidate) =>
        candidate.density < coarsest.density ? candidate : coarsest
      );
      if (coarsestNeighbour.density >= footprint.density) continue;
      footprint.tile.skirtEdges[edge] = 1;
      footprint.tile.edgeConstraints[edge] = {
        address: {
          z: coarsestNeighbour.tile.z,
          x: coarsestNeighbour.tile.x,
          y: coarsestNeighbour.tile.y,
        },
        edge: OPPOSITE_EDGE[edge],
        segments: coarsestNeighbour.tile.meshSegments,
      };
    }
  }
}

export function constructDisplayRadiusM(scaleFactor: number): number {
  return INITIAL_DISPLAY_RADIUS_M *
    Math.max(1, Math.min(1000, scaleFactor));
}

export function constructSkirtDepths(
  displayRadiusM: number,
  radialMultiplier: number,
): {
  normalizedSeamSkirtDepth: number;
  normalizedOuterSkirtDepth: number;
} {
  return {
    normalizedSeamSkirtDepth:
      CONSTRUCT_SEAM_SKIRT_DEPTH_WORLD_M / displayRadiusM,
    normalizedOuterSkirtDepth: normalizedRadialOffsetForMetres(
      CONSTRUCT_OUTER_SKIRT_DEPTH_M,
      radialMultiplier,
    ),
  };
}

export function constructScaleFactor(value: string | null | undefined): number {
  const requested = Number(value);
  return CONSTRUCT_SCALE_FACTORS.includes(
      requested as (typeof CONSTRUCT_SCALE_FACTORS)[number],
    )
    ? requested
    : 1;
}

export function constructTileWidthM(
  latitudeDegrees: number,
  displayRadiusM: number,
  zoom: number,
): number {
  const latitudeRadians =
    Math.max(-85.05112878, Math.min(85.05112878, latitudeDegrees)) *
    Math.PI /
    180;
  return (
    2 *
    Math.PI *
    Math.max(0.001, displayRadiusM) *
    Math.max(1e-6, Math.cos(latitudeRadians)) /
    2 ** Math.max(0, Math.min(CONSTRUCT_MAX_ZOOM, Math.round(zoom)))
  );
}

function nearestConstructZoom(
  latitudeDegrees: number,
  displayRadiusM: number,
): number {
  let selected = 0;
  let selectedDistance = Infinity;
  for (let zoom = 0; zoom <= CONSTRUCT_MAX_ZOOM; zoom += 1) {
    const distance = Math.abs(
      Math.log2(
        constructTileWidthM(latitudeDegrees, displayRadiusM, zoom) /
          LOCAL_TILE_TARGET_WIDTH_M,
      ),
    );
    if (distance < selectedDistance) {
      selected = zoom;
      selectedDistance = distance;
    }
  }
  return selected;
}

export function selectConstructZoom(
  latitudeDegrees: number,
  displayRadiusM: number,
  previousZoom?: number,
): number {
  let zoom =
    previousZoom === undefined
      ? nearestConstructZoom(latitudeDegrees, displayRadiusM)
      : Math.max(0, Math.min(CONSTRUCT_MAX_ZOOM, Math.round(previousZoom)));
  let tileWidthM = constructTileWidthM(
    latitudeDegrees,
    displayRadiusM,
    zoom,
  );
  while (
    tileWidthM > LOCAL_TILE_REFINE_WIDTH_M &&
    zoom < CONSTRUCT_MAX_ZOOM
  ) {
    zoom += 1;
    tileWidthM *= 0.5;
  }
  while (tileWidthM < LOCAL_TILE_COARSEN_WIDTH_M && zoom > 0) {
    zoom -= 1;
    tileWidthM *= 2;
  }
  return zoom;
}

export function selectConstructTerrainPlan(options: {
  latitudeDegrees: number;
  longitudeDegrees: number;
  displayRadiusM: number;
  previousZoom?: number;
}): ConstructTerrainPlan {
  const nativeZoom = selectConstructZoom(
    options.latitudeDegrees,
    options.displayRadiusM,
    options.previousZoom,
  );
  const zoom = nativeZoom;
  const onion = planSurfaceOnion({
    latitudeDegrees: options.latitudeDegrees,
    longitudeDegrees: options.longitudeDegrees,
    finestZoom: zoom,
    outerTiles: CONSTRUCT_OUTER_TILES,
    holeTiles: CONSTRUCT_HOLE_TILES,
    levels: CONSTRUCT_RING_LEVELS,
  });
  const originX = onion.finestOriginX;
  const originY = onion.finestOriginY;
  const underfootOriginX = onion.underfootOriginX;
  const underfootOriginY = onion.underfootOriginY;
  const rendered: ConstructTerrainTile[] = [];
  for (const cell of onion.cells) {
    const underfoot =
      cell.ring === 0 &&
      (cell.x === wrapMercatorX(underfootOriginX, zoom) ||
        cell.x === wrapMercatorX(underfootOriginX + 1, zoom)) &&
      (cell.y === underfootOriginY || cell.y === underfootOriginY + 1);
    rendered.push({
      z: cell.z,
      x: cell.x,
      y: cell.y,
      ring: cell.ring,
      priority: underfoot
        ? cell.priority
        : 10 + cell.ring * 100 + cell.priority,
      meshSegments: underfoot
        ? CONSTRUCT_UNDERFOOT_SEGMENTS
        : cell.ring === 0
          ? CONSTRUCT_FINE_SEGMENTS
          : cell.ring === 1
            ? CONSTRUCT_PARENT_SEGMENTS
            : CONSTRUCT_OUTER_SEGMENTS,
      outerEdges: emptyConstructEdgeMask(),
      skirtEdges: emptyConstructEdgeMask(),
      edgeConstraints: {},
    });
  }
  applyConstructEdgeStitching(
    rendered,
    zoom,
    originX + CONSTRUCT_OUTER_TILES * 0.5,
  );
  rendered.sort(
    (first, second) =>
      first.priority - second.priority ||
      second.z - first.z ||
      first.y - second.y ||
      first.x - second.x,
  );

  const required: MercatorTileAddress[] = [];
  const requiredKeys = new Set<string>();
  for (const tile of rendered) {
    for (const [deltaX, deltaY] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const address = {
        z: tile.z,
        x: wrapMercatorX(tile.x + deltaX, tile.z),
        y: tile.y + deltaY,
      };
      const key = `${address.z}/${address.x}/${address.y}`;
      if (requiredKeys.has(key)) continue;
      requiredKeys.add(key);
      required.push(address);
    }
  }
  return {
    zoom,
    originX,
    originY,
    tileWidthM: constructTileWidthM(
      options.latitudeDegrees,
      options.displayRadiusM,
      zoom,
    ),
    rendered,
    required,
    signature: onion.signature,
  };
}
