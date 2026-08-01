import * as THREE from "three";
import {
  IMAGERY_PAGE_TABLE_SIZE,
  WEB_MERCATOR_MAX_LATITUDE,
  ancestorAtZoom,
  imageryKey,
  mercatorPointForImagery,
  resolvePageEntry,
  selectImageryZoom,
  wrapImageryX,
  wrapImageryPageX,
  type ImageryAddress,
  type ImageryView,
} from "./imagery-core.js";
import type {
  ImageryDecoderCommand,
  ImageryDecoderMessage,
} from "./imagery-decoder-protocol.js";
import {
  ImageryRequestError,
  type ImageryProvider,
} from "./imagery-provider.js";
import { normalizeTileTarget, type TileTarget } from "./tile-layout-source.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "./tile-provider.js";
import type { SchedulerSnapshot } from "./tile-transition-scheduler.js";
import { tileIdentityKey, type TileIdentity } from "./tile-transition-planner.js";
import { TileWorkerScheduler } from "./tile-worker-scheduler.js";

export {
  configuredXyzImageryProvider,
  ImageryRequestError,
  XyzImageryProvider,
  type ImageryProvider,
  type XyzImageryConfiguration,
} from "./imagery-provider.js";
export { normalizedMercatorYForLatitude } from "./imagery-core.js";

const IMAGERY_GUTTER_PIXELS = 8;
const MAX_CONCURRENT_REQUESTS = 6;
const MAX_UPLOADS_PER_FRAME = 2;

export function stitchImageryGutter(
  pixels: Uint8Array,
  tileSize: number,
  gutter: number,
  destinationLayer: number,
  sourceLayer: number,
  offsetX: -1 | 0 | 1,
  offsetY: -1 | 0 | 1,
): void {
  const paddedSize = tileSize + gutter * 2;
  const layerBytes = paddedSize * paddedSize * 4;
  const copyWidth = offsetX === 0 ? tileSize : gutter;
  const copyHeight = offsetY === 0 ? tileSize : gutter;
  const destinationX = offsetX < 0 ? 0 : offsetX > 0 ? gutter + tileSize : gutter;
  const destinationY = offsetY < 0 ? 0 : offsetY > 0 ? gutter + tileSize : gutter;
  const sourceX = offsetX < 0 ? tileSize : offsetX > 0 ? gutter : gutter;
  const sourceY = offsetY < 0 ? tileSize : offsetY > 0 ? gutter : gutter;
  for (let row = 0; row < copyHeight; row += 1) {
    const sourceOffset =
      sourceLayer * layerBytes + ((sourceY + row) * paddedSize + sourceX) * 4;
    const destinationOffset =
      destinationLayer * layerBytes +
      ((destinationY + row) * paddedSize + destinationX) * 4;
    pixels.set(
      pixels.subarray(sourceOffset, sourceOffset + copyWidth * 4),
      destinationOffset,
    );
  }
}

export interface ImageryCoordinateBounds {
  readonly west: number;
  readonly east: number;
  readonly north: number;
  readonly south: number;
}

export function imageryBoundsForGeographicBounds(bounds: {
  west: number;
  east: number;
  north: number;
  south: number;
}): ImageryCoordinateBounds {
  const north = mercatorPointForImagery(bounds.north, bounds.west, 0);
  const south = mercatorPointForImagery(bounds.south, bounds.east, 0);
  return {
    west: (bounds.west + 180) / 360,
    east: (bounds.east + 180) / 360,
    north: north.y,
    south: south.y,
  };
}

export const IMAGERY_FRAGMENT_DECLARATIONS = `
  uniform sampler2D blueMarbleMap;
  uniform sampler2D imageryPageTable;
  uniform highp sampler2DArray imageryTilePool;
  uniform float imageryEnabled;
  uniform vec2 imageryPageTableSize;
  uniform vec3 imageryPoolLayout;
  uniform vec4 imageryCoordOriginScale;
  uniform vec2 imageryWrapX;
  in vec2 vBlueMarbleUv;
  in vec2 vImageryUv;

  vec2 wrappedImageryPageCoordinate() {
    vec2 pageCoordinate =
      imageryCoordOriginScale.xy +
      vImageryUv * imageryCoordOriginScale.zw;
    pageCoordinate.x +=
      floor((imageryWrapX.y - pageCoordinate.x) / imageryWrapX.x + 0.5) *
      imageryWrapX.x;
    return pageCoordinate;
  }

  vec3 resolvedImageryAlbedo() {
    if (imageryEnabled < 0.5) return texture(blueMarbleMap, vBlueMarbleUv).rgb;
    vec2 pageCoordinate = wrappedImageryPageCoordinate();
    vec2 pageCell = floor(pageCoordinate);
    if (
      pageCell.x < 0.0 || pageCell.y < 0.0 ||
      pageCell.x >= imageryPageTableSize.x ||
      pageCell.y >= imageryPageTableSize.y
    ) return texture(blueMarbleMap, vBlueMarbleUv).rgb;
    vec4 encoded = texture(
      imageryPageTable,
      (pageCell + 0.5) / imageryPageTableSize
    );
    if (encoded.r < 0.5) return texture(blueMarbleMap, vBlueMarbleUv).rgb;
    vec2 sourceUv = (encoded.ba + fract(pageCoordinate)) / encoded.g;
    float tileSize = imageryPoolLayout.x;
    float gutter = imageryPoolLayout.y;
    float paddedSize = imageryPoolLayout.z;
    vec2 poolUv = (vec2(gutter) + sourceUv * tileSize) / paddedSize;
    vec2 pageDx = dFdx(vImageryUv * imageryCoordOriginScale.zw);
    vec2 pageDy = dFdy(vImageryUv * imageryCoordOriginScale.zw);
    vec2 poolDx = pageDx * tileSize / (encoded.g * paddedSize);
    vec2 poolDy = pageDy * tileSize / (encoded.g * paddedSize);
    float footprint = max(length(poolDx), length(poolDy)) * paddedSize;
    float supportedFootprint = max(1.0, gutter * 2.0);
    float gradientScale =
      min(1.0, supportedFootprint / max(footprint, 0.000001));
    return textureGrad(
      imageryTilePool,
      vec3(poolUv, encoded.r - 1.0),
      poolDx * gradientScale,
      poolDy * gradientScale
    ).rgb;
  }

  vec4 resolvedImageryTileOverlay() {
    if (imageryEnabled < 0.5) return vec4(0.0);
    vec2 pageCoordinate = wrappedImageryPageCoordinate();
    vec2 pageCell = floor(pageCoordinate);
    if (
      pageCell.x < 0.0 || pageCell.y < 0.0 ||
      pageCell.x >= imageryPageTableSize.x ||
      pageCell.y >= imageryPageTableSize.y
    ) return vec4(0.0);
    vec4 encoded = texture(
      imageryPageTable,
      (pageCell + 0.5) / imageryPageTableSize
    );
    if (encoded.r < 0.5) return vec4(0.0);
    vec2 tileUv = (encoded.ba + fract(pageCoordinate)) / encoded.g;
    vec2 edge = min(tileUv, 1.0 - tileUv);
    float distanceToEdge = min(edge.x, edge.y);
    float line = 1.0 - smoothstep(
      0.0,
      max(0.0005, fwidth(distanceToEdge) * 2.5),
      distanceToEdge
    );
    vec3 colour = encoded.g < 1.5
      ? vec3(0.0, 0.843, 1.0)
      : vec3(1.0, 0.741, 0.247);
    return vec4(colour, mix(0.18, 0.92, line));
  }
`;

export interface ImageryTileResource {
  readonly kind: "imagery";
  readonly tile: TileIdentity;
  readonly sourceTile?: TileIdentity;
  readonly pixels?: Uint8Array;
}

interface Request {
  readonly id: number;
  readonly tile: TileIdentity;
  readonly observer: (result: TileProviderResult<ImageryTileResource>) => void;
  readonly sourceKey: string;
  active: boolean;
}

interface SourceResult {
  readonly sourceTile?: TileIdentity;
  readonly pixels?: Uint8Array;
}

interface SourceJob {
  readonly key: string;
  readonly sourceTile: TileIdentity;
  readonly consumers: Set<number>;
  state: "queued" | "active";
  controller?: AbortController;
}

/** Scheduler provider whose 404s resolve as no-data and whose other errors retry. */
export class ScheduledImageryProvider
  implements TileProvider<ImageryTileResource>
{
  private nextId = 1;
  private activeJobCount = 0;
  private readonly requests = new Map<number, Request>();
  private readonly jobs = new Map<string, SourceJob>();
  private readonly queuedJobs: SourceJob[] = [];
  private disposed = false;

  constructor(
    readonly source: ImageryProvider,
    private readonly decode: (
      blob: Blob,
      tileSize: number,
      signal: AbortSignal,
    ) => Promise<Uint8Array> = async (blob) =>
      new Uint8Array(await blob.arrayBuffer()),
  ) {}

  request(
    tile: TileIdentity,
    observer: (result: TileProviderResult<ImageryTileResource>) => void,
  ): TileRequestHandle {
    const sourceTile = ancestorAtZoom(tile, this.source.maxZoom);
    const sourceKey = imageryKey(sourceTile);
    const request: Request = {
      id: this.nextId++,
      tile: Object.freeze({ ...tile }),
      observer,
      sourceKey,
      active: true,
    };
    this.requests.set(request.id, request);
    let job = this.jobs.get(sourceKey);
    if (!job) {
      job = {
        key: sourceKey,
        sourceTile,
        consumers: new Set(),
        state: "queued",
      };
      this.jobs.set(sourceKey, job);
      this.queuedJobs.push(job);
    }
    job.consumers.add(request.id);
    this.pumpJobs();
    return {
      requestId: request.id,
      cancel: () => this.cancelRequest(request.id),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of this.requests.values()) {
      request.active = false;
    }
    for (const job of this.jobs.values()) job.controller?.abort();
    this.requests.clear();
    this.queuedJobs.length = 0;
    this.jobs.clear();
  }

  private cancelRequest(requestId: number): void {
    const request = this.requests.get(requestId);
    if (!request?.active) return;
    request.active = false;
    this.requests.delete(requestId);
    const job = this.jobs.get(request.sourceKey);
    if (!job) return;
    job.consumers.delete(requestId);
    if (job.consumers.size > 0) return;
    this.jobs.delete(job.key);
    if (job.state === "queued") {
      const index = this.queuedJobs.indexOf(job);
      if (index >= 0) this.queuedJobs.splice(index, 1);
    } else {
      job.controller?.abort();
    }
  }

  private pumpJobs(): void {
    while (this.activeJobCount < MAX_CONCURRENT_REQUESTS) {
      const job = this.queuedJobs.shift();
      if (!job) return;
      if (!this.jobs.has(job.key) || job.consumers.size === 0) continue;
      job.state = "active";
      job.controller = new AbortController();
      this.activeJobCount += 1;
      for (const requestId of job.consumers) {
        this.requests.get(requestId)?.observer({ phase: "in-flight" });
      }
      void this.loadSource(job.sourceTile, job.controller.signal)
        .then(
          (result) => this.completeJob(job, result),
          (error: unknown) => this.failJob(job, error),
        )
        .finally(() => {
          this.activeJobCount -= 1;
          this.pumpJobs();
        });
    }
  }

  private completeJob(job: SourceJob, result: SourceResult): void {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    for (const requestId of job.consumers) {
      const request = this.requests.get(requestId);
      if (!request?.active) continue;
      request.active = false;
      this.requests.delete(requestId);
      request.observer({
        phase: "response",
        resource: Object.freeze({
          kind: "imagery",
          tile: request.tile,
          ...(result.sourceTile ? { sourceTile: result.sourceTile } : {}),
          ...(result.pixels ? { pixels: result.pixels } : {}),
        }),
      });
    }
  }

  private failJob(job: SourceJob, error: unknown): void {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    for (const requestId of job.consumers) {
      const request = this.requests.get(requestId);
      if (!request?.active) continue;
      request.active = false;
      this.requests.delete(requestId);
      request.observer({
        phase: "failure",
        reason:
          error instanceof Error ? error.message : "Imagery request failed.",
        ...(error instanceof ImageryRequestError && error.status
          ? { status: error.status }
          : {}),
      });
    }
  }

  private async loadSource(
    initial: TileIdentity,
    signal: AbortSignal,
  ): Promise<SourceResult> {
    let sourceTile = initial;
    while (sourceTile.z >= this.source.minZoom) {
      try {
        const blob = await this.source.load(sourceTile, signal);
        const pixels = await this.decode(blob, this.source.tileSize, signal);
        return {
          sourceTile: Object.freeze({ ...sourceTile }),
          pixels,
        };
      } catch (error) {
        if (!(error instanceof ImageryRequestError) || error.kind !== "not-found") {
          throw error;
        }
        if (sourceTile.z === this.source.minZoom) return {};
        sourceTile = ancestorAtZoom(sourceTile, sourceTile.z - 1);
      }
    }
    return {};
  }
}

interface DecoderWorker {
  postMessage(message: ImageryDecoderCommand): void;
  onmessage: ((event: MessageEvent<ImageryDecoderMessage>) => void) | null;
  terminate(): void;
}

class ImageryTileDecoder {
  private nextId = 1;
  private readonly worker: DecoderWorker;
  private readonly pending = new Map<
    number,
    {
      resolve(pixels: Uint8Array): void;
      reject(error: unknown): void;
      signal: AbortSignal;
      abort(): void;
    }
  >();

  constructor() {
    this.worker = new Worker(
      new URL("./imagery-decoder.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.requestId);
      if (!pending) return;
      this.pending.delete(data.requestId);
      pending.signal.removeEventListener("abort", pending.abort);
      if (data.kind === "decoded") pending.resolve(new Uint8Array(data.pixels));
      else pending.reject(new ImageryRequestError(data.reason, "malformed"));
    };
  }

  decode(
    blob: Blob,
    tileSize: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (signal.aborted) return Promise.reject(abortError());
    const requestId = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        if (!this.pending.delete(requestId)) return;
        this.worker.postMessage({ kind: "cancel", requestId });
        reject(abortError());
      };
      this.pending.set(requestId, { resolve, reject, signal, abort });
      signal.addEventListener("abort", abort, { once: true });
      this.worker.postMessage({
        kind: "decode",
        requestId,
        blob,
        tileSize,
        gutter: IMAGERY_GUTTER_PIXELS,
      });
    });
  }

  dispose(): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(new Error("Imagery decoder disposed."));
    }
    this.pending.clear();
  }
}

function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("Imagery decoding was aborted.", "AbortError");
  }
  const error = new Error("Imagery decoding was aborted.");
  error.name = "AbortError";
  return error;
}

interface PageRecord {
  readonly sourceTile: TileIdentity;
  state: "decoded" | "resident" | "evicted";
  pixels?: Uint8Array;
  slot?: number;
  usedAt: number;
}

interface VisibleMapping {
  readonly zoom: number;
  readonly originX: number;
  readonly originY: number;
  readonly referenceX: number;
}

/** Exact planner-driven residency: active mapping plus staged replacement. */
export function imageryResidencyKeys(
  visibleSourceKeys: Iterable<string>,
  desiredSourceKeys: Iterable<string>,
): Set<string> {
  return new Set([...visibleSourceKeys, ...desiredSourceKeys]);
}

/** Prefer resident replacement imagery, otherwise retain prior coverage. */
export function preservingImagerySource(
  page: TileIdentity,
  desiredSource: TileIdentity | undefined,
  activeSources: readonly TileIdentity[],
): TileIdentity | undefined {
  return [
    ...activeSources.map((source) => ({ source, desired: false })),
    ...(desiredSource ? [{ source: desiredSource, desired: true }] : []),
  ]
    .filter(({ source }) => contains(source, page))
    .sort(
      (first, second) =>
        second.source.z - first.source.z ||
        Number(second.desired) - Number(first.desired),
    )[0]?.source;
}

function initialSnapshot(target: TileTarget): SchedulerSnapshot<TileTarget> {
  return {
    revision: -1,
    target,
    committedCut: [],
    requestedCut: [],
    graph: { retained: [], groups: [], batches: [] },
    requirements: [],
  };
}

/**
 * Independent imagery pipeline. The shared worker scheduler owns its cut and
 * transitions; this class owns only blob decoding, GPU residency and mapping.
 */
export class ImageryVirtualTexture {
  private readonly provider?: ScheduledImageryProvider;
  private readonly scheduler?: TileWorkerScheduler<ImageryTileResource>;
  private readonly decoder?: ImageryTileDecoder;
  private readonly pageTables: [THREE.DataTexture, THREE.DataTexture];
  private readonly sharedUniforms: Record<string, THREE.IUniform>;
  private readonly records = new Map<string, PageRecord>();
  private readonly freeSlots: number[] = [];
  private poolTexture: THREE.DataArrayTexture;
  private poolPixels: Uint8Array;
  private poolLayers = 1;
  private readonly tileSize: number;
  private readonly paddedSize: number;
  private readonly unsubscribe?: () => void;
  private snapshot: SchedulerSnapshot<TileTarget>;
  private target: TileTarget;
  private desiredZoom: number | undefined;
  private activePageTable = 0;
  private visible?: VisibleMapping;
  private readonly visibleSourceKeys = new Set<string>();
  private sequence = 0;
  private mappingDirty = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    blueMarble: THREE.Texture,
    imageryProvider?: ImageryProvider,
    initialView: ImageryView = {
      displayRadiusM: 1,
      latitudeDegrees: 0,
      longitudeDegrees: 0,
    },
  ) {
    const zoom = imageryProvider
      ? selectImageryZoom({
          ...initialView,
          minZoom: imageryProvider.minZoom,
          maxZoom: imageryProvider.maxZoom,
          tilePixels: imageryProvider.tileSize,
        })
      : 0;
    const point = mercatorPointForImagery(
      initialView.latitudeDegrees,
      initialView.longitudeDegrees,
      zoom,
    );
    this.target = normalizeTileTarget({
      z: zoom,
      x: Math.floor(point.x),
      y: Math.floor(point.y),
    });
    this.snapshot = initialSnapshot(this.target);
    this.pageTables = [this.createPageTable(), this.createPageTable()];
    this.tileSize = imageryProvider?.tileSize ?? 1;
    this.paddedSize = this.tileSize + IMAGERY_GUTTER_PIXELS * 2;
    this.poolPixels = new Uint8Array(
      this.paddedSize * this.paddedSize * 4,
    );
    this.poolTexture = this.createPoolTexture(this.poolPixels, 1);
    this.sharedUniforms = {
      blueMarbleMap: new THREE.Uniform(blueMarble),
      imageryPageTable: new THREE.Uniform(this.pageTables[0]),
      imageryTilePool: new THREE.Uniform(this.poolTexture),
      imageryEnabled: new THREE.Uniform(0),
      imageryPageTableSize: new THREE.Uniform(
        new THREE.Vector2(IMAGERY_PAGE_TABLE_SIZE, IMAGERY_PAGE_TABLE_SIZE),
      ),
      imageryPoolLayout: new THREE.Uniform(
        new THREE.Vector3(
          this.tileSize,
          IMAGERY_GUTTER_PIXELS,
          this.paddedSize,
        ),
      ),
    };
    renderer.initTexture(this.pageTables[0]);
    renderer.initTexture(this.pageTables[1]);
    renderer.initTexture(this.poolTexture);
    if (imageryProvider) {
      this.desiredZoom = zoom;
      this.decoder = new ImageryTileDecoder();
      this.provider = new ScheduledImageryProvider(
        imageryProvider,
        (blob, tileSize, signal) =>
          this.decoder!.decode(blob, tileSize, signal),
      );
      this.scheduler = new TileWorkerScheduler(this.target, {
        provider: this.provider,
        hydrateInitialResources: true,
        retryDelayMs: 5_000,
      });
      this.snapshot = this.scheduler.snapshot;
      this.unsubscribe = this.scheduler.subscribe((snapshot, event) => {
        this.snapshot = snapshot;
        if (event?.kind === "response" && event.tile) {
          this.stage(this.scheduler!.committedResource(event.tile));
        }
        if (!event || event.kind === "atomic-swap") {
          for (const tile of snapshot.committedCut) {
            this.stage(this.scheduler!.committedResource(tile));
          }
          this.mappingDirty = true;
        }
      });
    }
    for (
      let slot = 0;
      slot >= 0;
      slot -= 1
    ) {
      this.freeSlots.push(slot);
    }
  }

  materialUniforms(): Record<string, THREE.IUniform> {
    return {
      ...this.sharedUniforms,
      imageryCoordOriginScale: new THREE.Uniform(new THREE.Vector4()),
      imageryWrapX: new THREE.Uniform(new THREE.Vector2(1, 0)),
    };
  }

  configureMaterial(
    material: THREE.ShaderMaterial,
    bounds: ImageryCoordinateBounds,
  ): void {
    const transform = material.uniforms.imageryCoordOriginScale
      ?.value as THREE.Vector4 | undefined;
    const wrap = material.uniforms.imageryWrapX
      ?.value as THREE.Vector2 | undefined;
    if (!transform || !wrap || !this.visible) {
      transform?.set(0, 0, 0, 0);
      wrap?.set(1, 0);
      return;
    }
    const width = 2 ** this.visible.zoom;
    const west = wrapImageryPageX(
      bounds.west * width,
      this.visible.referenceX,
      width,
    );
    transform.set(
      west - this.visible.originX,
      bounds.north * width - this.visible.originY,
      (bounds.east - bounds.west) * width,
      (bounds.south - bounds.north) * width,
    );
    wrap.set(width, this.visible.referenceX - this.visible.originX);
  }

  update(view: ImageryView): void {
    if (!this.scheduler || !this.provider) return;
    const zoom = selectImageryZoom({
      ...view,
      minZoom: this.provider.source.minZoom,
      maxZoom: this.provider.source.maxZoom,
      tilePixels: this.provider.source.tileSize,
      previousZoom: this.desiredZoom,
    });
    const point = mercatorPointForImagery(
      view.latitudeDegrees,
      view.longitudeDegrees,
      zoom,
    );
    const target = normalizeTileTarget({
      z: zoom,
      x: Math.floor(point.x),
      y: Math.floor(point.y),
    });
    if (
      target.z !== this.target.z ||
      target.x !== this.target.x ||
      target.y !== this.target.y
    ) {
      this.target = target;
      this.scheduler.updateTarget(target);
    }
    this.desiredZoom = zoom;
    this.uploadDecoded();
    if (this.mappingDirty) this.commitMapping();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.scheduler?.dispose();
    this.provider?.dispose();
    this.decoder?.dispose();
    this.pageTables[0].dispose();
    this.pageTables[1].dispose();
    this.poolTexture.dispose();
    this.records.clear();
  }

  private createPageTable(): THREE.DataTexture {
    const texture = new THREE.DataTexture(
      new Float32Array(IMAGERY_PAGE_TABLE_SIZE ** 2 * 4),
      IMAGERY_PAGE_TABLE_SIZE,
      IMAGERY_PAGE_TABLE_SIZE,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private createPoolTexture(
    pixels: Uint8Array,
    layers: number,
  ): THREE.DataArrayTexture {
    const texture = new THREE.DataArrayTexture(
      pixels,
      this.paddedSize,
      this.paddedSize,
      layers,
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }

  private stage(resource: ImageryTileResource | undefined): void {
    if (!resource?.pixels || !resource.sourceTile) return;
    const key = imageryKey(resource.sourceTile);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.state === "evicted") {
        existing.pixels = resource.pixels;
        existing.state = "decoded";
      }
      return;
    }
    const record: PageRecord = {
      sourceTile: resource.sourceTile,
      state: "decoded",
      pixels: resource.pixels,
      usedAt: 0,
    };
    this.records.set(key, record);
  }

  private uploadDecoded(): void {
    const desiredSources = this.desiredSourceKeys();
    const decoded = [...this.records.values()]
      .filter(
        (record) =>
          record.state === "decoded" &&
          record.pixels &&
          desiredSources.has(imageryKey(record.sourceTile)),
      )
      .slice(0, MAX_UPLOADS_PER_FRAME);
    if (decoded.length === 0) return;
    if (!this.ensurePoolCapacity()) return;
    const layerBytes = this.paddedSize ** 2 * 4;
    for (const record of decoded) {
      const slot = this.allocateSlot();
      if (slot === undefined || !record.pixels) return;
      this.poolPixels.set(record.pixels, slot * layerBytes);
      this.poolTexture.addLayerUpdate(slot);
      record.pixels = undefined;
      record.slot = slot;
      record.state = "resident";
      record.usedAt = ++this.sequence;
      this.stitchNeighbours(record);
    }
    this.poolTexture.needsUpdate = true;
    this.renderer.initTexture(this.poolTexture);
    this.mappingDirty = true;
  }

  private stitchNeighbours(record: PageRecord): void {
    if (record.slot === undefined) return;
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) continue;
        const neighbour = this.records.get(
          imageryKey({
            z: record.sourceTile.z,
            x: wrapImageryX(record.sourceTile.x + offsetX, record.sourceTile.z),
            y: record.sourceTile.y + offsetY,
          }),
        );
        if (neighbour?.state !== "resident" || neighbour.slot === undefined) {
          continue;
        }
        stitchImageryGutter(
          this.poolPixels,
          this.tileSize,
          IMAGERY_GUTTER_PIXELS,
          record.slot,
          neighbour.slot,
          offsetX as -1 | 0 | 1,
          offsetY as -1 | 0 | 1,
        );
        stitchImageryGutter(
          this.poolPixels,
          this.tileSize,
          IMAGERY_GUTTER_PIXELS,
          neighbour.slot,
          record.slot,
          -offsetX as -1 | 0 | 1,
          -offsetY as -1 | 0 | 1,
        );
        this.poolTexture.addLayerUpdate(neighbour.slot);
      }
    }
  }

  private ensurePoolCapacity(): boolean {
    const requiredLayers = Math.max(
      1,
      imageryResidencyKeys(
        this.visibleSourceKeys,
        this.desiredSourceKeys(),
      ).size,
    );
    if (requiredLayers <= this.poolLayers) return true;
    const nextLayers = requiredLayers;
    const layerBytes = this.paddedSize ** 2 * 4;
    const pixels = new Uint8Array(layerBytes * nextLayers);
    pixels.set(this.poolPixels);
    const previous = this.poolTexture;
    this.poolPixels = pixels;
    this.poolLayers = nextLayers;
    this.poolTexture = this.createPoolTexture(pixels, nextLayers);
    this.renderer.initTexture(this.poolTexture);
    this.sharedUniforms.imageryTilePool!.value = this.poolTexture;
    for (let slot = nextLayers - 1; slot >= previous.image.depth; slot -= 1) {
      this.freeSlots.push(slot);
    }
    previous.dispose();
    return true;
  }

  private allocateSlot(): number | undefined {
    const free = this.freeSlots.pop();
    if (free !== undefined) return free;
    const protectedSources = new Set([
      ...this.visibleSourceKeys,
      ...this.desiredSourceKeys(),
    ]);
    const candidate = [...this.records.entries()]
      .filter(
        ([key, record]) =>
          record.state === "resident" && !protectedSources.has(key),
      )
      .sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
    if (!candidate) return undefined;
    const record = candidate[1];
    const slot = record.slot;
    record.slot = undefined;
    record.state = "evicted";
    return slot;
  }

  private commitMapping(): void {
    const mappingTarget = this.mappingGridTarget();
    const zoom = mappingTarget.z;
    const point = mercatorPointForImagery(
      tileCentreLatitude(mappingTarget),
      tileCentreLongitude(mappingTarget),
      zoom,
    );
    const originX = Math.floor(point.x) - IMAGERY_PAGE_TABLE_SIZE / 2;
    const originY = Math.max(
      0,
      Math.min(
        2 ** zoom - IMAGERY_PAGE_TABLE_SIZE,
        Math.floor(point.y) - IMAGERY_PAGE_TABLE_SIZE / 2,
      ),
    );
    const cut = relevantTiles(
      this.snapshot.committedCut,
      mappingTarget,
    ).sort((a, b) => b.z - a.z);
    const desiredSources = this.desiredSourceKeys();
    for (const tile of cut) {
      const resource = this.scheduler!.committedResource(tile);
      if (resource?.pixels && resource.sourceTile) {
        if (!desiredSources.has(imageryKey(resource.sourceTile))) continue;
        const record = this.records.get(imageryKey(resource.sourceTile));
        if (record?.state !== "resident") return;
      }
    }
    const entries = new Float32Array(IMAGERY_PAGE_TABLE_SIZE ** 2 * 4);
    const nextVisibleSourceKeys = new Set<string>();
    const worldWidth = 2 ** zoom;
    for (let tableY = 0; tableY < IMAGERY_PAGE_TABLE_SIZE; tableY += 1) {
      const y = originY + tableY;
      if (y < 0 || y >= worldWidth) continue;
      for (let tableX = 0; tableX < IMAGERY_PAGE_TABLE_SIZE; tableX += 1) {
        const unwrappedX = originX + tableX;
        const x = ((unwrappedX % worldWidth) + worldWidth) % worldWidth;
        const target = { z: zoom, x, y };
        const tile = cut.find((candidate) => contains(candidate, target));
        const resource = tile
          ? this.scheduler!.committedResource(tile)
          : undefined;
        const desiredKey = resource?.sourceTile
          ? imageryKey(resource.sourceTile)
          : undefined;
        const desiredRecord =
          desiredKey && desiredSources.has(desiredKey)
            ? this.records.get(desiredKey)
            : undefined;
        const selectedSource = preservingImagerySource(
          target,
          desiredRecord?.state === "resident"
            ? desiredRecord.sourceTile
            : undefined,
          this.activeSources(),
        );
        const record = selectedSource
          ? this.records.get(imageryKey(selectedSource))
          : undefined;
        if (record?.state !== "resident" || record.slot === undefined) {
          // A swap may introduce Blue Marble only where the active table had
          // no photographic coverage to preserve.
          if (this.activeSourceOverlapsPage(target)) return;
          continue;
        }
        const resolved = resolvePageEntry(target, record.sourceTile, record.slot);
        const offset = (tableY * IMAGERY_PAGE_TABLE_SIZE + tableX) * 4;
        entries[offset] = resolved.layer + 1;
        entries[offset + 1] = resolved.scale;
        entries[offset + 2] = resolved.offsetX;
        entries[offset + 3] = resolved.offsetY;
        record.usedAt = ++this.sequence;
        nextVisibleSourceKeys.add(imageryKey(record.sourceTile));
      }
    }
    const nextIndex = this.activePageTable === 0 ? 1 : 0;
    const table = this.pageTables[nextIndex];
    (table.image.data as Float32Array).set(entries);
    table.needsUpdate = true;
    this.renderer.initTexture(table);
    this.activePageTable = nextIndex;
    this.sharedUniforms.imageryPageTable!.value = table;
    this.sharedUniforms.imageryEnabled!.value = 1;
    this.visible = {
      zoom,
      originX,
      originY,
      referenceX: point.x,
    };
    this.visibleSourceKeys.clear();
    for (const key of nextVisibleSourceKeys) this.visibleSourceKeys.add(key);
    this.mappingDirty = false;
  }

  private desiredSourceKeys(): Set<string> {
    const keys = new Set<string>();
    for (const tile of this.snapshot.committedCut) {
      const sourceTile = this.scheduler!.committedResource(tile)?.sourceTile;
      if (!sourceTile) continue;
      keys.add(imageryKey(sourceTile));
    }
    return keys;
  }

  private mappingGridTarget(): TileTarget {
    const candidate = imageryMappingTarget(
      this.snapshot.target,
      this.snapshot.committedCut,
    );
    if (!this.visible || this.visible.zoom <= candidate.z) return candidate;
    if (this.coarseGridHasCompleteReplacement(candidate)) return candidate;
    const scale = 2 ** (this.visible.zoom - candidate.z);
    return normalizeTileTarget({
      z: this.visible.zoom,
      x: Math.floor((candidate.x + 0.5) * scale),
      y: Math.floor((candidate.y + 0.5) * scale),
    });
  }

  private coarseGridHasCompleteReplacement(target: TileTarget): boolean {
    const cut = relevantTiles(this.snapshot.committedCut, target);
    for (const page of pageCells(target)) {
      const tile = cut.find((candidate) => contains(candidate, page));
      const resource = tile
        ? this.scheduler!.committedResource(tile)
        : undefined;
      if (resource?.sourceTile) {
        const record = this.records.get(imageryKey(resource.sourceTile));
        if (record?.state === "resident") continue;
      }
      if (this.activeSourceOverlapsPage(page)) return false;
    }
    return true;
  }

  private activeSources(): TileIdentity[] {
    return [...this.visibleSourceKeys]
      .map((key) => this.records.get(key))
      .filter(
        (record): record is PageRecord => record?.state === "resident",
      )
      .map((record) => record.sourceTile);
  }

  private activeSourceOverlapsPage(page: TileIdentity): boolean {
    return [...this.visibleSourceKeys].some((key) => {
      const record = this.records.get(key);
      return record?.state === "resident" && tilesOverlap(record.sourceTile, page);
    });
  }
}

/** Finest page grid capable of representing every currently committed leaf. */
export function imageryMappingTarget(
  target: TileTarget,
  committedCut: readonly TileIdentity[],
): TileTarget {
  const zoom = Math.max(
    target.z,
    ...committedCut.map((tile) => tile.z),
  );
  const scale = 2 ** (zoom - target.z);
  return normalizeTileTarget({
    z: zoom,
    x: Math.floor((target.x + 0.5) * scale),
    y: Math.floor((target.y + 0.5) * scale),
  });
}

function contains(tile: TileIdentity, target: TileIdentity): boolean {
  if (tile.z > target.z) return false;
  const scale = 2 ** (target.z - tile.z);
  return (
    Math.floor(target.x / scale) === tile.x &&
    Math.floor(target.y / scale) === tile.y
  );
}

function tilesOverlap(first: TileIdentity, second: TileIdentity): boolean {
  const zoom = Math.max(first.z, second.z);
  const firstScale = 2 ** (zoom - first.z);
  const secondScale = 2 ** (zoom - second.z);
  return (
    first.x * firstScale < (second.x + 1) * secondScale &&
    (first.x + 1) * firstScale > second.x * secondScale &&
    first.y * firstScale < (second.y + 1) * secondScale &&
    (first.y + 1) * firstScale > second.y * secondScale
  );
}

function pageCells(target: TileIdentity): TileIdentity[] {
  const width = 2 ** target.z;
  const originX = target.x - IMAGERY_PAGE_TABLE_SIZE / 2;
  const originY = Math.max(
    0,
    Math.min(width - IMAGERY_PAGE_TABLE_SIZE, target.y - IMAGERY_PAGE_TABLE_SIZE / 2),
  );
  const rows = Math.min(IMAGERY_PAGE_TABLE_SIZE, width);
  const columns = Math.min(IMAGERY_PAGE_TABLE_SIZE, width);
  return Array.from({ length: rows * columns }, (_, index) => ({
    z: target.z,
    x: ((originX + (index % columns)) % width + width) % width,
    y: originY + Math.floor(index / columns),
  }));
}

function relevantTiles(
  cut: readonly TileIdentity[],
  target: TileIdentity,
): TileIdentity[] {
  const result = new Map<string, TileIdentity>();
  const ordered = [...cut].sort((a, b) => b.z - a.z);
  const cells = pageCells(target).sort(
    (a, b) =>
      Math.hypot(
        a.x - target.x,
        a.y - target.y,
      ) -
      Math.hypot(
        b.x - target.x,
        b.y - target.y,
      ),
  );
  for (const page of cells) {
    const tile = ordered.find((candidate) => contains(candidate, page));
    if (tile) result.set(tileIdentityKey(tile), tile);
  }
  return [...result.values()];
}

function tileCentreLongitude(tile: TileIdentity): number {
  return ((tile.x + 0.5) / 2 ** tile.z) * 360 - 180;
}

function tileCentreLatitude(tile: TileIdentity): number {
  const n = Math.PI - (2 * Math.PI * (tile.y + 0.5)) / 2 ** tile.z;
  return Math.atan(Math.sinh(n)) * 180 / Math.PI;
}
