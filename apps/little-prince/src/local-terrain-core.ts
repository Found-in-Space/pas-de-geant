import {
  DEFAULT_EYE_HEIGHT_M,
  FALLBACK_MAX_ELEVATION_M,
  terrainHorizonDiameterM,
} from "./terrain-horizon.js";

export const LOCAL_TERRAIN_MIN_ZOOM = 3;
export const LOCAL_TERRAIN_MAX_ZOOM = 12;
export const LOCAL_TILE_SIZE = 512;
export const LOCAL_GRID_SIZE = LOCAL_TILE_SIZE + 1;
export const LOCAL_WINDOW_SIZE = 5;
export const LOCAL_HALO_SIZE = LOCAL_WINDOW_SIZE + 1;
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
  300,
  600,
  1_200,
  2_400,
  4_800,
  9_600,
] as const;
export const LOCAL_DETAIL_TARGET_SAMPLE_WORLD_M = 0.0004;
export const LOCAL_DETAIL_ZOOM_HYSTERESIS = 1.2;
/**
 * The contact point can lie anywhere in the centre tile. This factor ensures
 * the nearer edge of the 5×5 window still reaches the calculated horizon.
 */
export const LOCAL_HORIZON_COVERAGE_PADDING =
  LOCAL_WINDOW_SIZE / (LOCAL_WINDOW_SIZE - 1);

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
  active: LocalTileAddress[];
  required: LocalTileAddress[];
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

export type ElevationFailureKind =
  | "not-found"
  | "transient"
  | "malformed";

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
    ) > 1e-5 ||
    Math.abs(radialMultiplier - previousRadialMultiplier) > 1e-5
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
    retryAtMs:
      nowMs + (delay ?? LOCAL_MALFORMED_RETRY_DELAY_MS),
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

export function wrapLongitude(longitudeDegrees: number): number {
  return ((longitudeDegrees + 180) % 360 + 360) % 360 - 180;
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
        Math.log(
          Math.tan(latitudeRadians) + 1 / Math.cos(latitudeRadians),
        ) /
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
  const originX = wrapMercatorX(
    centre.x - Math.floor(LOCAL_WINDOW_SIZE / 2),
    selectedZoom,
  );
  const originY = Math.max(
    0,
    Math.min(
      width - LOCAL_HALO_SIZE,
      centre.y - Math.floor(LOCAL_WINDOW_SIZE / 2),
    ),
  );
  const addressAt = (column: number, row: number): LocalTileAddress => ({
    z: selectedZoom,
    x: wrapMercatorX(originX + column, selectedZoom),
    y: originY + row,
    column,
    row,
  });
  const active: LocalTileAddress[] = [];
  for (let row = 0; row < LOCAL_WINDOW_SIZE; row += 1) {
    for (let column = 0; column < LOCAL_WINDOW_SIZE; column += 1) {
      active.push(addressAt(column, row));
    }
  }
  active.sort((first, second) => {
    const firstDistance = Math.hypot(
      first.column - LOCAL_WINDOW_SIZE / 2 + 0.5,
      first.row - LOCAL_WINDOW_SIZE / 2 + 0.5,
    );
    const secondDistance = Math.hypot(
      second.column - LOCAL_WINDOW_SIZE / 2 + 0.5,
      second.row - LOCAL_WINDOW_SIZE / 2 + 0.5,
    );
    return (
      firstDistance - secondDistance ||
      first.row - second.row ||
      first.column - second.column
    );
  });
  const required = [...active];
  for (let row = 0; row < LOCAL_HALO_SIZE; row += 1) {
    required.push(addressAt(LOCAL_WINDOW_SIZE, row));
  }
  for (let column = 0; column < LOCAL_WINDOW_SIZE; column += 1) {
    required.push(addressAt(column, LOCAL_WINDOW_SIZE));
  }
  return {
    zoom: selectedZoom,
    originX,
    originY,
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

export function mapterhornUrlForTile(
  address: MercatorTileAddress,
): string {
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

export function isOceanOnlyHeightTile(
  heights: DecodedHeightTile,
): boolean {
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
      east?.[sourceOffset] ??
      centre[sourceOffset + LOCAL_TILE_SIZE - 1] ??
      0;
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
    TARGET_PROJECTED_VERTICAL_ERROR_M *
    EARTH_RADIUS_M /
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

export function localTerrainPatchWidthM(
  latitudeDegrees: number,
  displayRadiusM: number,
  zoom: number,
): number {
  const latitude = clampMercatorLatitude(latitudeDegrees) * Math.PI / 180;
  return (
    LOCAL_WINDOW_SIZE *
    2 *
    Math.PI *
    Math.max(0.001, displayRadiusM) *
    Math.max(0, Math.cos(latitude)) /
    2 ** zoom
  );
}

export function localTerrainProjectedSampleM(
  latitudeDegrees: number,
  displayRadiusM: number,
  radialMultiplier: number,
  zoom: number,
): number {
  const latitude = clampMercatorLatitude(latitudeDegrees) * Math.PI / 180;
  const effectiveRadiusM =
    Math.max(0.001, displayRadiusM) *
    Math.sqrt(Math.max(0.25, radialMultiplier));
  return (
    Math.max(0, Math.cos(latitude)) *
    2 *
    Math.PI *
    effectiveRadiusM /
    (LOCAL_TILE_SIZE * 2 ** zoom)
  );
}

export function selectLocalTerrainZoom(
  latitudeDegrees: number,
  displayRadiusM: number,
  radialMultiplier: number,
  previousZoom?: number,
  eyeHeightM = DEFAULT_EYE_HEIGHT_M,
  maximumElevationM = FALLBACK_MAX_ELEVATION_M,
): number {
  let detailZoom: number;
  if (previousZoom === undefined) {
    detailZoom = LOCAL_TERRAIN_MAX_ZOOM;
    for (
      let zoom = LOCAL_TERRAIN_MIN_ZOOM;
      zoom <= LOCAL_TERRAIN_MAX_ZOOM;
      zoom += 1
    ) {
      if (
        localTerrainProjectedSampleM(
          latitudeDegrees,
          displayRadiusM,
          radialMultiplier,
          zoom,
        ) <= LOCAL_DETAIL_TARGET_SAMPLE_WORLD_M
      ) {
        detailZoom = zoom;
        break;
      }
    }
  } else {
    detailZoom = Math.max(
      LOCAL_TERRAIN_MIN_ZOOM,
      Math.min(LOCAL_TERRAIN_MAX_ZOOM, Math.round(previousZoom)),
    );
    while (
      detailZoom < LOCAL_TERRAIN_MAX_ZOOM &&
      localTerrainProjectedSampleM(
        latitudeDegrees,
        displayRadiusM,
        radialMultiplier,
        detailZoom,
      ) >
        LOCAL_DETAIL_TARGET_SAMPLE_WORLD_M *
          LOCAL_DETAIL_ZOOM_HYSTERESIS
    ) {
      detailZoom += 1;
    }
    while (
      detailZoom > LOCAL_TERRAIN_MIN_ZOOM &&
      localTerrainProjectedSampleM(
        latitudeDegrees,
        displayRadiusM,
        radialMultiplier,
        detailZoom - 1,
      ) <= LOCAL_DETAIL_TARGET_SAMPLE_WORLD_M
    ) {
      detailZoom -= 1;
    }
  }

  const requiredPatchWidthM =
    terrainHorizonDiameterM(
      displayRadiusM,
      radialMultiplier,
      eyeHeightM,
      maximumElevationM,
    ) * LOCAL_HORIZON_COVERAGE_PADDING;
  let coverageZoom = LOCAL_TERRAIN_MIN_ZOOM;
  while (
    coverageZoom < LOCAL_TERRAIN_MAX_ZOOM &&
    localTerrainPatchWidthM(
      latitudeDegrees,
      displayRadiusM,
      coverageZoom + 1,
    ) >= requiredPatchWidthM
  ) {
    coverageZoom += 1;
  }
  return Math.min(detailZoom, coverageZoom);
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
  ): number => Math.min(
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
    (resolvedDetailM - globalHeightM) *
      Math.max(0, Math.min(1, detailWeight))
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
  private readonly items = new Map<
    string,
    { value: T; usedAt: number }
  >();
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
