import * as THREE from "three";
import {
  WEB_MERCATOR_MAX_LATITUDE,
  ancestorAtZoom,
  imageryKey,
  mercatorPointForImagery,
  selectImageryZoom,
  wrapImageryX,
  type ImageryAddress,
  type ImageryView,
} from "./imagery-core.js";
import type {
  ImageryDecoderCommand,
  ImageryDecoderMessage,
} from "./imagery-decoder-protocol.js";
import {
  imageryMipDimensions,
  type ImageryMipLevel,
} from "./imagery-mip-chain.js";
import {
  BLUE_MARBLE_IMAGERY_KEY,
  BLUE_MARBLE_IMAGERY_NODE,
  buildDesiredImageryTree,
  encodeImageryTree,
  imageryTreeSourceKeys,
  reconcileImageryTree,
  type DesiredImageryTree,
  type EncodedImageryTree,
  type ImageryImageNode,
  type ImageryTreeNode,
} from "./imagery-tree.js";
import {
  ImageryRequestError,
  type ImageryProvider,
} from "./imagery-provider.js";
import {
  normalizeTileLayoutTarget,
  tileLayoutTargetNeedsSubmission,
  type TileLayoutTarget,
} from "./tile-layout-source.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "./tile-provider.js";
import type { SchedulerSnapshot } from "./tile-transition-scheduler.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";
import { TileWorkerScheduler } from "./tile-worker-scheduler.js";
import { summarizeTilePlannerSnapshot } from "./tile-planner-state.js";
import {
  DEFAULT_TILE_DEBUG_CONTROLS,
  demandedPayloadTiles,
  eligiblePayloadTiles,
  tileTopologySelectionChanged,
  type TilePipelineDebugControls,
} from "./tile-debug-controls.js";
import {
  classifyHotResidency,
  classifyWarmResidency,
  hotResidencySignature,
  sameResidencyKeys,
  warmResidencySignature,
  type ViewResidencyInput,
} from "./view-residency.js";

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

function stitchSeparateImageryGutter(
  destination: Uint8Array,
  source: Uint8Array,
  tileSize: number,
  gutter: number,
  offsetX: -1 | 0 | 1,
  offsetY: -1 | 0 | 1,
): void {
  const paddedSize = tileSize + gutter * 2;
  const copyWidth = offsetX === 0 ? tileSize : gutter;
  const copyHeight = offsetY === 0 ? tileSize : gutter;
  const destinationX = offsetX < 0 ? 0 : offsetX > 0 ? gutter + tileSize : gutter;
  const destinationY = offsetY < 0 ? 0 : offsetY > 0 ? gutter + tileSize : gutter;
  const sourceX = offsetX < 0 ? tileSize : offsetX > 0 ? gutter : gutter;
  const sourceY = offsetY < 0 ? tileSize : offsetY > 0 ? gutter : gutter;
  for (let row = 0; row < copyHeight; row += 1) {
    const sourceOffset = ((sourceY + row) * paddedSize + sourceX) * 4;
    const destinationOffset =
      ((destinationY + row) * paddedSize + destinationX) * 4;
    destination.set(
      source.subarray(sourceOffset, sourceOffset + copyWidth * 4),
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

/** Geographic topology target; imagery source clamping remains downstream. */
export function imageryTargetForView(
  view: Pick<ImageryView, "latitudeDegrees" | "longitudeDegrees">,
  maxZoom: number,
): TileLayoutTarget {
  return normalizeTileLayoutTarget({
    maxZoom,
    latitudeDegrees: view.latitudeDegrees,
    longitudeDegrees: view.longitudeDegrees,
  });
}

/** Earth-fixed normalized Web Mercator bounds for one terrain mesh. */
export function imageryBoundsForGeographicBounds(bounds: {
  west: number;
  east: number;
  north: number;
  south: number;
}): ImageryCoordinateBounds {
  return {
    west: (bounds.west + 180) / 360,
    east: (bounds.east + 180) / 360,
    north: mercatorPointForImagery(bounds.north, bounds.west, 0).y,
    south: mercatorPointForImagery(bounds.south, bounds.east, 0).y,
  };
}

export const IMAGERY_FRAGMENT_DECLARATIONS = `
  uniform sampler2D blueMarbleMap;
  uniform highp usampler2D imageryTree;
  uniform highp usampler2D imageryImages;
  uniform highp sampler2DArray imageryTilePool;
  uniform float imageryEnabled;
  uniform int imageryTreeDepth;
  uniform int imageryTreeTextureWidth;
  uniform int imageryImageTextureWidth;
  uniform vec3 imageryPoolLayout;
  uniform vec4 imageryGlobalOriginScale;
  in vec2 vBlueMarbleUv;
  in vec2 vImageryUv;

  bool resolvedImageryLeaf(
    out float layer,
    out vec2 sourceUv,
    out vec2 sourceDx,
    out vec2 sourceDy
  ) {
    vec2 localUv = vImageryUv;
    vec2 traversalLocalUv = vec2(localUv.x, min(localUv.y, 0.99999994));
    vec2 globalOrigin = imageryGlobalOriginScale.xy;
    vec2 globalScale = imageryGlobalOriginScale.zw;
    vec2 globalDx = dFdx(localUv) * globalScale;
    vec2 globalDy = dFdy(localUv) * globalScale;
    uint nodeIndex = 0u;
    float depthScale = 2.0;
    for (int depth = 0; depth <= imageryTreeDepth; depth += 1) {
      int nodeLinearIndex = int(nodeIndex);
      uvec4 node = texelFetch(
        imageryTree,
        ivec2(
          nodeLinearIndex % imageryTreeTextureWidth,
          nodeLinearIndex / imageryTreeTextureWidth
        ),
        0
      );
      if (node.r == 0u) {
        if (node.g == 0u) return false;
        int imageLinearIndex = int(node.g - 1u);
        uvec4 image = texelFetch(
          imageryImages,
          ivec2(
            imageLinearIndex % imageryImageTextureWidth,
            imageLinearIndex / imageryImageTextureWidth
          ),
          0
        );
        float sourceWidth = exp2(float(image.g));
        layer = float(image.r);
        sourceUv = fract(
          fract(globalOrigin * sourceWidth) +
          localUv * (globalScale * sourceWidth)
        );
        sourceDx = globalDx * sourceWidth;
        sourceDy = globalDy * sourceWidth;
        return true;
      }
      vec2 scaledOrigin = globalOrigin * depthScale;
      vec2 scaledLocal = traversalLocalUv * (globalScale * depthScale);
      vec2 bits = mod(
        floor(scaledOrigin) +
        floor(fract(scaledOrigin) + scaledLocal),
        2.0
      );
      uint quadrant = uint(bits.x) + uint(bits.y) * 2u;
      nodeIndex = node.r + quadrant;
      depthScale *= 2.0;
    }
    return false;
  }

  vec3 resolvedImageryAlbedo() {
    if (imageryEnabled < 0.5) return texture(blueMarbleMap, vBlueMarbleUv).rgb;
    float layer;
    vec2 sourceUv;
    vec2 sourceDx;
    vec2 sourceDy;
    if (!resolvedImageryLeaf(layer, sourceUv, sourceDx, sourceDy)) {
      return texture(blueMarbleMap, vBlueMarbleUv).rgb;
    }
    float tileSize = imageryPoolLayout.x;
    float gutter = imageryPoolLayout.y;
    float paddedSize = imageryPoolLayout.z;
    vec2 poolUv = (vec2(gutter) + sourceUv * tileSize) / paddedSize;
    vec2 poolDx = sourceDx * tileSize / paddedSize;
    vec2 poolDy = sourceDy * tileSize / paddedSize;
    float footprint = max(length(poolDx), length(poolDy)) * paddedSize;
    float supportedFootprint = max(1.0, gutter * 2.0);
    float gradientScale =
      min(1.0, supportedFootprint / max(footprint, 0.000001));
    return textureGrad(
      imageryTilePool,
      vec3(poolUv, layer),
      poolDx * gradientScale,
      poolDy * gradientScale
    ).rgb;
  }

  vec4 resolvedImageryTileOverlay() {
    if (imageryEnabled < 0.5) return vec4(0.0);
    float layer;
    vec2 sourceUv;
    vec2 sourceDx;
    vec2 sourceDy;
    if (!resolvedImageryLeaf(layer, sourceUv, sourceDx, sourceDy)) {
      return vec4(0.0);
    }
    vec2 edge = min(sourceUv, 1.0 - sourceUv);
    float distanceToEdge = min(edge.x, edge.y);
    float line = 1.0 - smoothstep(
      0.0,
      max(0.0005, fwidth(distanceToEdge) * 2.5),
      distanceToEdge
    );
    vec3 colour = vec3(1.0, 0.741, 0.247);
    return vec4(colour, mix(0.18, 0.92, line));
  }
`;

export interface ImageryTileResource {
  readonly kind: "imagery";
  readonly tile: TileIdentity;
  readonly sourceTile?: TileIdentity;
  readonly pixels?: Uint8Array;
  readonly fallbackFromNotFound?: boolean;
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
  readonly fallbackFromNotFound?: boolean;
}

interface SourceJob {
  readonly key: string;
  readonly sourceTile: TileIdentity;
  readonly consumers: Set<number>;
  state: "queued" | "active";
  hot: boolean;
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
  private prioritySourceKeys = new Set<string>();
  private disposed = false;
  private requestTotal = 0;
  private sourceLoadTotal = 0;
  private decodeTotal = 0;

  constructor(
    readonly source: ImageryProvider,
    private readonly decode: (
      blob: Blob,
      tileSize: number,
      signal: AbortSignal,
    ) => Promise<Uint8Array> = async (blob) =>
      new Uint8Array(await blob.arrayBuffer()),
  ) {}

  get metrics(): {
    requestTotal: number;
    sourceLoadTotal: number;
    decodeTotal: number;
    queued: number;
    inFlight: number;
  } {
    return {
      requestTotal: this.requestTotal,
      sourceLoadTotal: this.sourceLoadTotal,
      decodeTotal: this.decodeTotal,
      queued: this.queuedJobs.length,
      inFlight: this.activeJobCount,
    };
  }

  request(
    tile: TileIdentity,
    observer: (result: TileProviderResult<ImageryTileResource>) => void,
  ): TileRequestHandle {
    this.requestTotal += 1;
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
        hot: this.prioritySourceKeys.has(sourceKey),
      };
      this.jobs.set(sourceKey, job);
      this.queuedJobs.push(job);
    }
    job.consumers.add(request.id);
    if (job.state === "active") {
      // This request joined a source fetch that had already started. Defer the
      // phase notification until request() has returned its cancellation
      // handle, and suppress it if either the request or shared job completed
      // or was cancelled first.
      const joinedJob = job;
      queueMicrotask(() => {
        const activeRequest = this.requests.get(request.id);
        if (
          activeRequest !== request ||
          !request.active ||
          this.jobs.get(sourceKey) !== joinedJob ||
          joinedJob.state !== "active" ||
          !joinedJob.consumers.has(request.id)
        ) return;
        observer({ phase: "in-flight" });
      });
    }
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

  updatePriority(tiles: Iterable<TileIdentity>): void {
    const priority = new Set<string>();
    for (const tile of tiles) {
      priority.add(imageryKey(ancestorAtZoom(tile, this.source.maxZoom)));
    }
    this.prioritySourceKeys = priority;
    for (const job of this.jobs.values()) job.hot = priority.has(job.key);
    this.queuedJobs.sort((first, second) =>
      Number(second.hot) - Number(first.hot)
    );
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
    this.queuedJobs.sort((first, second) =>
      Number(second.hot) - Number(first.hot)
    );
    while (this.activeJobCount < MAX_CONCURRENT_REQUESTS) {
      const job = this.queuedJobs.shift();
      if (!job) return;
      if (!this.jobs.has(job.key) || job.consumers.size === 0) continue;
      job.state = "active";
      job.controller = new AbortController();
      this.activeJobCount += 1;
      this.sourceLoadTotal += 1;
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
          ...(result.fallbackFromNotFound
            ? { fallbackFromNotFound: true }
            : {}),
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
        this.decodeTotal += 1;
        return {
          sourceTile: Object.freeze({ ...sourceTile }),
          pixels,
          ...(sourceTile.z < initial.z
            ? { fallbackFromNotFound: true }
            : {}),
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

export interface ImageryWorkerPort {
  postMessage(
    message: ImageryDecoderCommand,
    transfer?: Transferable[],
  ): void;
  onmessage: ((event: MessageEvent<ImageryDecoderMessage>) => void) | null;
  terminate(): void;
}

interface MipWork {
  latestRevision: number;
  pixels: Uint8Array;
  width: number;
  height: number;
  inFlight?: { requestId: number; revision: number };
  complete(revision: number, levels: readonly ImageryMipLevel[]): void;
  fail(revision: number, reason: string): void;
}

/** One worker client for decode plus revision-coalesced mip generation. */
export class ImageryWorkerClient {
  private nextId = 1;
  private readonly worker: ImageryWorkerPort;
  private readonly decodes = new Map<
    number,
    {
      resolve(pixels: Uint8Array): void;
      reject(error: unknown): void;
      signal: AbortSignal;
      abort(): void;
    }
  >();
  private readonly mipWork = new Map<string, MipWork>();
  private readonly mipRequests = new Map<
    number,
    { key: string; revision: number }
  >();

  constructor(worker?: ImageryWorkerPort) {
    this.worker =
      worker ??
      new Worker(new URL("./imagery-decoder.worker.ts", import.meta.url), {
        type: "module",
      });
    this.worker.onmessage = ({ data }) => {
      if (data.kind === "decoded") {
        const pending = this.decodes.get(data.requestId);
        if (!pending) return;
        this.decodes.delete(data.requestId);
        pending.signal.removeEventListener("abort", pending.abort);
        pending.resolve(new Uint8Array(data.pixels));
        return;
      }
      const mipRequest = this.mipRequests.get(data.requestId);
      if (mipRequest) {
        this.finishMip(mipRequest, data);
        return;
      }
      if (data.kind !== "failure") return;
      const pending = this.decodes.get(data.requestId);
      if (!pending) return;
      this.decodes.delete(data.requestId);
      pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(new ImageryRequestError(data.reason, "malformed"));
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
        if (!this.decodes.delete(requestId)) return;
        this.worker.postMessage({ kind: "cancel", requestId });
        reject(abortError());
      };
      this.decodes.set(requestId, { resolve, reject, signal, abort });
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

  requestMip(
    key: string,
    revision: number,
    pixels: Uint8Array,
    width: number,
    height: number,
    complete: MipWork["complete"],
    fail: MipWork["fail"],
  ): void {
    const existing = this.mipWork.get(key);
    if (existing) {
      if (revision < existing.latestRevision) return;
      existing.latestRevision = revision;
      existing.pixels = pixels;
      existing.width = width;
      existing.height = height;
      existing.complete = complete;
      existing.fail = fail;
      if (!existing.inFlight) this.dispatchMip(key, existing);
      return;
    }
    const work: MipWork = {
      latestRevision: revision,
      pixels,
      width,
      height,
      complete,
      fail,
    };
    this.mipWork.set(key, work);
    this.dispatchMip(key, work);
  }

  dispose(): void {
    this.worker.terminate();
    for (const pending of this.decodes.values()) {
      pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(new Error("Imagery decoder disposed."));
    }
    this.decodes.clear();
    this.mipWork.clear();
    this.mipRequests.clear();
  }

  private dispatchMip(key: string, work: MipWork): void {
    const requestId = this.nextId++;
    const revision = work.latestRevision;
    const pixels = work.pixels.slice().buffer;
    work.inFlight = { requestId, revision };
    this.mipRequests.set(requestId, { key, revision });
    this.worker.postMessage(
      {
        kind: "mip",
        requestId,
        key,
        revision,
        pixels,
        width: work.width,
        height: work.height,
      },
      [pixels],
    );
  }

  private finishMip(
    request: { key: string; revision: number },
    message: ImageryDecoderMessage,
  ): void {
    this.mipRequests.delete(message.requestId);
    const work = this.mipWork.get(request.key);
    if (!work || work.inFlight?.requestId !== message.requestId) return;
    work.inFlight = undefined;
    if (request.revision !== work.latestRevision) {
      this.dispatchMip(request.key, work);
      return;
    }
    this.mipWork.delete(request.key);
    if (message.kind === "failure") {
      work.fail(request.revision, message.reason);
      return;
    }
    if (message.kind !== "mipped") return;
    work.complete(
      request.revision,
      message.levels.map(({ width, height, pixels }) => ({
        width,
        height,
        pixels: new Uint8Array(pixels),
      })),
    );
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
  readonly basePixels: Uint8Array;
  readonly node: ImageryImageNode;
  revision: number;
  mipRevision: number;
  mipLevels?: readonly ImageryMipLevel[];
}

interface ImageryPool {
  readonly generation: number;
  readonly texture: THREE.DataArrayTexture;
  readonly layers: number;
  readonly slots: Map<string, number>;
  readonly uploadedRevisions: Map<string, number>;
  readonly freeSlots: number[];
}

interface PoolMigration {
  readonly pool: ImageryPool;
  readonly root: ImageryTreeNode;
  readonly demandedKeys: ReadonlySet<string>;
  /** Candidate mappings are separate so the visible tree cannot be disturbed. */
  readonly slots: Map<string, number>;
  readonly uploadedRevisions: Map<string, number>;
  /** A larger backing texture must be swapped in at publication time. */
  readonly replacesActivePool: boolean;
}

interface ImageryTreeTextures {
  readonly nodes: THREE.DataTexture;
  readonly images: THREE.DataTexture;
  readonly encoding: EncodedImageryTree;
  readonly nodeWidth: number;
  readonly imageWidth: number;
}

export interface ImageryLayerUpload {
  readonly slot: number;
  readonly destinationMip: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** A layer is publishable only when every expected mip has valid RGBA data. */
export function imageryLayerUploadPlan(
  slot: number,
  paddedSize: number,
  levels: readonly ImageryMipLevel[],
): readonly ImageryLayerUpload[] | undefined {
  const dimensions = imageryMipDimensions(paddedSize, paddedSize);
  if (levels.length !== dimensions.length) return undefined;
  const uploads: ImageryLayerUpload[] = [];
  for (let mip = 0; mip < dimensions.length; mip += 1) {
    const expected = dimensions[mip]!;
    const level = levels[mip];
    if (
      !level ||
      level.width !== expected.width ||
      level.height !== expected.height ||
      level.pixels.byteLength !== expected.width * expected.height * 4
    ) return undefined;
    uploads.push({
      slot,
      destinationMip: mip,
      width: level.width,
      height: level.height,
      pixels: level.pixels,
    });
  }
  return uploads;
}

/** A staged pool may replace the visible one only after its full demand exists. */
export function imageryMigrationReady(
  demandedKeys: Iterable<string>,
  uploadedRevisions: ReadonlyMap<string, number>,
): boolean {
  for (const key of demandedKeys) {
    if ((uploadedRevisions.get(key) ?? 0) <= 0) return false;
  }
  return true;
}

export interface ImageryPoolMigrationPlan {
  readonly slots: Map<string, number>;
  readonly uploadedRevisions: Map<string, number>;
  readonly requiredAdditionalSlots: number;
}

/**
 * Grow only by the slots this transition cannot stage in the current pool.
 * The current capacity is a floor, so a smaller later cut never causes churn.
 */
export function imageryPoolGrowthCapacity(
  activeCapacity: number,
  demandedCount: number,
  requiredAdditionalSlots: number,
): number {
  return Math.max(
    activeCapacity,
    demandedCount,
    activeCapacity + requiredAdditionalSlots,
  );
}

/**
 * Retain valid layers in their existing slots. A page whose mip revision
 * changed receives a new slot, leaving the visible generation untouched until
 * the candidate tree is published.
 */
export function planImageryPoolMigration(
  activeSlots: ReadonlyMap<string, number>,
  activeUploadedRevisions: ReadonlyMap<string, number>,
  demanded: Iterable<string>,
  revisions: ReadonlyMap<string, number>,
): ImageryPoolMigrationPlan {
  const slots = new Map<string, number>();
  const uploadedRevisions = new Map<string, number>();
  let requiredAdditionalSlots = 0;
  for (const key of demanded) {
    const revision = revisions.get(key) ?? 0;
    const slot = activeSlots.get(key);
    const uploaded = activeUploadedRevisions.get(key) ?? 0;
    if (slot !== undefined && uploaded >= revision && revision > 0) {
      slots.set(key, slot);
      uploadedRevisions.set(key, uploaded);
    } else {
      requiredAdditionalSlots += 1;
    }
  }
  return { slots, uploadedRevisions, requiredAdditionalSlots };
}

function initialSnapshot(
  target: TileLayoutTarget,
): SchedulerSnapshot<TileLayoutTarget> {
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
  private readonly workerClient?: ImageryWorkerClient;
  private readonly sharedUniforms: Record<string, THREE.IUniform>;
  private readonly records = new Map<string, PageRecord>();
  private readonly stagingTexture: THREE.DataTexture;
  private activePool: ImageryPool;
  private migration?: PoolMigration;
  private activeTreeTextures: ImageryTreeTextures;
  private committedRoot: ImageryTreeNode = BLUE_MARBLE_IMAGERY_NODE;
  private desiredRoot: DesiredImageryTree = Object.freeze({
    image: BLUE_MARBLE_IMAGERY_KEY,
    fallbackFromNotFound: false,
  });
  private committedSourceKeys = new Set<string>();
  private readonly tileSize: number;
  private readonly paddedSize: number;
  private readonly unsubscribe?: () => void;
  private snapshot: SchedulerSnapshot<TileLayoutTarget>;
  private target: TileLayoutTarget;
  private desiredZoom: number | undefined;
  private desiredSourceKeySet = new Set<string>();
  private nextPoolGeneration = 1;
  private hotKeys = new Set<string>();
  private warmKeys = new Set<string>();
  private residencyInput?: ViewResidencyInput;
  private hotViewSignature = -1;
  private hotRevision = -2;
  private warmViewSignature = -1;
  private warmRevision = -2;
  private uploadTotal = 0;
  private residencyClassificationTotal = 0;
  private hotResidencyClassificationTotal = 0;
  private warmResidencyClassificationTotal = 0;
  private debugControls: TilePipelineDebugControls = {
    ...DEFAULT_TILE_DEBUG_CONTROLS.textures,
  };
  private overheadPercent = DEFAULT_TILE_DEBUG_CONTROLS.overheadPercent;

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
    this.target = imageryTargetForView(initialView, zoom);
    this.snapshot = initialSnapshot(this.target);
    this.tileSize = imageryProvider?.tileSize ?? 1;
    this.paddedSize = this.tileSize + IMAGERY_GUTTER_PIXELS * 2;
    this.stagingTexture = new THREE.DataTexture(
      new Uint8Array(4),
      1,
      1,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
    );
    this.stagingTexture.colorSpace = THREE.SRGBColorSpace;
    this.stagingTexture.flipY = false;
    this.stagingTexture.unpackAlignment = 1;
    this.stagingTexture.generateMipmaps = false;
    this.activePool = this.createPool(1);
    const initialEncoding = encodeImageryTree(
      this.committedRoot,
      this.activePool.generation,
      () => undefined,
    )!;
    this.activeTreeTextures = this.createTreeTextures(initialEncoding);
    this.sharedUniforms = {
      blueMarbleMap: new THREE.Uniform(blueMarble),
      imageryTree: new THREE.Uniform(this.activeTreeTextures.nodes),
      imageryImages: new THREE.Uniform(this.activeTreeTextures.images),
      imageryTilePool: new THREE.Uniform(this.activePool.texture),
      imageryEnabled: new THREE.Uniform(0),
      imageryTreeDepth: new THREE.Uniform(initialEncoding.maximumDepth),
      imageryTreeTextureWidth: new THREE.Uniform(
        this.activeTreeTextures.nodeWidth,
      ),
      imageryImageTextureWidth: new THREE.Uniform(
        this.activeTreeTextures.imageWidth,
      ),
      imageryPoolLayout: new THREE.Uniform(
        new THREE.Vector3(
          this.tileSize,
          IMAGERY_GUTTER_PIXELS,
          this.paddedSize,
        ),
      ),
    };
    if (imageryProvider) {
      this.desiredZoom = zoom;
      this.workerClient = new ImageryWorkerClient();
      this.provider = new ScheduledImageryProvider(
        imageryProvider,
        (blob, tileSize, signal) =>
          this.workerClient!.decode(blob, tileSize, signal),
      );
      this.residencyInput = {
        underfoot: initialView,
        footprint: [],
        displayRadiusM: initialView.displayRadiusM,
        observerHeightWorldM: 0,
      };
      this.scheduler = new TileWorkerScheduler(this.target, {
        provider: this.provider,
        hydrateInitialResources: false,
        retryDelayMs: 5_000,
        initialResourceDemand: [],
      });
      this.snapshot = this.scheduler.snapshot;
      this.unsubscribe = this.scheduler.subscribe((snapshot, event) => {
        this.snapshot = snapshot;
        this.applyResidency();
        if (event?.kind === "response") {
          if (event.tile) this.stage(this.scheduler!.committedResource(event.tile));
          else {
            for (const tile of snapshot.committedCut) {
              this.stage(this.scheduler!.committedResource(tile));
            }
          }
          this.refreshDesiredTree();
        }
        if (!event || event.kind === "atomic-swap") {
          for (const tile of snapshot.committedCut) {
            this.stage(this.scheduler!.committedResource(tile));
          }
          this.refreshDesiredTree();
        }
      });
    }
  }

  materialUniforms(): Record<string, THREE.IUniform> {
    return {
      ...this.sharedUniforms,
      imageryGlobalOriginScale: new THREE.Uniform(new THREE.Vector4()),
    };
  }

  configureMaterial(
    material: THREE.ShaderMaterial,
    bounds: ImageryCoordinateBounds,
  ): void {
    const transform = material.uniforms.imageryGlobalOriginScale
      ?.value as THREE.Vector4 | undefined;
    if (!transform) return;
    transform.set(
      bounds.west,
      bounds.north,
      bounds.east - bounds.west,
      bounds.south - bounds.north,
    );
  }

  update(view: ImageryView, residencyInput?: ViewResidencyInput): void {
    if (!this.scheduler || !this.provider) return;
    const zoom = selectImageryZoom({
      ...view,
      minZoom: this.provider.source.minZoom,
      maxZoom: this.provider.source.maxZoom,
      tilePixels: this.provider.source.tileSize,
      previousZoom: this.desiredZoom,
      targetScreenPixelsPerSourcePixel:
        this.debugControls.screenPixelsPerSourcePixel,
      maxTopologyZoom: this.debugControls.maxZoom,
    });
    const target = imageryTargetForView(view, zoom);
    if (tileLayoutTargetNeedsSubmission(this.target, target)) {
      this.target = target;
      this.scheduler.updateTarget(target);
    }
    this.desiredZoom = zoom;
    this.residencyInput = residencyInput ?? {
      underfoot: view,
      footprint: [],
      displayRadiusM: view.displayRadiusM,
      observerHeightWorldM: 0,
    };
    this.applyResidency();
    this.processUploads();
  }

  setDebugControls(
    controls: TilePipelineDebugControls,
    overheadPercent: number,
  ): void {
    if (tileTopologySelectionChanged(this.debugControls, controls)) {
      // A user-requested density/cap change is a new selection baseline, not
      // camera jitter. Reusing the old z can otherwise let hysteresis swallow
      // a deliberate one-level coarsening or keep a removed cap sticky.
      this.desiredZoom = undefined;
    }
    this.debugControls = { ...controls };
    this.overheadPercent = overheadPercent;
    this.hotViewSignature = -1;
    this.warmViewSignature = -1;
    this.applyResidency();
  }

  getTargetZoom(): number {
    return this.target.maxZoom;
  }

  getPlannerState() {
    const payloadRequests = this.scheduler?.debugState ?? {
      transition_owned: { requested: 0, in_flight: 0, total_outstanding: 0 },
      residency_hydration: {
        requested: 0,
        in_flight: 0,
        total_outstanding: 0,
      },
      total: { requested: 0, in_flight: 0, total_outstanding: 0 },
      resident_payload_count: 0,
      demanded_payload_count: 0,
      target_submission: { pending: false, in_flight: false },
    };
    const provider = this.provider?.metrics;
    const metrics = this.getMetrics();
    return {
      recalculation_enabled: this.debugControls.recalculationEnabled,
      effective_target: { ...this.target },
      ...summarizeTilePlannerSnapshot(this.snapshot),
      payload_tile_requests: payloadRequests,
      source_jobs: {
        queued: provider?.queued ?? 0,
        in_flight: provider?.inFlight ?? 0,
      },
      residency: {
        hot_tile_count: this.hotKeys.size,
        classified_warm_tile_count: this.warmKeys.size,
        demanded_payload_tile_count:
          payloadRequests.demanded_payload_count,
        committed_topology_tile_count: this.snapshot.committedCut.length,
        view_distance_enabled: this.debugControls.viewDistanceEnabled,
        delta_zoom_cap: this.debugControls.deltaZoomCap,
      },
      imagery_uploads: {
        active_layer_count: metrics.activeLayerCount,
        migration_active: this.migration !== undefined,
        migration_layer_count: metrics.migrationLayerCount,
      },
    };
  }

  processPendingUploads(): void {
    this.processUploads();
  }

  getMetrics(): {
    committedLeafCount: number;
    hotTileCount: number;
    warmTileCount: number;
    recordCount: number;
    activeLayerCount: number;
    migrationLayerCount: number;
    requestTotal: number;
    sourceLoadTotal: number;
    decodeTotal: number;
    uploadTotal: number;
    estimatedCpuBytes: number;
    estimatedGpuBytes: number;
    residencyClassificationTotal: number;
    hotResidencyClassificationTotal: number;
    warmResidencyClassificationTotal: number;
  } {
    const provider = this.provider?.metrics;
    const mipBytesPerLayer = imageryMipDimensions(
      this.paddedSize,
      this.paddedSize,
    ).reduce((total, level) => total + level.width * level.height * 4, 0);
    return {
      committedLeafCount: this.snapshot.committedCut.length,
      hotTileCount: this.hotKeys.size,
      warmTileCount: this.warmKeys.size,
      recordCount: this.records.size,
      activeLayerCount: this.activePool.layers,
      migrationLayerCount: this.migration?.replacesActivePool
        ? this.migration.pool.layers
        : 0,
      requestTotal: provider?.requestTotal ?? 0,
      sourceLoadTotal: provider?.sourceLoadTotal ?? 0,
      decodeTotal: provider?.decodeTotal ?? 0,
      uploadTotal: this.uploadTotal,
      estimatedCpuBytes: this.records.size * mipBytesPerLayer,
      estimatedGpuBytes:
        (this.activePool.layers + (this.migration?.replacesActivePool
          ? this.migration.pool.layers
          : 0)) *
        mipBytesPerLayer,
      residencyClassificationTotal: this.residencyClassificationTotal,
      hotResidencyClassificationTotal: this.hotResidencyClassificationTotal,
      warmResidencyClassificationTotal: this.warmResidencyClassificationTotal,
    };
  }

  dispose(): void {
    this.unsubscribe?.();
    this.scheduler?.dispose();
    this.provider?.dispose();
    this.workerClient?.dispose();
    this.activeTreeTextures.nodes.dispose();
    this.activeTreeTextures.images.dispose();
    this.activePool.texture.dispose();
    if (this.migration?.replacesActivePool) {
      this.migration.pool.texture.dispose();
    }
    this.stagingTexture.dispose();
    this.records.clear();
  }

  private createTreeTextures(encoding: EncodedImageryTree): ImageryTreeTextures {
    const nodeWidth = Math.ceil(Math.sqrt(encoding.nodeCount));
    const nodeHeight = Math.ceil(encoding.nodeCount / nodeWidth);
    const nodeData = new Uint32Array(nodeWidth * nodeHeight * 2);
    nodeData.set(encoding.nodeData);
    const nodes = new THREE.DataTexture(
      nodeData,
      nodeWidth,
      nodeHeight,
      THREE.RGIntegerFormat,
      THREE.UnsignedIntType,
    );
    nodes.internalFormat = "RG32UI";
    const imageTexelCount = Math.max(1, encoding.imageCount);
    const imageWidth = Math.ceil(Math.sqrt(imageTexelCount));
    const imageHeight = Math.ceil(imageTexelCount / imageWidth);
    const imageData = new Uint32Array(imageWidth * imageHeight * 4);
    imageData.set(encoding.imageData);
    const images = new THREE.DataTexture(
      imageData,
      imageWidth,
      imageHeight,
      THREE.RGBAIntegerFormat,
      THREE.UnsignedIntType,
    );
    images.internalFormat = "RGBA32UI";
    for (const texture of [nodes, images]) {
      texture.colorSpace = THREE.NoColorSpace;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.flipY = false;
      texture.unpackAlignment = 1;
      texture.needsUpdate = true;
      this.renderer.initTexture(texture);
    }
    return { nodes, images, encoding, nodeWidth, imageWidth };
  }

  private createPool(layers: number): ImageryPool {
    const texture = new THREE.DataArrayTexture(
      null,
      this.paddedSize,
      this.paddedSize,
      layers,
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = false;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    texture.flipY = false;
    texture.unpackAlignment = 1;
    texture.mipmaps = imageryMipDimensions(
      this.paddedSize,
      this.paddedSize,
    ).map(({ width, height }) => ({
      data: new Uint8Array(0),
      width,
      height,
      depth: layers,
    }));
    texture.source.dataReady = false;
    texture.needsUpdate = true;
    this.renderer.initTexture(texture);
    return {
      generation: this.nextPoolGeneration++,
      texture,
      layers,
      slots: new Map(),
      uploadedRevisions: new Map(),
      freeSlots: Array.from({ length: layers }, (_, index) => layers - index - 1),
    };
  }

  private stage(resource: ImageryTileResource | undefined): void {
    if (!resource?.pixels || !resource.sourceTile) return;
    const key = imageryKey(resource.sourceTile);
    if (this.records.has(key)) return;
    const record: PageRecord = {
      sourceTile: resource.sourceTile,
      basePixels: resource.pixels,
      node: Object.freeze({ image: key }),
      revision: 0,
      mipRevision: 0,
    };
    this.records.set(key, record);
    this.stitchNeighbours(record);
  }

  private processUploads(): void {
    // A candidate generation is immutable once upload begins. Later scheduler
    // changes remain in desiredRoot and become the following generation.
    if (this.migration) {
      this.uploadPendingChains(
        this.migration,
        MAX_UPLOADS_PER_FRAME,
      );
      if (this.migrationComplete()) this.promoteMigration();
      this.pruneRecords();
      return;
    }

    const candidateRoot = this.readyCandidateRoot();
    const candidateKeys = imageryTreeSourceKeys(candidateRoot);
    const activeEncoding = this.encodeTreeForPool(
      candidateRoot,
      this.activePool,
    );

    if (activeEncoding) {
      if (candidateRoot !== this.committedRoot) {
        this.publishTree(
          candidateRoot,
          this.createTreeTextures(activeEncoding),
          this.activePool,
        );
      }
      this.pruneRecords();
      return;
    }

    this.startMigration(candidateRoot, candidateKeys);
    const migration = this.migration!;
    this.uploadPendingChains(
      migration,
      MAX_UPLOADS_PER_FRAME,
    );
    if (this.migrationComplete()) this.promoteMigration();
    this.pruneRecords();
  }

  private stitchNeighbours(record: PageRecord): void {
    const changed = new Set<PageRecord>([record]);
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
        if (!neighbour) continue;
        stitchSeparateImageryGutter(
          record.basePixels,
          neighbour.basePixels,
          this.tileSize,
          IMAGERY_GUTTER_PIXELS,
          offsetX as -1 | 0 | 1,
          offsetY as -1 | 0 | 1,
        );
        stitchSeparateImageryGutter(
          neighbour.basePixels,
          record.basePixels,
          this.tileSize,
          IMAGERY_GUTTER_PIXELS,
          -offsetX as -1 | 0 | 1,
          -offsetY as -1 | 0 | 1,
        );
        changed.add(neighbour);
      }
    }
    for (const changedRecord of changed) this.remip(changedRecord);
  }

  private remip(record: PageRecord): void {
    const key = imageryKey(record.sourceTile);
    const revision = ++record.revision;
    this.workerClient!.requestMip(
      key,
      revision,
      record.basePixels,
      this.paddedSize,
      this.paddedSize,
      (completedRevision, levels) => {
        if (record.revision !== completedRevision) return;
        record.mipRevision = completedRevision;
        record.mipLevels = levels.map((level, mip) =>
          mip === 0 ? { ...level, pixels: record.basePixels } : level,
        );
      },
      () => {
        // Mipping is deterministic CPU work. A later stitch or source retry
        // submits a fresh revision without exposing an incomplete chain.
      },
    );
  }

  private startMigration(
    root: ImageryTreeNode,
    demanded: Set<string>,
  ): void {
    const revisions = new Map<string, number>();
    for (const key of demanded) {
      revisions.set(key, this.records.get(key)?.revision ?? 0);
    }
    const retained = planImageryPoolMigration(
      this.activePool.slots,
      this.activePool.uploadedRevisions,
      demanded,
      revisions,
    );
    const replacesActivePool = retained.requiredAdditionalSlots >
      this.activePool.freeSlots.length;
    // DataArrayTexture storage cannot grow in place. Preserve the existing
    // capacity and add only the slots this candidate could not stage there.
    const pool = replacesActivePool
      ? this.createPool(imageryPoolGrowthCapacity(
          this.activePool.layers,
          Math.max(1, demanded.size),
          retained.requiredAdditionalSlots,
        ))
      : this.activePool;
    const slots = replacesActivePool
      ? new Map<string, number>()
      : retained.slots;
    const uploadedRevisions = replacesActivePool
      ? new Map<string, number>()
      : retained.uploadedRevisions;
    for (const key of demanded) {
      if (slots.has(key)) continue;
      const slot = pool.freeSlots.pop();
      if (slot === undefined) {
        if (replacesActivePool) pool.texture.dispose();
        throw new Error("The candidate imagery pool does not match its tree.");
      }
      slots.set(key, slot);
    }
    this.migration = {
      pool,
      root,
      demandedKeys: new Set(demanded),
      slots,
      uploadedRevisions,
      replacesActivePool,
    };
  }

  private uploadPendingChains(
    migration: PoolMigration,
    budget: number,
  ): number {
    const { pool, demandedKeys: demanded } = migration;
    let uploaded = 0;
    const visited = new Set<string>();
    const upload = (key: string): void => {
      if (uploaded >= budget || visited.has(key)) return;
      visited.add(key);
      const record = this.records.get(key);
      if (!record?.mipLevels || record.mipRevision === 0) return;
      if (record.mipRevision !== record.revision) return;
      let slot = migration.slots.get(key);
      if (slot === undefined) return;
      // A stitch may remip a retained page after this candidate started. Do
      // not overwrite the visible layer: give the candidate a fresh slot.
      if (
        !migration.replacesActivePool &&
        slot === pool.slots.get(key) &&
        (pool.uploadedRevisions.get(key) ?? 0) < record.mipRevision
      ) {
        const replacement = pool.freeSlots.pop();
        if (replacement === undefined) {
          this.restartMigration(migration);
          return;
        }
        slot = replacement;
        migration.slots.set(key, slot);
        migration.uploadedRevisions.delete(key);
      }
      if ((migration.uploadedRevisions.get(key) ?? 0) >= record.mipRevision) {
        return;
      }
      if (!this.uploadMipChain(pool, slot, record.mipLevels)) return;
      migration.uploadedRevisions.set(key, record.mipRevision);
      uploaded += 1;
    };
    for (const key of demanded) {
      upload(key);
      if (this.migration !== migration) return uploaded;
    }
    return uploaded;
  }

  private restartMigration(migration: PoolMigration): void {
    if (this.migration !== migration) return;
    if (migration.replacesActivePool) {
      migration.pool.texture.dispose();
    } else {
      migration.pool.freeSlots.length = 0;
      const activeSlots = new Set(migration.pool.slots.values());
      for (let slot = migration.pool.layers - 1; slot >= 0; slot -= 1) {
        if (!activeSlots.has(slot)) migration.pool.freeSlots.push(slot);
      }
    }
    this.migration = undefined;
    this.startMigration(migration.root, new Set(migration.demandedKeys));
  }

  private uploadMipChain(
    pool: ImageryPool,
    slot: number,
    levels: readonly ImageryMipLevel[],
  ): boolean {
    const uploads = imageryLayerUploadPlan(slot, this.paddedSize, levels);
    if (!uploads) return false;
    for (const upload of uploads) {
      this.stagingTexture.image.data = upload.pixels;
      this.stagingTexture.image.width = upload.width;
      this.stagingTexture.image.height = upload.height;
      this.renderer.copyTextureToTexture(
        this.stagingTexture,
        pool.texture,
        null,
        new THREE.Vector3(0, 0, upload.slot),
        0,
        upload.destinationMip,
      );
    }
    this.uploadTotal += 1;
    return true;
  }

  private applyResidency(): void {
    if (
      !this.scheduler ||
      !this.residencyInput ||
      (this.debugControls.viewDistanceEnabled &&
        this.residencyInput.footprint.length === 0) ||
      this.snapshot.committedCut.length === 0
    ) return;
    const hotSignature = hotResidencySignature(
      this.target.maxZoom,
      this.residencyInput,
    );
    const warmSignature = warmResidencySignature(
      this.target.maxZoom,
      this.residencyInput,
      this.overheadPercent,
    );
    const hotNeedsClassification =
      hotSignature !== this.hotViewSignature ||
      this.snapshot.revision !== this.hotRevision;
    const warmNeedsClassification =
      warmSignature !== this.warmViewSignature ||
      this.snapshot.revision !== this.warmRevision;
    if (!hotNeedsClassification && !warmNeedsClassification) return;
    this.hotViewSignature = hotSignature;
    this.hotRevision = this.snapshot.revision;
    this.warmViewSignature = warmSignature;
    this.warmRevision = this.snapshot.revision;
    this.residencyClassificationTotal += 1;
    if (hotNeedsClassification) this.hotResidencyClassificationTotal += 1;
    if (warmNeedsClassification) this.warmResidencyClassificationTotal += 1;
    const workingCut = new Map<string, TileIdentity>();
    for (const tile of [
      ...this.snapshot.committedCut,
      ...this.snapshot.requestedCut,
    ]) workingCut.set(tileIdentityKey(tile), tile);
    const workingTiles = [...workingCut.values()];
    if (hotNeedsClassification) {
      this.hotKeys = new Set(classifyHotResidency(
        workingTiles,
        this.residencyInput,
      ));
    }
    let warmChanged = false;
    if (warmNeedsClassification) {
      const eligible = eligiblePayloadTiles(
        workingTiles,
        this.target.maxZoom,
        this.debugControls.deltaZoomCap,
      );
      const warm = this.debugControls.viewDistanceEnabled
        ? classifyWarmResidency(
            eligible,
            this.residencyInput,
            this.warmKeys,
            this.overheadPercent,
          )
        : new Set(eligible.map((tile) => tileIdentityKey(tile)));
      warmChanged = !sameResidencyKeys(this.warmKeys, warm);
      this.warmKeys = new Set(warm);
    }
    const eligible = eligiblePayloadTiles(
      workingTiles,
      this.target.maxZoom,
      this.debugControls.deltaZoomCap,
    );
    const hot = eligible.filter((tile) =>
      this.hotKeys.has(tileIdentityKey(tile))
    );
    if (!warmChanged) {
      this.scheduler.updateResourcePriority(hot);
      return;
    }
    const demanded = demandedPayloadTiles(
      workingTiles,
      this.target.maxZoom,
      this.debugControls.deltaZoomCap,
      this.debugControls.viewDistanceEnabled,
      this.warmKeys,
    );
    this.scheduler.updateResourceDemand(demanded, hot);
  }

  private migrationComplete(): boolean {
    const migration = this.migration;
    if (!migration) return false;
    if (
      !imageryMigrationReady(
        migration.demandedKeys,
        migration.uploadedRevisions,
      )
    ) return false;
    for (const key of migration.demandedKeys) {
      const revision = this.records.get(key)?.revision;
      if (
        revision === undefined ||
        (migration.uploadedRevisions.get(key) ?? 0) < revision
      ) return false;
    }
    return true;
  }

  private promoteMigration(): void {
    const migration = this.migration;
    if (!migration) return;
    const encoding = this.encodeTreeForPool(
      migration.root,
      migration.pool,
      migration.slots,
      migration.uploadedRevisions,
    );
    if (!encoding) return;
    const textures = this.createTreeTextures(encoding);
    const previousPool = this.activePool;
    this.migration = undefined;
    migration.pool.slots.clear();
    migration.pool.uploadedRevisions.clear();
    for (const [key, slot] of migration.slots) {
      migration.pool.slots.set(key, slot);
    }
    for (const [key, revision] of migration.uploadedRevisions) {
      migration.pool.uploadedRevisions.set(key, revision);
    }
    migration.pool.freeSlots.length = 0;
    const retainedSlots = new Set(migration.slots.values());
    for (let slot = migration.pool.layers - 1; slot >= 0; slot -= 1) {
      if (!retainedSlots.has(slot)) migration.pool.freeSlots.push(slot);
    }
    this.publishTree(migration.root, textures, migration.pool);
    if (migration.replacesActivePool) previousPool.texture.dispose();
  }

  private refreshDesiredTree(): void {
    const keys = new Set<string>();
    this.desiredRoot = buildDesiredImageryTree(
      this.snapshot.committedCut,
      (tile) => {
        const resource = this.scheduler!.committedResource(tile);
        if (!resource?.sourceTile) {
          return {
            image: BLUE_MARBLE_IMAGERY_KEY,
            fallbackFromNotFound: true,
            evictCommitted: !this.warmKeys.has(tileIdentityKey(tile)),
          };
        }
        const image = imageryKey(resource.sourceTile);
        keys.add(image);
        return {
          image,
          fallbackFromNotFound: resource.fallbackFromNotFound === true,
        };
      },
    );
    this.desiredSourceKeySet = keys;
  }

  private readyCandidateRoot(): ImageryTreeNode {
    return reconcileImageryTree(
      this.committedRoot,
      this.desiredRoot,
      {
        isResident: (image) => {
          const record = this.records.get(image);
          return record?.mipLevels !== undefined &&
            record.mipRevision > 0 &&
            record.mipRevision === record.revision;
        },
        sourceZoom: (image) => this.records.get(image)?.sourceTile.z ?? -1,
        imageNode: (image) => this.records.get(image)!.node,
      },
    );
  }

  private encodeTreeForPool(
    root: ImageryTreeNode,
    pool: ImageryPool,
    slots = pool.slots,
    uploadedRevisions = pool.uploadedRevisions,
  ): EncodedImageryTree | undefined {
    return encodeImageryTree(
      root,
      pool.generation,
      (image) => {
        const record = this.records.get(image);
        const layer = slots.get(image);
        const revision = uploadedRevisions.get(image);
        if (
          !record ||
          layer === undefined ||
          revision === undefined ||
          revision < record.revision
        ) return undefined;
        return {
          poolGeneration: pool.generation,
          layer,
          revision,
          sourceTile: record.sourceTile,
        };
      },
    );
  }

  private publishTree(
    root: ImageryTreeNode,
    textures: ImageryTreeTextures,
    pool: ImageryPool,
  ): void {
    const previousTextures = this.activeTreeTextures;
    this.committedRoot = root;
    this.committedSourceKeys = imageryTreeSourceKeys(root);
    this.activeTreeTextures = textures;
    this.activePool = pool;
    this.sharedUniforms.imageryTree!.value = textures.nodes;
    this.sharedUniforms.imageryImages!.value = textures.images;
    this.sharedUniforms.imageryTilePool!.value = pool.texture;
    this.sharedUniforms.imageryTreeDepth!.value =
      textures.encoding.maximumDepth;
    this.sharedUniforms.imageryTreeTextureWidth!.value = textures.nodeWidth;
    this.sharedUniforms.imageryImageTextureWidth!.value = textures.imageWidth;
    this.sharedUniforms.imageryEnabled!.value = 1;
    previousTextures.nodes.dispose();
    previousTextures.images.dispose();
    this.releasePoolSlots(pool, this.committedSourceKeys);
    this.pruneRecords();
  }

  private releasePoolSlots(pool: ImageryPool, retained: Set<string>): void {
    for (const [key, slot] of pool.slots) {
      if (retained.has(key)) continue;
      pool.slots.delete(key);
      pool.uploadedRevisions.delete(key);
      pool.freeSlots.push(slot);
    }
  }

  private pruneRecords(): void {
    const retained = new Set([
      ...this.committedSourceKeys,
      ...this.desiredSourceKeySet,
      ...(this.migration?.demandedKeys ?? []),
    ]);
    if (this.scheduler) {
      for (const tile of this.snapshot.requestedCut) {
        const sourceTile = this.scheduler.committedResource(tile)?.sourceTile;
        if (sourceTile) retained.add(imageryKey(sourceTile));
      }
    }
    for (const key of this.records.keys()) {
      if (!retained.has(key)) this.records.delete(key);
    }
  }
}
