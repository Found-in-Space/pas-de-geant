import {
  planSurfaceOnion,
  type SurfaceOnionPlan,
} from "./surface-onion.js";

export const LOCAL_TERRAIN_MIN_ZOOM = 0;
export const LOCAL_TERRAIN_MAX_ZOOM = 12;
export const LOCAL_TILE_SIZE = 512;
export const LOCAL_GRID_SIZE = LOCAL_TILE_SIZE + 1;
export const LOCAL_HEIGHT_CACHE_LIMIT = 256;
export const MAX_CONCURRENT_HEIGHT_REQUESTS = 4;
export const LOCAL_MALFORMED_RETRY_DELAY_MS = 5 * 60_000;
export const LOCAL_TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000] as const;
export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
export const LOCAL_RING_MESH_SEGMENTS = [128, 64, 32] as const;
export const LOCAL_UNDERFOOT_MESH_SEGMENTS = 512;

export const LOCAL_TILE_TARGET_WIDTH_M = 5.12;
export const LOCAL_TILE_COARSEN_WIDTH_M = 3.5;
export const LOCAL_TILE_REFINE_WIDTH_M = 7.5;
export const LOCAL_RING_OUTER_TILES = 8;
export const LOCAL_RING_HOLE_TILES = 4;
export const LOCAL_RING_LEVELS = 3;

const EARTH_RADIUS_M = 6_371_008.8;

export interface MercatorTileAddress {
  z: number;
  x: number;
  y: number;
}

export interface LocalEdgeMask {
  north: number;
  east: number;
  south: number;
  west: number;
}

export type TerrainEdge = keyof LocalEdgeMask;

export interface TerrainEdgeConstraint {
  address: MercatorTileAddress;
  edge: TerrainEdge;
  segments: number;
}

export type TerrainEdgeConstraints = Partial<
  Record<TerrainEdge, TerrainEdgeConstraint>
>;

export interface NativeTerrainTile extends MercatorTileAddress {
  ring: number;
  priority: number;
  meshSegments: number;
  outerEdges: LocalEdgeMask;
  skirtEdges: LocalEdgeMask;
  edgeConstraints: TerrainEdgeConstraints;
  geometrySignature: string;
}

export interface NativeTerrainPlan {
  onion: SurfaceOnionPlan | undefined;
  active: NativeTerrainTile[];
  required: MercatorTileAddress[];
  baseZoom: number;
  finestZoom: number;
  minZoom: number;
  maxZoom: number;
  finestTileWidthM: number;
  signature: string;
}

export interface NativeTerrainPlanOptions {
  latitudeDegrees: number;
  longitudeDegrees: number;
  displayRadiusM: number;
  previousBaseZoom?: number;
  lodBias?: number;
  ringLevels?: number;
}

export interface TileLoadTask {
  address: MercatorTileAddress;
  priority: number;
}

export type ElevationFailureKind = "not-found" | "transient" | "malformed";

export interface ElevationFailureDecision {
  permanent: boolean;
  retryAtMs: number;
  retryScheduled: boolean;
}

export type DecodedHeightTile = Int16Array;

export type LocalTerrainWorkerRequest =
  | {
      type: "decode";
      requestId: number;
      generation: number;
      address: MercatorTileAddress;
      bytes: ArrayBuffer;
      contentType: string;
      retainOcean?: boolean;
      zeroHeight?: boolean;
    }
  | {
      type: "mesh";
      requestId: number;
      generation: number;
      address: MercatorTileAddress;
      segments: number;
      includeSkirts?: boolean;
      skirtEdges?: LocalEdgeMask;
      edgeConstraints?: TerrainEdgeConstraints;
      includeDetailOffsets?: boolean;
    }
  | { type: "dispose" };

export type LocalTerrainWorkerResult =
  | {
      type: "decoded";
      requestId: number;
      generation: number;
      address: MercatorTileAddress;
      oceanOnly: boolean;
    }
  | {
      type: "mesh";
      requestId: number;
      generation: number;
      address: MercatorTileAddress;
      requestedSegments: number;
      actualSegments: number;
      positions: Float32Array;
      normals: Float32Array;
      uvs: Float32Array;
      heightUvs: Float32Array;
      detailHeightsM: Float32Array;
      detailOffsetsM?: Float32Array;
      oceanSurfaceOffsetsM?: Float32Array;
      skirtEdges: Float32Array;
      indices: Uint32Array;
      boundingCentre: Float32Array;
      boundingRadius: number;
      geometryBytes: number;
    }
  | {
      type: "error";
      requestId: number;
      generation: number;
      address?: MercatorTileAddress;
      message: string;
      missing?: boolean;
      missingAddress?: MercatorTileAddress;
    };

export function elevationFailureDecision(
  kind: ElevationFailureKind,
  failedAttempts: number,
  nowMs: number,
): ElevationFailureDecision {
  if (kind === "not-found") {
    return {
      permanent: true,
      retryAtMs: Infinity,
      retryScheduled: false,
    };
  }
  if (kind === "malformed") {
    return {
      permanent: false,
      retryAtMs: nowMs + LOCAL_MALFORMED_RETRY_DELAY_MS,
      retryScheduled: false,
    };
  }
  const delay =
    LOCAL_TRANSIENT_RETRY_DELAYS_MS[Math.max(0, failedAttempts - 1)];
  return {
    permanent: false,
    retryAtMs: nowMs + (delay ?? LOCAL_MALFORMED_RETRY_DELAY_MS),
    retryScheduled: delay !== undefined,
  };
}

export function mercatorTileKey(address: MercatorTileAddress): string {
  return `${address.z}/${address.x}/${address.y}`;
}

export function wrapMercatorX(x: number, zoom: number): number {
  const width = 2 ** zoom;
  return ((x % width) + width) % width;
}

export function isValidMercatorAddress(address: MercatorTileAddress): boolean {
  const width = 2 ** address.z;
  return (
    address.z >= LOCAL_TERRAIN_MIN_ZOOM &&
    address.z <= LOCAL_TERRAIN_MAX_ZOOM &&
    Number.isInteger(address.x) &&
    Number.isInteger(address.y) &&
    address.x >= 0 &&
    address.x < width &&
    address.y >= 0 &&
    address.y < width
  );
}

export function wrapLongitude(longitudeDegrees: number): number {
  return ((((longitudeDegrees + 180) % 360) + 360) % 360) - 180;
}

export function clampMercatorLatitude(latitudeDegrees: number): number {
  return Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
  );
}

export function mercatorPointForCoordinates(
  latitudeDegrees: number,
  longitudeDegrees: number,
  zoom = LOCAL_TERRAIN_MAX_ZOOM,
): { x: number; y: number } {
  const latitudeRadians =
    clampMercatorLatitude(latitudeDegrees) * Math.PI / 180;
  const width = 2 ** zoom;
  return {
    x: (wrapLongitude(longitudeDegrees) + 180) / 360 * width,
    y:
      (1 -
        Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) /
          Math.PI) /
      2 *
      width,
  };
}

export function mercatorAddressForCoordinates(
  latitudeDegrees: number,
  longitudeDegrees: number,
  zoom = LOCAL_TERRAIN_MAX_ZOOM,
): MercatorTileAddress {
  const point = mercatorPointForCoordinates(
    latitudeDegrees,
    longitudeDegrees,
    zoom,
  );
  const width = 2 ** zoom;
  return {
    z: zoom,
    x: wrapMercatorX(Math.floor(point.x), zoom),
    y: Math.max(0, Math.min(width - 1, Math.floor(point.y))),
  };
}

export function mercatorCoordinatesForTilePoint(
  address: MercatorTileAddress,
  pixelX: number,
  pixelY: number,
): { latitudeDegrees: number; longitudeDegrees: number } {
  const width = 2 ** address.z;
  const x = (address.x + pixelX / LOCAL_TILE_SIZE) / width;
  const y = (address.y + pixelY / LOCAL_TILE_SIZE) / width;
  return {
    longitudeDegrees: x * 360 - 180,
    latitudeDegrees:
      Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI,
  };
}

/**
 * Local physical width of one native Web Mercator tile after the planet is
 * scaled into render space.
 */
export function renderedMercatorTileWidthM(
  latitudeDegrees: number,
  displayRadiusM: number,
  zoom: number,
): number {
  const latitude =
    clampMercatorLatitude(latitudeDegrees) * Math.PI / 180;
  return (
    2 *
    Math.PI *
    Math.max(0.001, displayRadiusM) *
    Math.max(1e-6, Math.cos(latitude)) /
    2 ** Math.max(LOCAL_TERRAIN_MIN_ZOOM, Math.min(LOCAL_TERRAIN_MAX_ZOOM, zoom))
  );
}

function nearestNativeTerrainZoom(
  latitudeDegrees: number,
  displayRadiusM: number,
): number {
  let bestZoom = LOCAL_TERRAIN_MIN_ZOOM;
  let bestDistance = Infinity;
  for (
    let zoom = LOCAL_TERRAIN_MIN_ZOOM;
    zoom <= LOCAL_TERRAIN_MAX_ZOOM;
    zoom += 1
  ) {
    const width = renderedMercatorTileWidthM(
      latitudeDegrees,
      displayRadiusM,
      zoom,
    );
    const distance = Math.abs(Math.log2(width / LOCAL_TILE_TARGET_WIDTH_M));
    if (distance < bestDistance) {
      bestZoom = zoom;
      bestDistance = distance;
    }
  }
  return bestZoom;
}

/**
 * The only source-LOD state transition. Native tiles halve or double in render
 * space when their source zoom changes, so the hysteresis band must be wider
 * than a factor of two.
 */
export function selectNativeTerrainZoom(
  latitudeDegrees: number,
  displayRadiusM: number,
  previousZoom?: number,
): number {
  let zoom =
    previousZoom === undefined
      ? nearestNativeTerrainZoom(latitudeDegrees, displayRadiusM)
      : Math.max(
          LOCAL_TERRAIN_MIN_ZOOM,
          Math.min(LOCAL_TERRAIN_MAX_ZOOM, Math.round(previousZoom)),
        );
  let width = renderedMercatorTileWidthM(
    latitudeDegrees,
    displayRadiusM,
    zoom,
  );
  while (
    width > LOCAL_TILE_REFINE_WIDTH_M &&
    zoom < LOCAL_TERRAIN_MAX_ZOOM
  ) {
    zoom += 1;
    width *= 0.5;
  }
  while (
    width < LOCAL_TILE_COARSEN_WIDTH_M &&
    zoom > LOCAL_TERRAIN_MIN_ZOOM
  ) {
    zoom -= 1;
    width *= 2;
  }
  return zoom;
}

function emptyEdgeMask(): LocalEdgeMask {
  return { north: 0, east: 0, south: 0, west: 0 };
}

interface TerrainTileFootprint {
  tile: NativeTerrainTile;
  west: number;
  east: number;
  north: number;
  south: number;
  density: number;
}

const TERRAIN_EDGES = [
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

function terrainTileFootprints(
  tiles: readonly NativeTerrainTile[],
  finestZoom: number,
  referenceX: number,
): TerrainTileFootprint[] {
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
  tile: TerrainTileFootprint,
  neighbour: TerrainTileFootprint,
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

function applyPlanEdgeStitching(
  tiles: NativeTerrainTile[],
  finestZoom: number,
  referenceX: number,
): void {
  const footprints = terrainTileFootprints(tiles, finestZoom, referenceX);
  for (const footprint of footprints) {
    for (const edge of TERRAIN_EDGES) {
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

function edgeMaskSignature(mask: LocalEdgeMask): string {
  return `${mask.north}${mask.east}${mask.south}${mask.west}`;
}

export function terrainCellGeometrySignature(
  tile: Omit<NativeTerrainTile, "geometrySignature">,
): string {
  const constraints = TERRAIN_EDGES.map((edge) => {
    const constraint = tile.edgeConstraints[edge];
    return constraint
      ? `${edge}:${mercatorTileKey(constraint.address)}:${constraint.edge}:${constraint.segments}`
      : `${edge}:-`;
  }).join(",");
  const neighbours = [
    tile,
    { z: tile.z, x: wrapMercatorX(tile.x + 1, tile.z), y: tile.y },
    { z: tile.z, x: tile.x, y: tile.y + 1 },
    {
      z: tile.z,
      x: wrapMercatorX(tile.x + 1, tile.z),
      y: tile.y + 1,
    },
  ]
    .filter(isValidMercatorAddress)
    .map(mercatorTileKey)
    .join(",");
  return [
    mercatorTileKey(tile),
    `segments=${tile.meshSegments}`,
    `outer=${edgeMaskSignature(tile.outerEdges)}`,
    `skirts=${edgeMaskSignature(tile.skirtEdges)}`,
    `constraints=${constraints}`,
    `neighbours=${neighbours}`,
  ].join("|");
}

export function nativeTerrainPlanAnchorKey(
  latitudeDegrees: number,
  longitudeDegrees: number,
  finestZoom: number,
  requestedRingLevels = LOCAL_RING_LEVELS,
): string {
  if (finestZoom < 5) return `${finestZoom}:globe`;
  return planSurfaceOnion({
    latitudeDegrees,
    longitudeDegrees,
    finestZoom,
    outerTiles: LOCAL_RING_OUTER_TILES,
    holeTiles: LOCAL_RING_HOLE_TILES,
    levels: requestedRingLevels,
  }).signature;
}

function fixedRingTiles(
  latitudeDegrees: number,
  longitudeDegrees: number,
  finestZoom: number,
  requestedRingLevels: number,
): { onion: SurfaceOnionPlan | undefined; active: NativeTerrainTile[] } {
  if (finestZoom < 5) return { onion: undefined, active: [] };
  const onion = planSurfaceOnion({
    latitudeDegrees,
    longitudeDegrees,
    finestZoom,
    outerTiles: LOCAL_RING_OUTER_TILES,
    holeTiles: LOCAL_RING_HOLE_TILES,
    levels: requestedRingLevels,
  });
  const active: NativeTerrainTile[] = [];
  for (const cell of onion.cells) {
    const underfoot =
      cell.ring === 0 &&
      (cell.x === wrapMercatorX(onion.underfootOriginX, finestZoom) ||
        cell.x === wrapMercatorX(onion.underfootOriginX + 1, finestZoom)) &&
      (cell.y === onion.underfootOriginY ||
        cell.y === onion.underfootOriginY + 1);
    active.push({
      z: cell.z,
      x: cell.x,
      y: cell.y,
      ring: cell.ring,
      priority: underfoot ? cell.priority : 10 + cell.priority,
      meshSegments: underfoot
        ? LOCAL_UNDERFOOT_MESH_SEGMENTS
        : meshSegmentsForRing(cell.ring),
      outerEdges: emptyEdgeMask(),
      skirtEdges: emptyEdgeMask(),
      edgeConstraints: {},
      geometrySignature: "",
    });
  }
  applyPlanEdgeStitching(
    active,
    finestZoom,
    onion.finestOriginX + LOCAL_RING_OUTER_TILES * 0.5,
  );
  for (const tile of active) {
    tile.geometrySignature = terrainCellGeometrySignature(tile);
  }
  return { onion, active };
}

export function selectNativeTerrainPlan(
  options: NativeTerrainPlanOptions,
): NativeTerrainPlan {
  const baseZoom = selectNativeTerrainZoom(
    options.latitudeDegrees,
    options.displayRadiusM,
    options.previousBaseZoom,
  );
  const finestZoom = Math.max(
    LOCAL_TERRAIN_MIN_ZOOM,
    Math.min(
      LOCAL_TERRAIN_MAX_ZOOM,
      baseZoom + Math.max(-3, Math.min(3, Math.round(options.lodBias ?? 0))),
    ),
  );
  const { onion, active } = fixedRingTiles(
    options.latitudeDegrees,
    options.longitudeDegrees,
    finestZoom,
    options.ringLevels ?? LOCAL_RING_LEVELS,
  );
  active.sort(
    (first, second) =>
      first.priority - second.priority ||
      second.z - first.z ||
      first.y - second.y ||
      first.x - second.x,
  );
  const minZoom =
    active.length > 0
      ? Math.min(...active.map((tile) => tile.z))
      : finestZoom;
  const required: MercatorTileAddress[] = [];
  const requiredKeys = new Set<string>();
  for (const tile of active) {
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
      if (!isValidMercatorAddress(address)) continue;
      const key = mercatorTileKey(address);
      if (requiredKeys.has(key)) continue;
      requiredKeys.add(key);
      required.push(address);
    }
  }
  const signature = [
    onion?.signature ?? `${finestZoom}:globe`,
    ...active.map((tile) => tile.geometrySignature).sort(),
  ].join("|");
  return {
    onion,
    active,
    required,
    baseZoom,
    finestZoom,
    minZoom,
    maxZoom: finestZoom,
    finestTileWidthM: renderedMercatorTileWidthM(
      options.latitudeDegrees,
      options.displayRadiusM,
      finestZoom,
    ),
    signature,
  };
}

export function heightLoadTasksForWindow(
  window: { required: readonly MercatorTileAddress[] },
): TileLoadTask[] {
  return window.required.map((address, priority) => ({
    address,
    priority,
  }));
}

export function mapterhornUrlForTile(address: MercatorTileAddress): string {
  return `https://tiles.mapterhorn.com/${address.z}/${address.x}/${address.y}.webp`;
}

export function terrariumElevationMetres(
  red: number,
  green: number,
  blue: number,
): number {
  return red * 256 + green + blue / 256 - 32_768;
}

export function decodeTerrariumPixels(
  pixels: ArrayLike<number>,
): DecodedHeightTile {
  if (pixels.length !== LOCAL_TILE_SIZE * LOCAL_TILE_SIZE * 4) {
    throw new Error("The Terrarium tile must decode to 512 × 512 pixels.");
  }
  const heights = new Int16Array(LOCAL_TILE_SIZE * LOCAL_TILE_SIZE);
  for (let index = 0; index < heights.length; index += 1) {
    const pixel = index * 4;
    const height = Math.round(
      terrariumElevationMetres(
        pixels[pixel] ?? 0,
        pixels[pixel + 1] ?? 0,
        pixels[pixel + 2] ?? 0,
      ),
    );
    heights[index] = Math.max(-12_000, Math.min(9_000, height));
  }
  return heights;
}

export function isOceanOnlyHeightTile(heights: DecodedHeightTile): boolean {
  for (const height of heights) {
    if (height !== 0) return false;
  }
  return true;
}

export function buildHeightGrid513(
  centre: DecodedHeightTile,
  east?: DecodedHeightTile,
  south?: DecodedHeightTile,
  southEast?: DecodedHeightTile,
): Float32Array {
  const grid = new Float32Array(LOCAL_GRID_SIZE * LOCAL_GRID_SIZE);
  for (let row = 0; row < LOCAL_TILE_SIZE; row += 1) {
    const sourceOffset = row * LOCAL_TILE_SIZE;
    grid.set(
      centre.subarray(sourceOffset, sourceOffset + LOCAL_TILE_SIZE),
      row * LOCAL_GRID_SIZE,
    );
    grid[row * LOCAL_GRID_SIZE + LOCAL_TILE_SIZE] =
      east?.[sourceOffset] ?? centre[sourceOffset + LOCAL_TILE_SIZE - 1] ?? 0;
  }
  const southOffset = LOCAL_TILE_SIZE * LOCAL_GRID_SIZE;
  for (let column = 0; column < LOCAL_TILE_SIZE; column += 1) {
    grid[southOffset + column] =
      south?.[column] ??
      centre[(LOCAL_TILE_SIZE - 1) * LOCAL_TILE_SIZE + column] ??
      0;
  }
  grid[southOffset + LOCAL_TILE_SIZE] =
    southEast?.[0] ??
    south?.[LOCAL_TILE_SIZE - 1] ??
    east?.[(LOCAL_TILE_SIZE - 1) * LOCAL_TILE_SIZE] ??
    centre[centre.length - 1] ??
    0;
  return grid;
}

export function terrainEdgeInterpolation(
  segments: number,
  pixelAlongEdge: number,
): { firstPixel: number; secondPixel: number; fraction: number } {
  const selectedSegments = Math.max(
    1,
    Math.min(LOCAL_TILE_SIZE, Math.round(segments)),
  );
  if (LOCAL_TILE_SIZE % selectedSegments !== 0) {
    throw new Error("The fixed terrain grid must divide the source tile.");
  }
  const step = LOCAL_TILE_SIZE / selectedSegments;
  const clampedPixel = Math.max(
    0,
    Math.min(LOCAL_TILE_SIZE, pixelAlongEdge),
  );
  const firstPixel = Math.min(
    LOCAL_TILE_SIZE - step,
    Math.floor(clampedPixel / step) * step,
  );
  const secondPixel = firstPixel + step;
  return {
    firstPixel,
    secondPixel,
    fraction: (clampedPixel - firstPixel) / step,
  };
}

export type TerrainOffsetM = readonly [number, number, number];

export function clampOceanSurfaceOffsetM(
  heightM: number,
  detailOffsetM: TerrainOffsetM,
): [number, number, number] {
  return heightM < 0 ? [0, 0, 0] : [...detailOffsetM];
}

export function interpolateTerrainOffsetM(
  first: TerrainOffsetM,
  second: TerrainOffsetM,
  fraction: number,
): [number, number, number] {
  return [
    first[0] + (second[0] - first[0]) * fraction,
    first[1] + (second[1] - first[1]) * fraction,
    first[2] + (second[2] - first[2]) * fraction,
  ];
}

export function interpolateOceanSurfaceOffsetM(
  firstHeightM: number,
  firstDetailOffsetM: TerrainOffsetM,
  secondHeightM: number,
  secondDetailOffsetM: TerrainOffsetM,
  fraction: number,
): [number, number, number] {
  return interpolateTerrainOffsetM(
    clampOceanSurfaceOffsetM(firstHeightM, firstDetailOffsetM),
    clampOceanSurfaceOffsetM(secondHeightM, secondDetailOffsetM),
    fraction,
  );
}

export function meshSegmentsForRing(ring: number, lodBias = 0): number {
  const index = Math.max(
    0,
    Math.min(
      LOCAL_RING_MESH_SEGMENTS.length - 1,
      Math.round(ring) - Math.round(lodBias),
    ),
  );
  return LOCAL_RING_MESH_SEGMENTS[index]!;
}

function smoothstep01(value: number): number {
  const fraction = Math.max(0, Math.min(1, value));
  return fraction * fraction * (3 - 2 * fraction);
}

export function localDetailEdgeFadeWeight(
  u: number,
  v: number,
  outer: LocalEdgeMask,
  unavailable: LocalEdgeMask,
  unavailableFadeFraction = 0.25,
): number {
  const edgeWeight = (
    distance: number,
    outerEnabled: number,
    unavailableEnabled: number,
  ): number =>
    Math.min(
      outerEnabled > 0 ? smoothstep01(distance) : 1,
      unavailableEnabled > 0
        ? smoothstep01(distance / unavailableFadeFraction)
        : 1,
    );
  return Math.min(
    edgeWeight(v, outer.north, unavailable.north),
    edgeWeight(1 - u, outer.east, unavailable.east),
    edgeWeight(1 - v, outer.south, unavailable.south),
    edgeWeight(u, outer.west, unavailable.west),
  );
}

export function resolveLocalElevation(
  globalHeightM: number,
  detailHeightM: number,
  detailWeight: number,
): number {
  const resolvedDetailM =
    Math.abs(detailHeightM) < 0.5 && globalHeightM < 0
      ? globalHeightM
      : detailHeightM;
  return (
    globalHeightM +
    (resolvedDetailM - globalHeightM) * Math.max(0, Math.min(1, detailWeight))
  );
}

export function localDetailEnabled(latitudeDegrees: number): boolean {
  return Math.abs(latitudeDegrees) < WEB_MERCATOR_MAX_LATITUDE;
}

export function lruEvictionKeys(
  items: Array<{ key: string; usedAt: number }>,
  limit: number,
): string[] {
  return [...items]
    .sort((first, second) => first.usedAt - second.usedAt)
    .slice(0, Math.max(0, items.length - limit))
    .map((item) => item.key);
}

export class LruCache<T> {
  private readonly items = new Map<string, { value: T; usedAt: number }>();
  private clock = 0;

  constructor(readonly limit: number) {}

  get size(): number {
    return this.items.size;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  get(key: string): T | undefined {
    const item = this.items.get(key);
    if (!item) return undefined;
    item.usedAt = ++this.clock;
    return item.value;
  }

  peek(key: string): T | undefined {
    return this.items.get(key)?.value;
  }

  set(key: string, value: T): Array<{ key: string; value: T }> {
    this.items.set(key, { value, usedAt: ++this.clock });
    const evicted: Array<{ key: string; value: T }> = [];
    for (const evictionKey of lruEvictionKeys(
      [...this.items].map(([itemKey, item]) => ({
        key: itemKey,
        usedAt: item.usedAt,
      })),
      this.limit,
    )) {
      const item = this.items.get(evictionKey);
      if (!item) continue;
      evicted.push({ key: evictionKey, value: item.value });
      this.items.delete(evictionKey);
    }
    return evicted;
  }

  delete(key: string): boolean {
    return this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }
}

export class TileRequestQueue<T> {
  private readonly wanted = new Map<string, TileLoadTask>();
  private readonly active = new Map<
    string,
    { task: TileLoadTask; controller: AbortController }
  >();

  constructor(
    private readonly load: (
      address: MercatorTileAddress,
      signal: AbortSignal,
    ) => Promise<T>,
    private readonly onLoaded: (
      task: TileLoadTask,
      value: T,
    ) => void | Promise<void>,
    private readonly onFailed: (task: TileLoadTask, error: unknown) => void,
    readonly concurrency = MAX_CONCURRENT_HEIGHT_REQUESTS,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  get queuedCount(): number {
    let count = 0;
    for (const key of this.wanted.keys()) {
      if (!this.active.has(key)) count += 1;
    }
    return count;
  }

  sync(tasks: TileLoadTask[]): void {
    this.wanted.clear();
    for (const task of tasks) {
      const key = mercatorTileKey(task.address);
      const existing = this.wanted.get(key);
      if (!existing || task.priority < existing.priority) {
        this.wanted.set(key, task);
      }
    }
    for (const [key, request] of this.active) {
      if (!this.wanted.has(key)) request.controller.abort();
    }
    this.pump();
  }

  dispose(): void {
    this.wanted.clear();
    for (const request of this.active.values()) {
      request.controller.abort();
    }
  }

  private pump(): void {
    while (this.active.size < this.concurrency) {
      const next = [...this.wanted.entries()]
        .filter(([key]) => !this.active.has(key))
        .sort((first, second) => {
          const priority = first[1].priority - second[1].priority;
          return priority || first[0].localeCompare(second[0]);
        })[0];
      if (!next) return;
      const [key, task] = next;
      const controller = new AbortController();
      this.active.set(key, { task, controller });
      void this.load(task.address, controller.signal)
        .then(async (value) => {
          if (!controller.signal.aborted) {
            await this.onLoaded(task, value);
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) this.onFailed(task, error);
        })
        .finally(() => {
          if (this.active.get(key)?.controller === controller) {
            this.active.delete(key);
          }
          if (!controller.signal.aborted) this.wanted.delete(key);
          this.pump();
        });
    }
  }
}
