import {
  deleteCachedElevation,
  loadElevationFromNetwork,
  lookupCachedElevation,
  type ElevationCacheOptions,
  type ElevationCacheStorage,
  type ElevationCacheStatus,
  type ElevationPayload,
} from "./elevation-cache.js";
import { availableElevationAncestor, type ElevationAvailability } from "./elevation-availability.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "./tile-provider.js";
import type { TileAddressing } from "./tile-url.js";
import {
  isSessionFatalStatus,
  type TileRequestFailureMetadata,
} from "./tile-request-circuit.js";
import { TileSourceLoadQueue } from "./tile-source-load-queue.js";
import {
  elevationSourceZoomForTile,
  type ElevationSourceConstraints,
} from "./terrain-lod.js";

export type ImageTileKind = "imagery" | "terrain";
export interface ElevationProviderMetadata extends ElevationSourceConstraints {
  readonly attribution: string;
  /** Conservative decoded elevation range for rendering and resource admission. */
  readonly elevationBoundsMetres?: {
    readonly minimum: number;
    readonly maximum: number;
  };
}

export interface XyzElevationConfiguration {
  readonly urlTemplate: string;
  readonly addressing?: TileAddressing;
  readonly headers?: Readonly<Record<string, string>>;
  readonly availability?: ElevationAvailability;
  readonly cacheStorage?: ElevationCacheStorage | null;
  readonly fetcher?: typeof fetch;
}

export const MAPTERHORN_ELEVATION_PROVIDER_METADATA:
  ElevationProviderMetadata = Object.freeze({
    tilePixels: 512,
    maxSourceZoom: 12,
    attribution: "Mapterhorn · Terrarium elevation tiles",
    elevationBoundsMetres: Object.freeze({
      minimum: -32_768,
      maximum: 32_767 + 255 / 256,
    }),
  });

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
  readonly queued: number;
  readonly networkDeferred: number;
  readonly processingQueued: number;
  readonly inFlight: number;
  readonly acquisitionActive: number;
  readonly processingActive: number;
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

export interface ImageTileProviderOptions<TPayload = SourceImageLoad> {
  readonly mode: ImageTileKind;
  readonly tilePixels: number;
  readonly attribution?: string;
  readonly processingConcurrency: number;
  resolveSource(tile: TileIdentity): SourceMapping;
  /** Optional persistent-cache phase; undefined is a cache miss. */
  loadFromCache?(
    sourceTile: TileIdentity,
    signal: AbortSignal,
  ): Promise<TPayload | undefined>;
  /** Provider/network phase. It is called only after cache lookup and admission. */
  loadSource(
    sourceTile: TileIdentity,
    signal: AbortSignal,
  ): Promise<TPayload>;
  /** Converts an acquired payload into a decoded source under bounded admission. */
  processSource?(
    sourceTile: TileIdentity,
    payload: TPayload,
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

export function elevationSourceMapping(
  tile: TileIdentity,
  maxElevationSourceZoom: number,
  availability?: ElevationAvailability,
): SourceMapping {
  return sourceMapping(
    tile,
    availableElevationAncestor(tile, elevationSourceZoomForTile(tile, maxElevationSourceZoom), availability),
  );
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
 * Adapts real image loaders to the cancellable tile protocol. It coalesces
 * identical overzoomed source requests while retaining decoded sources only
 * for the renderer's current working set.
 */
export class ImageTileProvider<TPayload = SourceImageLoad>
  implements TileProvider<ImageTileResource>
{
  readonly mode: ImageTileKind;
  readonly tilePixels: number;
  readonly attribution: string;
  private readonly sourceCache = new Map<string, LoadedSource>();
  private readonly sourceQueue: TileSourceLoadQueue<
    TileIdentity,
    SourceImageLoad,
    TPayload
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

  constructor(private readonly options: ImageTileProviderOptions<TPayload>) {
    this.mode = options.mode;
    this.tilePixels = options.tilePixels;
    this.attribution = options.attribution ?? "";
    this.sourceQueue = new TileSourceLoadQueue({
      // Legacy/custom loaders that already return decoded values still need
      // their combined work bounded. Staged production loaders leave encoded
      // acquisition uncapped and bound only processSource.
      ...(options.processSource
        ? {
            processingConcurrency: options.processingConcurrency,
            process: options.processSource,
          }
        : { loadConcurrency: options.processingConcurrency }),
      ...(options.loadFromCache
        ? { loadFromCache: options.loadFromCache }
        : {}),
      loadFromNetwork: options.loadSource,
      classifyNetworkFailure: imageFailureMetadata,
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
      queued: queue.queued,
      networkDeferred: queue.networkDeferred,
      processingQueued: queue.processingQueued,
      inFlight: queue.inFlight,
      acquisitionActive: queue.acquisitionActive,
      processingActive: queue.processingActive,
      decodedSourceCount: this.sourceCache.size,
      estimatedDecodedBytes:
        this.sourceCache.size * this.tilePixels * this.tilePixels * 4,
    });
  }

  get retryDiagnostics() {
    return this.sourceQueue.retryDiagnostics;
  }

  /** Retains decoded images for the planner-and-horizon working set. */
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

  /** Called by retry policy after its backoff window has elapsed. */
  resumeDeferred(): void {
    this.sourceQueue.resumeDeferred();
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
  expectedPixels: number,
  options: ElevationCacheOptions = {},
): Promise<SourceImageLoad> {
  const blob = new Blob([payload.bytes], { type: payload.contentType });
  try {
    return {
      image: await decodeBlobImage(blob, expectedPixels, signal),
      byteLength: payload.bytes.byteLength,
      cacheStatus: elevationCacheStatus(payload.cacheStatus),
    };
  } catch (error) {
    if (!isAbortError(error)) await deleteCachedElevation(source, options);
    throw error;
  }
}

export function createElevationTileProvider(
  metadata: ElevationProviderMetadata,
  maxElevationSourceZoom: number,
  options: ElevationCacheOptions & { readonly availability?: ElevationAvailability } = {},
): ImageTileProvider<ElevationPayload> {
  return new ImageTileProvider({
    mode: "terrain",
    tilePixels: metadata.tilePixels,
    attribution: metadata.attribution,
    processingConcurrency: 4,
    resolveSource: (tile) =>
      elevationSourceMapping(tile, maxElevationSourceZoom, options.availability),
    loadFromCache: async (source, signal) => {
      return await lookupCachedElevation(source, signal, options.cacheStorage, true, options.urlTemplate, options.addressing);
    },
    loadSource: async (source, signal) => {
      const payload = await loadElevationFromNetwork(source, signal, options);
      if (payload.status < 200 || payload.status >= 300) {
        throw new HttpTileError(
          payload.status,
          `Elevation tile ${tileIdentityKey(source)} failed with ${payload.status}.`,
          payload.retryAfterMs,
        );
      }
      return payload;
    },
    processSource: async (source, payload, signal) =>
      await decodeElevationSource(
        source,
        payload,
        signal,
        metadata.tilePixels,
        options,
      ),
  });
}

/** Provider-neutral XYZ height source used by preprocessed planetary datasets. */
export function createXyzElevationTileProvider(
  metadata: ElevationProviderMetadata,
  maxElevationSourceZoom: number,
  configuration: XyzElevationConfiguration,
): ImageTileProvider<ElevationPayload> {
  const fetcher = configuration.fetcher ?? fetch;
  return createElevationTileProvider(metadata, maxElevationSourceZoom, {
    urlTemplate: configuration.urlTemplate,
    addressing: configuration.addressing,
    availability: configuration.availability,
    cacheStorage: configuration.cacheStorage,
    fetcher: configuration.headers ? (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(configuration.headers!)) headers.set(name, value);
      return fetcher(input, { ...init, headers });
    } : fetcher,
  });
}
