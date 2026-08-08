import {
  deleteCachedElevation,
  loadElevationFromNetwork,
  lookupCachedElevation,
  type ElevationCacheStatus,
  type ElevationPayload,
} from "./elevation-cache.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "./tile-provider.js";
import {
  isSessionFatalStatus,
  type TileRequestFailureMetadata,
} from "./tile-request-circuit.js";
import { TileSourceLoadQueue } from "./tile-source-load-queue.js";

export type ImageTileKind = "imagery" | "terrain";
export const ELEVATION_TILE_PIXELS = 512;
export const ELEVATION_MAX_ZOOM = 12;
export type ImageTileCacheStatus =
  | "memory"
  | "shared"
  | "provider"
  | "persistent-hit"
  | "persistent-write"
  | "persistent-unavailable"
  | "persistent-error";

export interface ImageTileResource {
  readonly kind: "image";
  readonly mode: ImageTileKind;
  readonly tile: TileIdentity;
  readonly sourceTile: TileIdentity;
  readonly image: HTMLImageElement;
  readonly tilePixels: number;
  readonly sourceScale: number;
  readonly sourceOffsetX: number;
  readonly sourceOffsetY: number;
  readonly cacheStatus: ImageTileCacheStatus;
  readonly loadDurationMs: number;
  readonly byteLength: number;
}

export interface ImageTileProviderMetrics {
  readonly requestTotal: number;
  readonly sourceLoadTotal: number;
  readonly cacheLookupTotal: number;
  readonly cacheHitTotal: number;
  readonly memoryHitTotal: number;
  readonly sharedRequestTotal: number;
  readonly persistentHitTotal: number;
  readonly persistentWriteTotal: number;
  readonly failureTotal: number;
  readonly byteTotal: number;
  readonly estimatedAssetReadyMs: number;
  readonly queued: number;
  readonly networkDeferred: number;
  readonly inFlight: number;
  readonly warmRampActive: boolean;
  readonly warmRampLimit: number;
  readonly decodedSourceCount: number;
  readonly estimatedDecodedBytes: number;
}

interface SourceMapping {
  readonly sourceTile: TileIdentity;
  readonly sourceScale: number;
  readonly sourceOffsetX: number;
  readonly sourceOffsetY: number;
}

interface LoadedSource {
  readonly image: HTMLImageElement;
  readonly byteLength: number;
  readonly cacheStatus: Exclude<ImageTileCacheStatus, "memory" | "shared">;
  readonly loadDurationMs: number;
}

export interface SourceImageLoad {
  readonly image: HTMLImageElement;
  readonly byteLength: number;
  readonly cacheStatus: LoadedSource["cacheStatus"];
}

export interface ImageTileProviderOptions {
  readonly mode: ImageTileKind;
  readonly tilePixels: number;
  readonly attribution?: string;
  readonly concurrency: number;
  resolveSource(tile: TileIdentity): SourceMapping;
  /** Optional persistent-cache phase; undefined is a cache miss. */
  loadFromCache?(
    sourceTile: TileIdentity,
    signal: AbortSignal,
  ): Promise<SourceImageLoad | undefined>;
  /** Provider/network phase. It is called only after cache lookup and admission. */
  loadSource(
    sourceTile: TileIdentity,
    signal: AbortSignal,
  ): Promise<SourceImageLoad>;
}

function immutableTile(tile: TileIdentity): TileIdentity {
  return Object.freeze({ z: tile.z, x: tile.x, y: tile.y });
}

function sourceMapping(
  tile: TileIdentity,
  sourceTile: TileIdentity,
): SourceMapping {
  const sourceScale = 2 ** (tile.z - sourceTile.z);
  return Object.freeze({
    sourceTile: immutableTile(sourceTile),
    sourceScale,
    sourceOffsetX: tile.x - sourceTile.x * sourceScale,
    sourceOffsetY: tile.y - sourceTile.y * sourceScale,
  });
}

function ancestorAtZoom(tile: TileIdentity, zoom: number): TileIdentity {
  const sourceZoom = Math.max(0, Math.min(tile.z, Math.floor(zoom)));
  const divisor = 2 ** (tile.z - sourceZoom);
  return {
    z: sourceZoom,
    x: Math.floor(tile.x / divisor),
    y: Math.floor(tile.y / divisor),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : "Tile image loading failed.";
}

export class HttpTileError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** The provider responded successfully, but the returned tile was unusable. */
export class TileContentError extends Error {}

function imageFailureMetadata(error: unknown): TileRequestFailureMetadata {
  if (isAbortError(error)) return { systemic: false };
  if (error instanceof HttpTileError) {
    return {
      systemic:
        isSessionFatalStatus(error.status) ||
        error.status === 429 ||
        error.status >= 500,
      status: error.status,
      ...(error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: error.retryAfterMs }),
      ...(isSessionFatalStatus(error.status) ? { retryable: false } : {}),
      ...(error.status === 404 ? { retryable: false } : {}),
    };
  }
  return { systemic: error instanceof TypeError };
}

function failureResult(
  error: unknown,
  metadata = imageFailureMetadata(error),
): Extract<TileProviderResult<never>, { phase: "failure" }> {
  return {
    phase: "failure",
    reason: errorReason(error),
    ...(metadata.status === undefined ? {} : { status: metadata.status }),
    ...(metadata.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: metadata.retryAfterMs }),
    ...(metadata.retryable === undefined
      ? {}
      : { retryable: metadata.retryable }),
    ...(metadata.retryable === false
      ? { scope: metadata.systemic ? "provider" as const : "tile" as const }
      : {}),
  };
}

function elevationCacheStatus(
  status: ElevationCacheStatus,
): LoadedSource["cacheStatus"] {
  if (status === "hit") return "persistent-hit";
  if (status === "stored") return "persistent-write";
  if (status === "error") return "persistent-error";
  return "persistent-unavailable";
}

function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The tile image decode was aborted.", "AbortError");
  }
  const error = new Error("The tile image decode was aborted.");
  error.name = "AbortError";
  return error;
}

async function decodeBlobImage(
  blob: Blob,
  expectedPixels: number,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  if (signal.aborted) throw abortError();
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const cleanup = (): void => {
        signal.removeEventListener("abort", abort);
      };
      const abort = (): void => {
        cleanup();
        image.src = "";
        reject(abortError());
      };
      signal.addEventListener("abort", abort, { once: true });
      image.onload = (): void => {
        cleanup();
        if (
          image.naturalWidth !== expectedPixels ||
          image.naturalHeight !== expectedPixels
        ) {
          reject(
            new TileContentError(
              `Tile image is ${image.naturalWidth} × ${image.naturalHeight}; expected ${expectedPixels} × ${expectedPixels}.`,
            ),
          );
          return;
        }
        resolve(image);
      };
      image.onerror = (): void => {
        cleanup();
        reject(
          new TileContentError(
            "The tile response could not be decoded as an image.",
          ),
        );
      };
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Adapts real image loaders to the cancellable tile protocol. It
 * coalesces identical overzoomed source requests and retains decoded sources
 * so revisits can use the session memory cache.
 */
export class ImageTileProvider implements TileProvider<ImageTileResource> {
  readonly mode: ImageTileKind;
  readonly tilePixels: number;
  readonly attribution: string;
  private readonly sourceCache = new Map<string, LoadedSource>();
  private readonly sourceQueue: TileSourceLoadQueue<
    TileIdentity,
    SourceImageLoad
  >;
  private readonly listeners = new Set<
    (metrics: ImageTileProviderMetrics) => void
  >();
  private nextRequestId = 1;
  private requestTotal = 0;
  private memoryHitTotal = 0;
  private persistentHitTotal = 0;
  private persistentWriteTotal = 0;
  private mappingFailureTotal = 0;
  private byteTotal = 0;

  constructor(private readonly options: ImageTileProviderOptions) {
    this.mode = options.mode;
    this.tilePixels = options.tilePixels;
    this.attribution = options.attribution ?? "";
    this.sourceQueue = new TileSourceLoadQueue({
      concurrency: options.concurrency,
      ...(options.loadFromCache
        ? { loadFromCache: options.loadFromCache }
        : {}),
      loadFromNetwork: options.loadSource,
      classifyNetworkFailure: imageFailureMetadata,
      warmRamp: {},
    });
    this.sourceQueue.subscribe(() => this.emit());
  }

  get metrics(): ImageTileProviderMetrics {
    const queue = this.sourceQueue.metrics;
    return Object.freeze({
      requestTotal: this.requestTotal,
      sourceLoadTotal: queue.sourceLoadTotal,
      cacheLookupTotal: queue.cacheLookupTotal,
      cacheHitTotal: queue.cacheHitTotal,
      memoryHitTotal: this.memoryHitTotal,
      sharedRequestTotal: queue.sharedRequestTotal,
      persistentHitTotal: this.persistentHitTotal,
      persistentWriteTotal: this.persistentWriteTotal,
      failureTotal: this.mappingFailureTotal + queue.failureTotal,
      byteTotal: this.byteTotal,
      estimatedAssetReadyMs: queue.estimatedReadyMs,
      queued: queue.queued,
      networkDeferred: queue.networkDeferred,
      inFlight: queue.inFlight,
      warmRampActive: queue.warmRampActive,
      warmRampLimit: queue.warmRampLimit,
      decodedSourceCount: this.sourceCache.size,
      estimatedDecodedBytes:
        this.sourceCache.size * this.tilePixels * this.tilePixels * 4,
    });
  }

  get retryDiagnostics() {
    return this.sourceQueue.retryDiagnostics;
  }

  /** Shared rolling cache/network readiness estimate without allocating. */
  get estimatedAssetReadyMs(): number {
    return this.sourceQueue.estimatedReadyMs;
  }

  /** Retains decoded images only for the current view/transition working set. */
  retainSourceTiles(tiles: Iterable<TileIdentity>): void {
    const retained = new Set<string>();
    for (const tile of tiles) {
      try {
        retained.add(tileIdentityKey(this.options.resolveSource(tile).sourceTile));
      } catch {
        // A tile outside provider coverage has no decoded source to retain.
      }
    }
    let changed = false;
    for (const key of [...this.sourceCache.keys()]) {
      if (retained.has(key)) continue;
      this.sourceCache.delete(key);
      changed = true;
    }
    if (changed) this.emit();
  }

  updatePriority(tiles: Iterable<TileIdentity>): void {
    const priority: string[] = [];
    for (const tile of tiles) {
      try {
        priority.push(tileIdentityKey(
          this.options.resolveSource(tile).sourceTile,
        ));
      } catch {
        // Tiles outside provider coverage cannot contribute queued work.
      }
    }
    this.sourceQueue.updatePriority(priority);
  }

  /** Cache checks remain admitted; this gates only cache misses to network. */
  updateDemand(tiles: Iterable<TileIdentity>): void {
    const demanded: string[] = [];
    for (const tile of tiles) {
      try {
        demanded.push(tileIdentityKey(
          this.options.resolveSource(tile).sourceTile,
        ));
      } catch {
        // Tiles outside provider coverage cannot contribute network demand.
      }
    }
    this.sourceQueue.updateDemand(demanded);
  }

  /** Called by retry policy after its backoff window has elapsed. */
  resumeDeferred(): void {
    this.sourceQueue.resumeDeferred();
  }

  beginWarmRamp(): void {
    this.sourceQueue.beginWarmRamp();
  }

  subscribe(listener: (metrics: ImageTileProviderMetrics) => void): () => void {
    this.listeners.add(listener);
    listener(this.metrics);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.sourceQueue.dispose();
    this.sourceCache.clear();
    this.listeners.clear();
  }

  request(
    sourceTile: TileIdentity,
    observer: (result: TileProviderResult<ImageTileResource>) => void,
  ): TileRequestHandle {
    const requestId = this.nextRequestId++;
    const tile = immutableTile(sourceTile);
    this.requestTotal += 1;
    let mapping: SourceMapping;
    try {
      mapping = this.options.resolveSource(tile);
    } catch (error) {
      this.mappingFailureTotal += 1;
      queueMicrotask(() =>
        observer(failureResult(error, {
          systemic: false,
          retryable: false,
        })),
      );
      this.emit();
      return Object.freeze({ requestId, cancel() {} });
    }

    const key = tileIdentityKey(mapping.sourceTile);
    const cached = this.sourceCache.get(key);
    if (cached) {
      this.memoryHitTotal += 1;
      let active = true;
      queueMicrotask(() => {
        if (!active) return;
        observer({ phase: "in-flight" });
        observer({
          phase: "response",
          resource: this.resourceFor(tile, mapping, cached, "memory"),
        });
        active = false;
        this.emit();
      });
      this.emit();
      return Object.freeze({
        requestId,
        cancel: (): void => {
          active = false;
        },
      });
    }

    let active = true;
    const handle = this.sourceQueue.request({
      key,
      source: mapping.sourceTile,
      priority: tile.z,
    }, (event) => {
      if (!active) return;
      if (event.phase === "in-flight") {
        observer({ phase: "in-flight" });
        return;
      }
      active = false;
      if (event.phase === "failure") {
        observer(failureResult(event.error, event.metadata));
        return;
      }
      const loaded = this.loadedSource(key, event.value, event.readyDurationMs);
      observer({
        phase: "response",
        resource: this.resourceFor(
          tile,
          mapping,
          loaded,
          event.shared ? "shared" : loaded.cacheStatus,
        ),
      });
    });
    this.emit();
    return Object.freeze({
      requestId,
      cancel: (): void => {
        if (!active) return;
        active = false;
        handle.cancel();
      },
    });
  }

  private resourceFor(
    tile: TileIdentity,
    mapping: SourceMapping,
    source: LoadedSource,
    cacheStatus: ImageTileCacheStatus,
  ): ImageTileResource {
    return Object.freeze({
      kind: "image",
      mode: this.mode,
      tile,
      sourceTile: mapping.sourceTile,
      image: source.image,
      tilePixels: this.tilePixels,
      sourceScale: mapping.sourceScale,
      sourceOffsetX: mapping.sourceOffsetX,
      sourceOffsetY: mapping.sourceOffsetY,
      cacheStatus,
      loadDurationMs: source.loadDurationMs,
      byteLength: source.byteLength,
    });
  }

  private loadedSource(
    key: string,
    source: SourceImageLoad,
    loadDurationMs: number,
  ): LoadedSource {
    const existing = this.sourceCache.get(key);
    if (existing) return existing;
    const loaded: LoadedSource = Object.freeze({ ...source, loadDurationMs });
    this.sourceCache.set(key, loaded);
    this.byteTotal += source.byteLength;
    if (source.cacheStatus === "persistent-hit") this.persistentHitTotal += 1;
    if (source.cacheStatus === "persistent-write") {
      this.persistentWriteTotal += 1;
    }
    return loaded;
  }

  private emit(): void {
    const metrics = this.metrics;
    for (const listener of this.listeners) listener(metrics);
  }
}

async function decodeElevationSource(
  source: TileIdentity,
  payload: ElevationPayload,
  signal: AbortSignal,
): Promise<SourceImageLoad> {
  const blob = new Blob([payload.bytes], { type: payload.contentType });
  try {
    return {
      image: await decodeBlobImage(blob, ELEVATION_TILE_PIXELS, signal),
      byteLength: payload.bytes.byteLength,
      cacheStatus: elevationCacheStatus(payload.cacheStatus),
    };
  } catch (error) {
    if (!isAbortError(error)) await deleteCachedElevation(source);
    throw error;
  }
}

export function createElevationTileProvider(): ImageTileProvider {
  return new ImageTileProvider({
    mode: "terrain",
    tilePixels: ELEVATION_TILE_PIXELS,
    attribution: "Mapterhorn · Terrarium elevation tiles",
    concurrency: 4,
    resolveSource: (tile) =>
      sourceMapping(tile, ancestorAtZoom(tile, ELEVATION_MAX_ZOOM)),
    loadFromCache: async (source, signal) => {
      const payload = await lookupCachedElevation(source, signal);
      if (!payload) return undefined;
      return decodeElevationSource(source, payload, signal);
    },
    loadSource: async (source, signal) => {
      const payload = await loadElevationFromNetwork(source, signal);
      if (payload.status < 200 || payload.status >= 300) {
        throw new HttpTileError(
          payload.status,
          `Elevation tile ${tileIdentityKey(source)} failed with ${payload.status}.`,
          payload.retryAfterMs,
        );
      }
      return decodeElevationSource(source, payload, signal);
    },
  });
}
