import {
  DEFAULT_EYE_HEIGHT_M,
  terrainHorizonRadians,
} from "./terrain-horizon.js";

export const LOCAL_TERRAIN_MIN_ZOOM = 0;
export const LOCAL_TERRAIN_MAX_ZOOM = 12;
export const LOCAL_TILE_SIZE = 512;
export const LOCAL_GRID_SIZE = LOCAL_TILE_SIZE + 1;
export const LOCAL_WINDOW_SIZE = 5;
export const LOCAL_HEIGHT_CACHE_LIMIT = 64;
export const MAX_CONCURRENT_HEIGHT_REQUESTS = 4;
export const LOCAL_MESH_VERTEX_LIMIT = 16_384;
export const LOCAL_GEOMETRY_BUDGET_BYTES = 32 * 1_024 * 1_024;
export const LOCAL_SCALE_SETTLE_MS = 250;
export const LOCAL_RETIRE_SECONDS = 0.12;
export const LOCAL_TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000] as const;
export const LOCAL_MALFORMED_RETRY_DELAY_MS = 5 * 60_000;
export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
export const RTIN_ERROR_BUCKETS_M = [5, 10, 20, 40, 80, 150] as const;
export const RTIN_FALLBACK_ERROR_BUCKETS_M = [
  300, 600, 1_200, 2_400, 4_800, 9_600,
] as const;
const EARTH_RADIUS_M = 6_371_008.8;
const TARGET_PROJECTED_VERTICAL_ERROR_M = 0.002;

export interface MercatorTileAddress {
  z: number;
  x: number;
  y: number;
}

export interface LocalTileAddress extends MercatorTileAddress {
  column: number;
  row: number;
}

export interface MercatorTileWindow {
  zoom: number;
  originX: number;
  originY: number;
  columns: number;
  rows: number;
  active: LocalTileAddress[];
  required: LocalTileAddress[];
}

export interface MercatorHorizonBounds {
  angularRadiusRadians: number;
  centreX: number;
  centreY: number;
  westX: number;
  eastX: number;
  northY: number;
  southY: number;
}

export interface MercatorHorizonCoverage {
  covered: boolean;
  westMarginTiles: number;
  eastMarginTiles: number;
  northMarginTiles: number;
  southMarginTiles: number;
}

export interface TileLoadTask {
  address: MercatorTileAddress;
  priority: number;
}

export interface LocalEdgeMask {
  north: number;
  east: number;
  south: number;
  west: number;
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
    }
  | {
      type: "mesh";
      requestId: number;
      generation: number;
      address: MercatorTileAddress;
      errorM: number;
      vertexLimit: number;
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
      requestedErrorM: number;
      actualErrorM: number;
      positions: Float32Array;
      normals: Float32Array;
      uvs: Float32Array;
      heightUvs: Float32Array;
      detailHeightsM: Float32Array;
      skirtEdges: Float32Array;
      indices: Uint32Array;
      boundingCentre: Float32Array;
      boundingRadius: number;
      geometryBytes: number;
    }
  | {
      type: "overbudget";
      requestId: number;
      generation: number;
      address: MercatorTileAddress;
      requestedErrorM: number;
      vertexCount: number;
    }
  | {
      type: "error";
      requestId: number;
      generation: number;
      address?: MercatorTileAddress;
      message: string;
      missing?: boolean;
    };

export function terrainScaleInputChanged(
  previousDisplayRadiusM: number | undefined,
  previousRadialMultiplier: number | undefined,
  displayRadiusM: number,
  radialMultiplier: number,
): boolean {
  if (
    previousDisplayRadiusM === undefined ||
    previousRadialMultiplier === undefined
  ) {
    return false;
  }
  return (
    Math.abs(
      Math.log2(
        Math.max(0.001, displayRadiusM) /
          Math.max(0.001, previousDisplayRadiusM),
      ),
    ) > 1e-5 || Math.abs(radialMultiplier - previousRadialMultiplier) > 1e-5
  );
}

export function terrainScaleInputIsStable(
  nowMs: number,
  lastChangeMs: number,
  settleMs = LOCAL_SCALE_SETTLE_MS,
): boolean {
  return nowMs - lastChangeMs >= settleMs;
}

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
    (clampMercatorLatitude(latitudeDegrees) * Math.PI) / 180;
  const width = 2 ** zoom;
  return {
    x: ((wrapLongitude(longitudeDegrees) + 180) / 360) * width,
    y:
      ((1 -
        Math.log(Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians)) /
          Math.PI) /
        2) *
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
      (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
  };
}

export function selectLocalTileWindow(
  latitudeDegrees: number,
  longitudeDegrees: number,
  zoom: number,
): MercatorTileWindow {
  const selectedZoom = Math.max(
    LOCAL_TERRAIN_MIN_ZOOM,
    Math.min(LOCAL_TERRAIN_MAX_ZOOM, Math.round(zoom)),
  );
  const centre = mercatorAddressForCoordinates(
    latitudeDegrees,
    longitudeDegrees,
    selectedZoom,
  );
  const width = 2 ** selectedZoom;
  const columns = Math.min(LOCAL_WINDOW_SIZE, width);
  const rows = Math.min(LOCAL_WINDOW_SIZE, width);
  const originX =
    columns === width
      ? 0
      : wrapMercatorX(centre.x - Math.floor(columns / 2), selectedZoom);
  const originY = Math.max(
    0,
    Math.min(width - rows, centre.y - Math.floor(rows / 2)),
  );
  const addressAt = (column: number, row: number): LocalTileAddress => ({
    z: selectedZoom,
    x: wrapMercatorX(originX + column, selectedZoom),
    y: originY + row,
    column,
    row,
  });
  const active: LocalTileAddress[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      active.push(addressAt(column, row));
    }
  }
  active.sort((first, second) => {
    const firstDistance = Math.hypot(
      first.column - columns / 2 + 0.5,
      first.row - rows / 2 + 0.5,
    );
    const secondDistance = Math.hypot(
      second.column - columns / 2 + 0.5,
      second.row - rows / 2 + 0.5,
    );
    return (
      firstDistance - secondDistance ||
      first.row - second.row ||
      first.column - second.column
    );
  });
  const required = [...active];
  const hasSouthHalo = originY + rows < width;
  if (columns < width) {
    const requiredRows = rows + Number(hasSouthHalo);
    for (let row = 0; row < requiredRows; row += 1) {
      required.push(addressAt(columns, row));
    }
  }
  if (hasSouthHalo) {
    for (let column = 0; column < columns; column += 1) {
      required.push(addressAt(column, rows));
    }
  }
  return {
    zoom: selectedZoom,
    originX,
    originY,
    columns,
    rows,
    active,
    required,
  };
}

export function heightLoadTasksForWindow(
  window: MercatorTileWindow,
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

export function rtinErrorBucket(
  displayRadiusM: number,
  radialMultiplier: number,
  outerRing = false,
): number {
  const targetSourceErrorM =
    (TARGET_PROJECTED_VERTICAL_ERROR_M * EARTH_RADIUS_M) /
    Math.max(0.001, displayRadiusM * Math.max(0.25, radialMultiplier));
  let index = 0;
  for (
    let candidate = 0;
    candidate < RTIN_ERROR_BUCKETS_M.length;
    candidate += 1
  ) {
    if (RTIN_ERROR_BUCKETS_M[candidate]! <= targetSourceErrorM) {
      index = candidate;
    }
  }
  if (outerRing) {
    index = Math.min(index + 1, RTIN_ERROR_BUCKETS_M.length - 1);
  }
  return RTIN_ERROR_BUCKETS_M[index]!;
}

export function localTerrainSourceSampleM(
  latitudeDegrees: number,
  zoom: number,
): number {
  const latitude = (clampMercatorLatitude(latitudeDegrees) * Math.PI) / 180;
  return (
    (Math.max(0, Math.cos(latitude)) * 2 * Math.PI * EARTH_RADIUS_M) /
    (LOCAL_TILE_SIZE * 2 ** zoom)
  );
}

function horizonLongitudeDeltaRadians(
  centreLatitudeRadians: number,
  angularRadiusRadians: number,
  latitudeRadians: number,
): number {
  const denominator =
    Math.cos(centreLatitudeRadians) * Math.cos(latitudeRadians);
  if (Math.abs(denominator) < 1e-12) return Math.PI;
  const cosineDelta =
    (Math.cos(angularRadiusRadians) -
      Math.sin(centreLatitudeRadians) * Math.sin(latitudeRadians)) /
    denominator;
  if (cosineDelta <= -1) return Math.PI;
  if (cosineDelta >= 1) return 0;
  return Math.acos(cosineDelta);
}

export function mercatorHorizonBounds(
  latitudeDegrees: number,
  longitudeDegrees: number,
  displayRadiusM: number,
  eyeHeightM = DEFAULT_EYE_HEIGHT_M,
): MercatorHorizonBounds {
  const maximumLatitudeRadians = (WEB_MERCATOR_MAX_LATITUDE * Math.PI) / 180;
  const centreLatitudeRadians =
    (clampMercatorLatitude(latitudeDegrees) * Math.PI) / 180;
  const angularRadiusRadians = terrainHorizonRadians(
    displayRadiusM,
    eyeHeightM,
  );
  const northLatitudeRadians = Math.min(
    maximumLatitudeRadians,
    centreLatitudeRadians + angularRadiusRadians,
  );
  const southLatitudeRadians = Math.max(
    -maximumLatitudeRadians,
    centreLatitudeRadians - angularRadiusRadians,
  );
  const longitudeCandidates = [
    southLatitudeRadians,
    centreLatitudeRadians,
    northLatitudeRadians,
  ];
  const criticalSine =
    Math.sin(centreLatitudeRadians) /
    Math.max(1e-12, Math.cos(angularRadiusRadians));
  if (Math.abs(criticalSine) <= 1) {
    const criticalLatitude = Math.asin(criticalSine);
    if (
      criticalLatitude >= southLatitudeRadians &&
      criticalLatitude <= northLatitudeRadians
    ) {
      longitudeCandidates.push(criticalLatitude);
    }
  }
  const longitudeDeltaRadians = Math.min(
    Math.PI,
    Math.max(
      ...longitudeCandidates.map((latitude) =>
        horizonLongitudeDeltaRadians(
          centreLatitudeRadians,
          angularRadiusRadians,
          latitude,
        ),
      ),
    ),
  );
  const centre = mercatorPointForCoordinates(
    latitudeDegrees,
    longitudeDegrees,
    0,
  );
  const north = mercatorPointForCoordinates(
    (northLatitudeRadians * 180) / Math.PI,
    longitudeDegrees,
    0,
  );
  const south = mercatorPointForCoordinates(
    (southLatitudeRadians * 180) / Math.PI,
    longitudeDegrees,
    0,
  );
  const longitudeOffset = longitudeDeltaRadians / (2 * Math.PI);
  return {
    angularRadiusRadians,
    centreX: centre.x,
    centreY: centre.y,
    westX: centre.x - longitudeOffset,
    eastX: centre.x + longitudeOffset,
    northY: north.y,
    southY: south.y,
  };
}

export function localTerrainHorizonCoverage(
  window: MercatorTileWindow,
  bounds: MercatorHorizonBounds,
): MercatorHorizonCoverage {
  const width = 2 ** window.zoom;
  let westMarginTiles: number;
  let eastMarginTiles: number;
  if (window.columns === width) {
    westMarginTiles = 0;
    eastMarginTiles = 0;
  } else {
    let windowWest = window.originX / width;
    while (windowWest > bounds.centreX) windowWest -= 1;
    while (windowWest + window.columns / width < bounds.centreX) {
      windowWest += 1;
    }
    const windowEast = windowWest + window.columns / width;
    westMarginTiles = (bounds.westX - windowWest) * width;
    eastMarginTiles = (windowEast - bounds.eastX) * width;
  }
  const windowNorth = window.originY / width;
  const windowSouth = (window.originY + window.rows) / width;
  const northMarginTiles = (bounds.northY - windowNorth) * width;
  const southMarginTiles = (windowSouth - bounds.southY) * width;
  const epsilon = 1e-9;
  return {
    covered:
      westMarginTiles >= -epsilon &&
      eastMarginTiles >= -epsilon &&
      northMarginTiles >= -epsilon &&
      southMarginTiles >= -epsilon,
    westMarginTiles,
    eastMarginTiles,
    northMarginTiles,
    southMarginTiles,
  };
}

export function selectLocalTerrainZoom(
  latitudeDegrees: number,
  longitudeDegrees: number,
  displayRadiusM: number,
  eyeHeightM = DEFAULT_EYE_HEIGHT_M,
): number {
  const bounds = mercatorHorizonBounds(
    latitudeDegrees,
    longitudeDegrees,
    displayRadiusM,
    eyeHeightM,
  );
  for (
    let zoom = LOCAL_TERRAIN_MAX_ZOOM;
    zoom >= LOCAL_TERRAIN_MIN_ZOOM;
    zoom -= 1
  ) {
    const window = selectLocalTileWindow(
      latitudeDegrees,
      longitudeDegrees,
      zoom,
    );
    if (localTerrainHorizonCoverage(window, bounds).covered) {
      return zoom;
    }
  }
  return LOCAL_TERRAIN_MIN_ZOOM;
}

export function localDetailEnabled(latitudeDegrees: number): boolean {
  return Math.abs(latitudeDegrees) < WEB_MERCATOR_MAX_LATITUDE;
}

export function localDetailBlendWeight(
  column: number,
  row: number,
  pixelX: number,
  pixelY: number,
): number {
  const x = column + pixelX / LOCAL_TILE_SIZE;
  const y = row + pixelY / LOCAL_TILE_SIZE;
  const distance = Math.max(
    0,
    Math.min(x, y, LOCAL_WINDOW_SIZE - x, LOCAL_WINDOW_SIZE - y),
  );
  const fraction = Math.min(1, distance);
  return fraction * fraction * (3 - 2 * fraction);
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

export function forceFullRtinBoundary(
  errors: Float32Array,
  gridSize = LOCAL_GRID_SIZE,
): void {
  if (errors.length !== gridSize * gridSize) {
    throw new Error("The RTIN error grid has an unexpected size.");
  }
  const last = gridSize - 1;
  for (let coordinate = 0; coordinate < gridSize; coordinate += 1) {
    errors[coordinate] = Infinity;
    errors[last * gridSize + coordinate] = Infinity;
    errors[coordinate * gridSize] = Infinity;
    errors[coordinate * gridSize + last] = Infinity;
  }
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

  entries(): Array<[string, T]> {
    return [...this.items].map(([key, item]) => [key, item.value]);
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
    private readonly onLoaded: (task: TileLoadTask, value: T) => void,
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
        .then((value) => {
          if (!controller.signal.aborted) this.onLoaded(task, value);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) this.onFailed(task, error);
        })
        .finally(() => {
          if (this.active.get(key)?.controller === controller) {
            this.active.delete(key);
          }
          // An aborted request may have been re-added before its promise
          // settled. Preserve that newer wanted entry so pump() can restart it.
          if (!controller.signal.aborted) this.wanted.delete(key);
          this.pump();
        });
    }
  }
}
