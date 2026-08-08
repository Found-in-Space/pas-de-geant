import {
  deleteCachedElevation,
  loadCachedElevation,
  type ElevationCacheStatus,
} from "./elevation-cache.js";
import type { ImageryProvider } from "./imagery-provider.js";
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
  TileRequestCircuit,
  type TileRequestFailureMetadata,
} from "./tile-request-circuit.js";

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
  readonly memoryHitTotal: number;
  readonly sharedRequestTotal: number;
  readonly persistentHitTotal: number;
  readonly persistentWriteTotal: number;
  readonly failureTotal: number;
  readonly byteTotal: number;
  readonly averageLoadMs: number;
  readonly queued: number;
  readonly inFlight: number;
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
  loadSource(
    sourceTile: TileIdentity,
    signal: AbortSignal,
  ): Promise<SourceImageLoad>;
}

interface Consumer {
  readonly requestId: number;
  readonly tile: TileIdentity;
  readonly mapping: SourceMapping;
  readonly observer: (result: TileProviderResult<ImageTileResource>) => void;
  active: boolean;
}

interface SourceJob {
  readonly key: string;
  readonly sourceTile: TileIdentity;
  readonly consumers: Set<number>;
  priorityZoom: number;
  state: "queued" | "in-flight";
  hot: boolean;
  controller?: AbortController;
  probe?: boolean;
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
    };
  }
  return { systemic: error instanceof TypeError };
}

function failureResult(
  error: unknown,
): Extract<TileProviderResult<never>, { phase: "failure" }> {
  return {
    phase: "failure",
    reason: errorReason(error),
    ...(error instanceof HttpTileError ? { status: error.status } : {}),
    ...(error instanceof HttpTileError && error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
    ...(error instanceof HttpTileError && isSessionFatalStatus(error.status)
      ? { retryable: false }
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
            new Error(
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
          new Error("The tile response could not be decoded as an image."),
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
  private readonly jobs = new Map<string, SourceJob>();
  private readonly queue: SourceJob[] = [];
  private readonly consumers = new Map<number, Consumer>();
  private prioritySourceKeys = new Set<string>();
  private readonly listeners = new Set<
    (metrics: ImageTileProviderMetrics) => void
  >();
  private nextRequestId = 1;
  private activeJobCount = 0;
  private requestTotal = 0;
  private sourceLoadTotal = 0;
  private successfulLoadTotal = 0;
  private memoryHitTotal = 0;
  private sharedRequestTotal = 0;
  private persistentHitTotal = 0;
  private persistentWriteTotal = 0;
  private failureTotal = 0;
  private byteTotal = 0;
  private loadDurationTotalMs = 0;
  private readonly circuit = new TileRequestCircuit();
  private lastCircuitError: unknown;

  constructor(private readonly options: ImageTileProviderOptions) {
    this.mode = options.mode;
    this.tilePixels = options.tilePixels;
    this.attribution = options.attribution ?? "";
  }

  get metrics(): ImageTileProviderMetrics {
    return Object.freeze({
      requestTotal: this.requestTotal,
      sourceLoadTotal: this.sourceLoadTotal,
      memoryHitTotal: this.memoryHitTotal,
      sharedRequestTotal: this.sharedRequestTotal,
      persistentHitTotal: this.persistentHitTotal,
      persistentWriteTotal: this.persistentWriteTotal,
      failureTotal: this.failureTotal,
      byteTotal: this.byteTotal,
      averageLoadMs:
        this.successfulLoadTotal === 0
          ? 0
          : this.loadDurationTotalMs / this.successfulLoadTotal,
      queued: this.queue.length,
      inFlight: this.activeJobCount,
      decodedSourceCount: this.sourceCache.size,
      estimatedDecodedBytes:
        this.sourceCache.size * this.tilePixels * this.tilePixels * 4,
    });
  }

  get retryDiagnostics() {
    return this.circuit.diagnostics;
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
    const priority = new Set<string>();
    for (const tile of tiles) {
      try {
        priority.add(tileIdentityKey(this.options.resolveSource(tile).sourceTile));
      } catch {
        // Tiles outside provider coverage cannot contribute queued work.
      }
    }
    this.prioritySourceKeys = priority;
    for (const job of this.jobs.values()) job.hot = priority.has(job.key);
  }

  subscribe(listener: (metrics: ImageTileProviderMetrics) => void): () => void {
    this.listeners.add(listener);
    listener(this.metrics);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const job of this.jobs.values()) job.controller?.abort();
    this.jobs.clear();
    this.queue.splice(0);
    this.consumers.clear();
    this.sourceCache.clear();
    this.listeners.clear();
    this.activeJobCount = 0;
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
      this.failureTotal += 1;
      queueMicrotask(() =>
        observer({ phase: "failure", reason: errorReason(error) }),
      );
      this.emit();
      return Object.freeze({ requestId, cancel() {} });
    }

    const consumer: Consumer = {
      requestId,
      tile,
      mapping,
      observer,
      active: true,
    };
    this.consumers.set(requestId, consumer);
    const key = tileIdentityKey(mapping.sourceTile);
    const cached = this.sourceCache.get(key);
    if (cached) {
      this.memoryHitTotal += 1;
      queueMicrotask(() => {
        const active = this.consumers.get(requestId);
        if (!active?.active) return;
        active.observer({ phase: "in-flight" });
        active.observer({
          phase: "response",
          resource: this.resourceFor(active, cached, "memory"),
        });
        this.consumers.delete(requestId);
        this.emit();
      });
    } else {
      const existing = this.jobs.get(key);
      if (existing) {
        existing.consumers.add(requestId);
        existing.priorityZoom = Math.max(existing.priorityZoom, tile.z);
        this.sharedRequestTotal += 1;
        if (existing.state === "in-flight") {
          queueMicrotask(() => {
            if (this.consumers.get(requestId)?.active) {
              observer({ phase: "in-flight" });
            }
          });
        }
      } else {
        const job: SourceJob = {
          key,
          sourceTile: mapping.sourceTile,
          consumers: new Set([requestId]),
          priorityZoom: tile.z,
          state: "queued",
          hot: this.prioritySourceKeys.has(key),
        };
        this.jobs.set(key, job);
        this.queue.push(job);
        queueMicrotask(() => this.pump());
      }
    }
    this.emit();

    return Object.freeze({
      requestId,
      cancel: (): void => this.cancel(requestId),
    });
  }

  private cancel(requestId: number): void {
    const consumer = this.consumers.get(requestId);
    if (!consumer) return;
    consumer.active = false;
    this.consumers.delete(requestId);
    const key = tileIdentityKey(consumer.mapping.sourceTile);
    const job = this.jobs.get(key);
    job?.consumers.delete(requestId);
    if (job && job.consumers.size === 0) {
      this.jobs.delete(key);
      if (job.state === "in-flight") {
        this.circuit.recordCancellation(job.probe === true);
        this.activeJobCount = Math.max(0, this.activeJobCount - 1);
        job.controller?.abort();
        this.pump();
      } else {
        const queueIndex = this.queue.indexOf(job);
        if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
      }
    }
    this.emit();
  }

  private pump(): void {
    if (
      this.activeJobCount >= this.options.concurrency ||
      this.queue.length === 0
    ) return;
    if (!this.circuit.mayStart()) {
      if (this.circuit.state === "disabled") {
        const error = this.lastCircuitError ?? new Error(
          "Tile image requests are disabled for this session.",
        );
        queueMicrotask(() => this.failQueued(error));
      }
      return;
    }
    this.queue.sort(
      (first, second) =>
        Number(second.hot) - Number(first.hot) ||
        second.priorityZoom - first.priorityZoom ||
        second.sourceTile.z - first.sourceTile.z,
    );
    while (this.activeJobCount < this.options.concurrency) {
      while (
        this.queue.length > 0 &&
        (!this.jobs.has(this.queue[0]!.key) ||
          this.queue[0]!.consumers.size === 0)
      ) this.queue.shift();
      if (this.queue.length === 0) return;
      const start = this.circuit.tryStart();
      if (!start) return;
      const job = this.queue.shift();
      if (!job) return;
      if (this.jobs.get(job.key) !== job || job.consumers.size === 0) continue;
      job.state = "in-flight";
      job.probe = start === "probe";
      job.controller = new AbortController();
      this.activeJobCount += 1;
      this.sourceLoadTotal += 1;
      for (const requestId of job.consumers) {
        this.consumers.get(requestId)?.observer({ phase: "in-flight" });
      }
      const startedAt = performance.now();
      void this.options.loadSource(job.sourceTile, job.controller.signal).then(
        (source) => this.complete(job, source, performance.now() - startedAt),
        (error: unknown) => {
          if (this.jobs.get(job.key) !== job) return;
          // Elevation 404 is a successful no-data probe at the surface layer.
          // It must restore concurrency just like a decoded elevation tile.
          let tripped = false;
          if (error instanceof HttpTileError && error.status === 404) {
            this.circuit.recordSuccess(job.probe === true);
          } else {
            tripped = this.circuit.recordFailure(
              imageFailureMetadata(error),
              job.probe === true,
            );
          }
          if (tripped) this.lastCircuitError = error;
          if (tripped) this.failQueued(error);
          this.fail(job, error);
        },
      );
    }
    this.emit();
  }

  private complete(
    job: SourceJob,
    source: SourceImageLoad,
    loadDurationMs: number,
  ): void {
    if (this.jobs.get(job.key) !== job) return;
    this.circuit.recordSuccess(job.probe === true);
    const loaded: LoadedSource = Object.freeze({
      ...source,
      loadDurationMs,
    });
    this.sourceCache.set(job.key, loaded);
    this.byteTotal += source.byteLength;
    this.loadDurationTotalMs += loadDurationMs;
    this.successfulLoadTotal += 1;
    if (source.cacheStatus === "persistent-hit") this.persistentHitTotal += 1;
    if (source.cacheStatus === "persistent-write")
      this.persistentWriteTotal += 1;
    for (const requestId of job.consumers) {
      const consumer = this.consumers.get(requestId);
      if (!consumer?.active) continue;
      consumer.observer({
        phase: "response",
        resource: this.resourceFor(
          consumer,
          loaded,
          job.consumers.size > 1 ? "shared" : loaded.cacheStatus,
        ),
      });
      this.consumers.delete(requestId);
    }
    this.finish(job);
  }

  private fail(job: SourceJob, error: unknown): void {
    if (this.jobs.get(job.key) !== job) return;
    if (!isAbortError(error) || job.consumers.size > 0) {
      this.failureTotal += 1;
      for (const requestId of job.consumers) {
        const consumer = this.consumers.get(requestId);
        if (!consumer?.active) continue;
        consumer.observer({
          ...failureResult(error),
        });
        this.consumers.delete(requestId);
      }
    }
    this.finish(job);
  }

  /** A provider-wide failure must not drain pending work into the outage. */
  private failQueued(error: unknown): void {
    const queued = this.queue.splice(0);
    for (const job of queued) {
      if (this.jobs.get(job.key) !== job) continue;
      this.jobs.delete(job.key);
      this.failureTotal += 1;
      for (const requestId of job.consumers) {
        const consumer = this.consumers.get(requestId);
        if (!consumer?.active) continue;
        consumer.observer(failureResult(error));
        this.consumers.delete(requestId);
      }
    }
    if (queued.length > 0) this.emit();
  }

  private finish(job: SourceJob): void {
    this.jobs.delete(job.key);
    this.activeJobCount = Math.max(0, this.activeJobCount - 1);
    this.emit();
    this.pump();
  }

  private resourceFor(
    consumer: Consumer,
    source: LoadedSource,
    cacheStatus: ImageTileCacheStatus,
  ): ImageTileResource {
    return Object.freeze({
      kind: "image",
      mode: this.mode,
      tile: consumer.tile,
      sourceTile: consumer.mapping.sourceTile,
      image: source.image,
      tilePixels: this.tilePixels,
      sourceScale: consumer.mapping.sourceScale,
      sourceOffsetX: consumer.mapping.sourceOffsetX,
      sourceOffsetY: consumer.mapping.sourceOffsetY,
      cacheStatus,
      loadDurationMs: source.loadDurationMs,
      byteLength: source.byteLength,
    });
  }

  private emit(): void {
    const metrics = this.metrics;
    for (const listener of this.listeners) listener(metrics);
  }
}

export function createImageryTileProvider(
  provider: ImageryProvider,
): ImageTileProvider {
  return new ImageTileProvider({
    mode: "imagery",
    tilePixels: provider.tileSize,
    attribution: provider.attribution,
    concurrency: 6,
    resolveSource: (tile) => {
      if (tile.z < provider.minZoom) {
        throw new Error(
          `Imagery begins at z${provider.minZoom}; ${tileIdentityKey(tile)} has no single source tile.`,
        );
      }
      const source = ancestorAtZoom(tile, provider.maxZoom);
      return sourceMapping(tile, source);
    },
    loadSource: async (source, signal) => {
      const blob = await provider.load(source, signal);
      return {
        image: await decodeBlobImage(blob, provider.tileSize, signal),
        byteLength: blob.size,
        cacheStatus: "provider",
      };
    },
  });
}

export function createElevationTileProvider(): ImageTileProvider {
  return new ImageTileProvider({
    mode: "terrain",
    tilePixels: ELEVATION_TILE_PIXELS,
    attribution: "Mapterhorn · Terrarium elevation tiles",
    concurrency: 4,
    resolveSource: (tile) =>
      sourceMapping(tile, ancestorAtZoom(tile, ELEVATION_MAX_ZOOM)),
    loadSource: async (source, signal) => {
      const payload = await loadCachedElevation(source, signal);
      if (payload.status < 200 || payload.status >= 300) {
        throw new HttpTileError(
          payload.status,
          `Elevation tile ${tileIdentityKey(source)} failed with ${payload.status}.`,
          payload.retryAfterMs,
        );
      }
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
    },
  });
}
