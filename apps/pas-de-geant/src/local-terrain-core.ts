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
}

export interface NativeTerrainPlan {
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

function parentAddress(
  address: MercatorTileAddress,
): MercatorTileAddress | undefined {
  if (address.z <= LOCAL_TERRAIN_MIN_ZOOM) return undefined;
  return {
    z: address.z - 1,
    x: Math.floor(address.x / 2),
    y: Math.floor(address.y / 2),
  };
}

function tileHasCoverage(
  address: MercatorTileAddress,
  exactKeys: ReadonlySet<string>,
  descendantCoverageKeys: ReadonlySet<string>,
): "same" | "mixed" | "none" {
  if (exactKeys.has(mercatorTileKey(address))) return "same";
  let ancestor = parentAddress(address);
  while (ancestor) {
    if (exactKeys.has(mercatorTileKey(ancestor))) return "mixed";
    ancestor = parentAddress(ancestor);
  }
  return descendantCoverageKeys.has(mercatorTileKey(address))
    ? "mixed"
    : "none";
}

function applyPlanEdgeMasks(active: NativeTerrainTile[]): void {
  const exactKeys = new Set(active.map(mercatorTileKey));
  const exactTiles = new Map(active.map((tile) => [mercatorTileKey(tile), tile]));
  const descendantCoverageKeys = new Set<string>();
  for (const tile of active) {
    let parent = parentAddress(tile);
    while (parent) {
      descendantCoverageKeys.add(mercatorTileKey(parent));
      parent = parentAddress(parent);
    }
  }
  const directions = [
    ["north", 0, -1],
    ["east", 1, 0],
    ["south", 0, 1],
    ["west", -1, 0],
  ] as const;
  for (const tile of active) {
    for (const [edge, deltaX, deltaY] of directions) {
      const neighbour = {
        z: tile.z,
        x: wrapMercatorX(tile.x + deltaX, tile.z),
        y: tile.y + deltaY,
      };
      if (!isValidMercatorAddress(neighbour)) {
        tile.outerEdges[edge] = 1;
        tile.skirtEdges[edge] = 1;
        continue;
      }
      const exactNeighbour = exactTiles.get(mercatorTileKey(neighbour));
      if (
        exactNeighbour &&
        exactNeighbour.meshSegments !== tile.meshSegments
      ) {
        tile.outerEdges[edge] = 1;
        tile.skirtEdges[edge] = 1;
        continue;
      }
      const coverage = tileHasCoverage(
        neighbour,
        exactKeys,
        descendantCoverageKeys,
      );
      if (coverage === "none") {
        tile.outerEdges[edge] = 1;
        tile.skirtEdges[edge] = 1;
      } else if (coverage === "mixed") {
        tile.outerEdges[edge] = 1;
        tile.skirtEdges[edge] = 1;
      }
    }
  }
}

function allWorldTiles(zoom: number): NativeTerrainTile[] {
  const width = 2 ** zoom;
  const active: NativeTerrainTile[] = [];
  const centre = (width - 1) * 0.5;
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      active.push({
        z: zoom,
        x,
        y,
        ring: 0,
        priority: Math.hypot(x - centre, y - centre),
        meshSegments: meshSegmentsForRing(0),
        outerEdges: emptyEdgeMask(),
        skirtEdges: emptyEdgeMask(),
      });
    }
  }
  return active;
}

function fixedRingLayout(
  latitudeDegrees: number,
  longitudeDegrees: number,
  finestZoom: number,
  requestedRingLevels: number,
): {
  ringLevels: number;
  origins: Array<{ x: number; y: number }>;
  underfootOrigin: { x: number; y: number };
} {
  const ringLevels = Math.max(
    1,
    Math.min(
      Math.floor(requestedRingLevels),
      LOCAL_RING_LEVELS,
      finestZoom - 2,
    ),
  );
  const finestCentre = mercatorAddressForCoordinates(
    latitudeDegrees,
    longitudeDegrees,
    finestZoom,
  );
  const finestPoint = mercatorPointForCoordinates(
    latitudeDegrees,
    longitudeDegrees,
    finestZoom,
  );
  const finestWidth = 2 ** finestZoom;
  const anchorStride = 2 ** (ringLevels - 1);
  const anchorMargin = Math.round(
    (LOCAL_RING_OUTER_TILES - anchorStride) * 0.5,
  );
  let originX =
    Math.floor((finestCentre.x - anchorMargin) / anchorStride) * anchorStride;
  let originY =
    Math.floor((finestCentre.y - anchorMargin) / anchorStride) * anchorStride;
  originY = Math.max(
    0,
    Math.min(finestWidth - LOCAL_RING_OUTER_TILES, originY),
  );
  const origins: Array<{ x: number; y: number }> = [{ x: originX, y: originY }];
  for (let ring = 1; ring < ringLevels; ring += 1) {
    originX = Math.floor(originX / 2) - 2;
    originY = Math.floor(originY / 2) - 2;
    origins.push({ x: originX, y: originY });
  }
  return {
    ringLevels,
    origins,
    underfootOrigin: {
      x: Math.floor(finestPoint.x - 0.5),
      y: Math.max(
        0,
        Math.min(finestWidth - 2, Math.floor(finestPoint.y - 0.5)),
      ),
    },
  };
}

export function nativeTerrainPlanAnchorKey(
  latitudeDegrees: number,
  longitudeDegrees: number,
  finestZoom: number,
  requestedRingLevels = LOCAL_RING_LEVELS,
): string {
  if (finestZoom < 3) return `${finestZoom}:world`;
  const layout = fixedRingLayout(
    latitudeDegrees,
    longitudeDegrees,
    finestZoom,
    requestedRingLevels,
  );
  return [
    finestZoom,
    layout.ringLevels,
    layout.underfootOrigin.x,
    layout.underfootOrigin.y,
    ...layout.origins.flatMap((origin) => [origin.x, origin.y]),
  ].join(":");
}

function fixedRingTiles(
  latitudeDegrees: number,
  longitudeDegrees: number,
  finestZoom: number,
  requestedRingLevels: number,
): NativeTerrainTile[] {
  if (finestZoom < 3) return allWorldTiles(finestZoom);

  const { ringLevels, origins, underfootOrigin } = fixedRingLayout(
    latitudeDegrees,
    longitudeDegrees,
    finestZoom,
    requestedRingLevels,
  );
  const active: NativeTerrainTile[] = [];
  for (let ring = 0; ring < ringLevels; ring += 1) {
    const zoom = finestZoom - ring;
    const origin = origins[ring]!;
    for (let row = 0; row < LOCAL_RING_OUTER_TILES; row += 1) {
      for (let column = 0; column < LOCAL_RING_OUTER_TILES; column += 1) {
        if (
          ring > 0 &&
          row >= 2 &&
          row < 2 + LOCAL_RING_HOLE_TILES &&
          column >= 2 &&
          column < 2 + LOCAL_RING_HOLE_TILES
        ) {
          continue;
        }
        const address = {
          z: zoom,
          x: wrapMercatorX(origin.x + column, zoom),
          y: origin.y + row,
        };
        if (!isValidMercatorAddress(address)) continue;
        active.push({
          ...address,
          ring,
          priority: ring * LOCAL_RING_OUTER_TILES +
            Math.hypot(column - 3.5, row - 3.5),
          meshSegments:
            ring === 0 &&
              (address.x === wrapMercatorX(underfootOrigin.x, finestZoom) ||
                address.x ===
                  wrapMercatorX(underfootOrigin.x + 1, finestZoom)) &&
              (address.y === underfootOrigin.y ||
                address.y === underfootOrigin.y + 1)
              ? LOCAL_UNDERFOOT_MESH_SEGMENTS
              : meshSegmentsForRing(ring),
          outerEdges: emptyEdgeMask(),
          skirtEdges: emptyEdgeMask(),
        });
      }
    }
  }
  return active;
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
  const active = fixedRingTiles(
    options.latitudeDegrees,
    options.longitudeDegrees,
    finestZoom,
    options.ringLevels ?? LOCAL_RING_LEVELS,
  );
  applyPlanEdgeMasks(active);
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
  const signature = active
    .map(
      (tile) =>
        `${mercatorTileKey(tile)}@${tile.ring}:${tile.meshSegments}`,
    )
    .sort()
    .join("|");
  return {
    active,
    required: active,
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
