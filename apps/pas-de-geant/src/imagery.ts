import * as THREE from "three";
import {
  IMAGERY_MAX_STANDARD_CELLS,
  IMAGERY_PAGE_TABLE_SIZE,
  IMAGERY_ONION_OUTER_TILES,
  ImageryRequestTokenIndex,
  WEB_MERCATOR_MAX_LATITUDE,
  imageryKey,
  imageryOnionPlanForContact,
  isValidImageryAddress,
  renderedImageryTileWidthM,
  resolvePageEntry,
  selectImageryZoom,
  selectUnpinnedLruKey,
  wrapImageryX,
  wrapImageryPageX,
  type ImageryAddress,
  type ImageryLoadTask,
  type ImageryOnionPlan,
  type ImageryView,
} from "./imagery-core.js";
import {
  ImageryRequestError,
  type ImageryProvider,
} from "./imagery-provider.js";
export {
  configuredXyzImageryProvider,
  ImageryRequestError,
  XyzImageryProvider,
  type ImageryProvider,
  type XyzImageryConfiguration,
} from "./imagery-provider.js";

const IMAGERY_GUTTER_PIXELS = 8;
const IMAGERY_FINE_CAP_LAYERS = IMAGERY_ONION_OUTER_TILES ** 2;
const IMAGERY_POOL_REQUIRED_LAYERS =
  IMAGERY_MAX_STANDARD_CELLS + IMAGERY_FINE_CAP_LAYERS;
const MAX_CONCURRENT_IMAGERY_REQUESTS = 6;
const MAX_IMAGERY_UPLOADS_PER_FRAME = 2;
const IMAGERY_TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const IMAGERY_MALFORMED_RETRY_MS = 5 * 60_000;

export interface ImageryCoordinateBounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

interface ImageryRecord {
  address: ImageryAddress;
  status:
    | "absent"
    | "loading"
    | "decoded"
    | "resident"
    | "evicted"
    | "failed"
    | "permanent";
  failedAttempts: number;
  retryAtMs: number;
  pixels?: Uint8Array;
  slot?: number;
  usedAt: number;
}

interface ActiveRequest {
  controller: AbortController;
  token: number;
}

interface ImageryDiagnostics {
  requestTotal: number;
  abortTotal: number;
  failureTotal: number;
  malformedTotal: number;
  staleTotal: number;
  uploadTotal: number;
  commitTotal: number;
  gpuFailureTotal: number;
}

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
  const destinationX =
    offsetX < 0 ? 0 : offsetX > 0 ? gutter + tileSize : gutter;
  const destinationY =
    offsetY < 0 ? 0 : offsetY > 0 ? gutter + tileSize : gutter;
  const sourceX =
    offsetX < 0 ? tileSize : offsetX > 0 ? gutter : gutter;
  const sourceY =
    offsetY < 0 ? tileSize : offsetY > 0 ? gutter : gutter;
  const destinationLayerOffset = destinationLayer * layerBytes;
  const sourceLayerOffset = sourceLayer * layerBytes;
  const rowBytes = copyWidth * 4;
  for (let row = 0; row < copyHeight; row += 1) {
    const sourceOffset =
      sourceLayerOffset +
      ((sourceY + row) * paddedSize + sourceX) * 4;
    const destinationOffset =
      destinationLayerOffset +
      ((destinationY + row) * paddedSize + destinationX) * 4;
    pixels.set(
      pixels.subarray(sourceOffset, sourceOffset + rowBytes),
      destinationOffset,
    );
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function normalizedMercatorYForLatitude(
  latitudeDegrees: number,
): number {
  const latitude =
    (Math.max(
      -WEB_MERCATOR_MAX_LATITUDE,
      Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
    ) *
      Math.PI) /
    180;
  return (
    (1 -
      Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) /
    2
  );
}

export function imageryBoundsForGeographicBounds(bounds: {
  west: number;
  east: number;
  north: number;
  south: number;
}): ImageryCoordinateBounds {
  return {
    west: (bounds.west + 180) / 360,
    east: (bounds.east + 180) / 360,
    north: normalizedMercatorYForLatitude(bounds.north),
    south: normalizedMercatorYForLatitude(bounds.south),
  };
}

export function imageryBoundsForMercatorAddress(
  address: ImageryAddress,
): ImageryCoordinateBounds {
  const width = 2 ** address.z;
  return {
    west: address.x / width,
    east: (address.x + 1) / width,
    north: address.y / width,
    south: (address.y + 1) / width,
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
      floor(
        (imageryWrapX.y - pageCoordinate.x) / imageryWrapX.x + 0.5
      ) * imageryWrapX.x;
    return pageCoordinate;
  }

  vec3 resolvedImageryAlbedo() {
    if (imageryEnabled < 0.5) {
      return texture(blueMarbleMap, vBlueMarbleUv).rgb;
    }
    vec2 pageCoordinate = wrappedImageryPageCoordinate();
    vec2 pageCell = floor(pageCoordinate);
    if (
      pageCell.x < 0.0 ||
      pageCell.y < 0.0 ||
      pageCell.x >= imageryPageTableSize.x ||
      pageCell.y >= imageryPageTableSize.y
    ) {
      return texture(blueMarbleMap, vBlueMarbleUv).rgb;
    }
    vec2 pageUv = (pageCell + 0.5) / imageryPageTableSize;
    vec4 encoded = texture(imageryPageTable, pageUv);
    float layerCode = encoded.r;
    if (layerCode < 0.5) {
      return texture(blueMarbleMap, vBlueMarbleUv).rgb;
    }
    float ancestorScale = encoded.g;
    vec2 childOffset = encoded.ba;
    vec2 targetUv = fract(pageCoordinate);
    vec2 sourceUv = (childOffset + targetUv) / ancestorScale;
    float tileSize = imageryPoolLayout.x;
    float gutter = imageryPoolLayout.y;
    float paddedSize = imageryPoolLayout.z;
    vec2 poolUv = (vec2(gutter) + sourceUv * tileSize) / paddedSize;
    vec2 pageDx = dFdx(vImageryUv * imageryCoordOriginScale.zw);
    vec2 pageDy = dFdy(vImageryUv * imageryCoordOriginScale.zw);
    vec2 poolDx = pageDx * tileSize / (ancestorScale * paddedSize);
    vec2 poolDy = pageDy * tileSize / (ancestorScale * paddedSize);
    float footprint =
      max(length(poolDx), length(poolDy)) * paddedSize;
    float supportedFootprint = max(1.0, gutter * 2.0);
    float gradientScale =
      min(1.0, supportedFootprint / max(footprint, 0.000001));
    return textureGrad(
      imageryTilePool,
      vec3(poolUv, layerCode - 1.0),
      poolDx * gradientScale,
      poolDy * gradientScale
    ).rgb;
  }

  vec4 resolvedImageryTileOverlay() {
    if (imageryEnabled < 0.5) return vec4(0.0);
    vec2 pageCoordinate = wrappedImageryPageCoordinate();
    vec2 pageCell = floor(pageCoordinate);
    if (
      pageCell.x < 0.0 ||
      pageCell.y < 0.0 ||
      pageCell.x >= imageryPageTableSize.x ||
      pageCell.y >= imageryPageTableSize.y
    ) return vec4(0.0);
    vec4 encoded = texture(
      imageryPageTable,
      (pageCell + 0.5) / imageryPageTableSize
    );
    float layerCode = encoded.r;
    if (layerCode < 0.5) return vec4(0.0);
    float ancestorScale = encoded.g;
    vec2 childOffset = encoded.ba;
    vec2 tileUv =
      (childOffset + fract(pageCoordinate)) / ancestorScale;
    vec2 distanceToEdge = min(tileUv, 1.0 - tileUv);
    float edgeDistance = min(distanceToEdge.x, distanceToEdge.y);
    float tileEdge = 1.0 - smoothstep(
      0.0,
      max(0.0005, fwidth(edgeDistance) * 2.5),
      edgeDistance
    );
    vec3 overlayColour =
      ancestorScale < 1.5
        ? vec3(0.0, 0.843, 1.0)
        : ancestorScale < 3.0
          ? vec3(1.0, 0.741, 0.247)
          : vec3(1.0, 0.369, 0.659);
    return vec4(overlayColour, mix(0.18, 0.92, tileEdge));
  }
`;

export interface ImageryUpdateOptions extends ImageryView {
  nowMs?: number;
}

export class ImageryVirtualTexture {
  private readonly pageTables: [THREE.DataTexture, THREE.DataTexture];
  private readonly sharedUniforms: Record<string, THREE.IUniform>;
  private readonly records = new Map<string, ImageryRecord>();
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private readonly wanted = new Map<string, ImageryLoadTask>();
  private readonly visibleKeys = new Set<string>();
  private readonly freeSlots: number[] = [];
  private readonly diagnostics: ImageryDiagnostics = {
    requestTotal: 0,
    abortTotal: 0,
    failureTotal: 0,
    malformedTotal: 0,
    staleTotal: 0,
    uploadTotal: 0,
    commitTotal: 0,
    gpuFailureTotal: 0,
  };
  private poolTexture: THREE.DataArrayTexture;
  private poolPixels: Uint8Array;
  private poolLayers = 1;
  private activePageTable = 0;
  private visiblePlan: ImageryOnionPlan | undefined;
  private candidatePlan: ImageryOnionPlan | undefined;
  private desiredZoom: number | undefined;
  private visibleGroup = -1;
  private renderedTileWidthM = 0;
  private sourceTexelWidthM = 0;
  private mappedCellCount = 0;
  private mappingSignature = "";
  private pageTableEpoch = 0;
  private sequence = 0;
  private readonly requestTokens = new ImageryRequestTokenIndex();
  private poolUnavailable = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    blueMarbleTexture: THREE.Texture,
    readonly provider?: ImageryProvider,
  ) {
    this.pageTables = [
      this.createPageTable(),
      this.createPageTable(),
    ];
    this.poolPixels = new Uint8Array(4);
    this.poolTexture = this.createPoolTexture(this.poolPixels, 1, 1);
    this.sharedUniforms = {
      blueMarbleMap: new THREE.Uniform(blueMarbleTexture),
      imageryPageTable: new THREE.Uniform(this.pageTables[0]),
      imageryTilePool: new THREE.Uniform(this.poolTexture),
      imageryEnabled: new THREE.Uniform(0),
      imageryPageTableSize: new THREE.Uniform(
        new THREE.Vector2(IMAGERY_PAGE_TABLE_SIZE, IMAGERY_PAGE_TABLE_SIZE),
      ),
      imageryPoolLayout: new THREE.Uniform(new THREE.Vector3(1, 0, 1)),
    };
    this.renderer.initTexture(this.pageTables[0]);
    this.renderer.initTexture(this.pageTables[1]);
    this.renderer.initTexture(this.poolTexture);
    this.updateDiagnostics();
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
    const value = material.uniforms.imageryCoordOriginScale
      ?.value as THREE.Vector4 | undefined;
    const wrap = material.uniforms.imageryWrapX
      ?.value as THREE.Vector2 | undefined;
    const plan = this.visiblePlan;
    if (!value || !wrap || !plan) {
      value?.set(0, 0, 0, 0);
      wrap?.set(1, 0);
      return;
    }
    const worldWidth = 2 ** plan.finestZoom;
    const west = wrapImageryPageX(
      bounds.west * worldWidth,
      plan.tableReferenceX,
      worldWidth,
    );
    value.set(
      west - plan.tableOriginX,
      bounds.north * worldWidth - plan.tableOriginY,
      (bounds.east - bounds.west) * worldWidth,
      (bounds.south - bounds.north) * worldWidth,
    );
    wrap.set(
      worldWidth,
      plan.tableReferenceX - plan.tableOriginX,
    );
  }

  update(options: ImageryUpdateOptions): void {
    const nowMs = options.nowMs ?? Date.now();
    if (
      this.provider &&
      Math.abs(options.latitudeDegrees) <= WEB_MERCATOR_MAX_LATITUDE
    ) {
      this.ensurePool();
      if (this.poolUnavailable) {
        this.clearPlan();
        this.updateDiagnostics();
        return;
      }
      const desiredZoom = selectImageryZoom({
        displayRadiusM: options.displayRadiusM,
        latitudeDegrees: options.latitudeDegrees,
        minZoom: this.provider.minZoom,
        maxZoom: this.provider.maxZoom,
        previousZoom: this.desiredZoom,
      });
      this.renderedTileWidthM = renderedImageryTileWidthM(
        options.latitudeDegrees,
        options.displayRadiusM,
        desiredZoom,
      );
      const nextPlan = imageryOnionPlanForContact(
        options.latitudeDegrees,
        options.longitudeDegrees,
        desiredZoom,
        this.provider.minZoom,
        this.provider.maxZoom,
      );
      this.sourceTexelWidthM =
        renderedImageryTileWidthM(
          options.latitudeDegrees,
          options.displayRadiusM,
          Math.min(desiredZoom, this.provider.maxZoom),
        ) / this.provider.tileSize;
      if (
        this.candidatePlan &&
        nextPlan.signature === this.visiblePlan?.signature
      ) {
        this.cancelCandidate();
      } else if (
        nextPlan.signature !== this.candidatePlan?.signature &&
        nextPlan.signature !== this.visiblePlan?.signature
      ) {
        this.applyPlan(nextPlan);
      }
      this.desiredZoom = desiredZoom;
    } else {
      this.clearPlan();
    }
    this.uploadDecodedTiles();
    this.commitCandidateIfReady();
    if (!this.candidatePlan) {
      this.advanceVisibleGroups();
      this.refreshVisibleMapping();
    }
    this.pumpRequests(nowMs);
    this.updateDiagnostics();
  }

  dispose(): void {
    for (const request of this.activeRequests.values()) {
      request.controller.abort();
    }
    this.activeRequests.clear();
    this.wanted.clear();
    this.pageTables[0].dispose();
    this.pageTables[1].dispose();
    this.poolTexture.dispose();
    this.records.clear();
    this.visibleKeys.clear();
  }

  private createPageTable(): THREE.DataTexture {
    const texture = new THREE.DataTexture(
      new Float32Array(IMAGERY_PAGE_TABLE_SIZE * IMAGERY_PAGE_TABLE_SIZE * 4),
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
    paddedSize: number,
    layers: number,
  ): THREE.DataArrayTexture {
    const texture = new THREE.DataArrayTexture(
      pixels,
      paddedSize,
      paddedSize,
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

  private ensurePool(): void {
    if (
      !this.provider ||
      this.poolLayers > 1 ||
      this.poolUnavailable
    ) {
      return;
    }
    const context = this.renderer.getContext() as WebGL2RenderingContext;
    const maximumLayers = Number(
      context.getParameter(context.MAX_ARRAY_TEXTURE_LAYERS),
    );
    if (maximumLayers < IMAGERY_POOL_REQUIRED_LAYERS) {
      this.poolUnavailable = true;
      this.diagnostics.gpuFailureTotal += 1;
      return;
    }
    const paddedSize =
      this.provider.tileSize + IMAGERY_GUTTER_PIXELS * 2;
    const layerBytes = paddedSize * paddedSize * 4;
    this.poolLayers = IMAGERY_POOL_REQUIRED_LAYERS;
    this.poolPixels = new Uint8Array(
      layerBytes * this.poolLayers,
    );
    const previous = this.poolTexture;
    this.poolTexture = this.createPoolTexture(
      this.poolPixels,
      paddedSize,
      this.poolLayers,
    );
    context.getError();
    this.renderer.initTexture(this.poolTexture);
    if (context.getError() !== context.NO_ERROR) {
      this.poolTexture.dispose();
      this.poolTexture = previous;
      this.poolPixels = new Uint8Array(4);
      this.poolLayers = 1;
      this.poolUnavailable = true;
      this.diagnostics.gpuFailureTotal += 1;
      return;
    }
    this.sharedUniforms.imageryTilePool!.value = this.poolTexture;
    (
      this.sharedUniforms.imageryPoolLayout!.value as THREE.Vector3
    ).set(
      this.provider.tileSize,
      IMAGERY_GUTTER_PIXELS,
      paddedSize,
    );
    previous.dispose();
    this.freeSlots.length = 0;
    for (let slot = this.poolLayers - 1; slot >= 0; slot -= 1) {
      this.freeSlots.push(slot);
    }
  }

  private applyPlan(plan: ImageryOnionPlan): void {
    this.candidatePlan = plan;
    this.syncWanted();
    this.cancelUnwantedRequests();
    this.discardUnwantedDecoded();
  }

  private cancelCandidate(): void {
    this.candidatePlan = undefined;
    this.syncWanted();
    this.cancelUnwantedRequests();
    this.discardUnwantedDecoded();
  }

  private cancelUnwantedRequests(): void {
    for (const [key, request] of this.activeRequests) {
      if (this.wanted.has(key)) continue;
      this.activeRequests.delete(key);
      this.requestTokens.cancel(key);
      const record = this.records.get(key);
      if (record?.status === "loading") record.status = "absent";
      request.controller.abort();
    }
  }

  private discardUnwantedDecoded(): void {
    for (const [key, record] of this.records) {
      if (record.status === "evicted" && this.wanted.has(key)) {
        record.status = "absent";
      }
      if (record.status === "decoded") {
        if (!this.wanted.has(key)) {
          record.status = "absent";
          record.pixels = undefined;
        }
      }
    }
  }

  private clearPlan(): void {
    if (
      !this.visiblePlan &&
      !this.candidatePlan &&
      this.wanted.size === 0 &&
      Number(this.sharedUniforms.imageryEnabled!.value) === 0
    ) {
      this.desiredZoom = undefined;
      return;
    }
    this.visiblePlan = undefined;
    this.candidatePlan = undefined;
    this.desiredZoom = undefined;
    this.visibleGroup = -1;
    this.renderedTileWidthM = 0;
    this.sourceTexelWidthM = 0;
    this.mappedCellCount = 0;
    this.wanted.clear();
    for (const [key, request] of this.activeRequests) {
      this.activeRequests.delete(key);
      this.requestTokens.cancel(key);
      const record = this.records.get(key);
      if (record?.status === "loading") record.status = "absent";
      request.controller.abort();
    }
    this.sharedUniforms.imageryEnabled!.value = 0;
    this.visibleKeys.clear();
    this.mappingSignature = "";
  }

  private syncWanted(): void {
    this.wanted.clear();
    for (const task of this.visiblePlan?.tasks ?? []) {
      this.wanted.set(imageryKey(task.address), task);
    }
    for (const task of (this.candidatePlan?.tasks ?? []).filter(
      (candidate) => candidate.group === 0,
    )) {
      this.wanted.set(imageryKey(task.address), task);
    }
  }

  private pinnedKeys(): Set<string> {
    return new Set([
      ...(this.visiblePlan?.tasks ?? []).map((task) =>
        imageryKey(task.address)
      ),
      ...(this.candidatePlan?.tasks ?? [])
        .filter((task) => task.group === 0)
        .map((task) => imageryKey(task.address)),
    ]);
  }

  private pumpRequests(nowMs = Date.now()): void {
    if (
      !this.provider ||
      (!this.visiblePlan && !this.candidatePlan)
    ) {
      return;
    }
    while (this.activeRequests.size < MAX_CONCURRENT_IMAGERY_REQUESTS) {
      const next = [...this.wanted.entries()]
        .filter(([key]) => {
          if (this.activeRequests.has(key)) return false;
          const record = this.records.get(key);
          return (
            !record ||
            record.status === "absent" ||
            (record.status === "failed" && record.retryAtMs <= nowMs)
          );
        })
        .sort(
          (first, second) =>
            first[1].priority - second[1].priority ||
            first[0].localeCompare(second[0]),
        )[0];
      if (!next) return;
      const [key, task] = next;
      const controller = new AbortController();
      const token = this.requestTokens.begin(key);
      const existing = this.records.get(key);
      const record: ImageryRecord = existing ?? {
        address: task.address,
        status: "absent",
        failedAttempts: 0,
        retryAtMs: 0,
        usedAt: 0,
      };
      record.status = "loading";
      this.records.set(key, record);
      this.activeRequests.set(key, { controller, token });
      this.diagnostics.requestTotal += 1;
      void this.loadTile(task, controller.signal, token)
        .catch((error: unknown) =>
          this.handleLoadFailure(key, record, error, token),
        )
        .finally(() => {
          const active = this.activeRequests.get(key);
          if (
            active?.token === token &&
            this.requestTokens.complete(key, token)
          ) {
            this.activeRequests.delete(key);
          }
          this.pumpRequests();
        });
    }
  }

  private async loadTile(
    task: ImageryLoadTask,
    signal: AbortSignal,
    token: number,
  ): Promise<void> {
    if (!this.provider) return;
    const key = imageryKey(task.address);
    const blob = await this.provider.load(task.address, signal);
    const pixels = await decodeImageryTile(
      blob,
      this.provider.tileSize,
      this.provider.tileSize,
      IMAGERY_GUTTER_PIXELS,
      signal,
    );
    const active = this.activeRequests.get(key);
    if (
      signal.aborted ||
      active?.token !== token ||
      !this.requestTokens.isCurrent(key, token) ||
      !this.wanted.has(key)
    ) {
      this.diagnostics.staleTotal += 1;
      return;
    }
    const record = this.records.get(key);
    if (!record) {
      this.diagnostics.staleTotal += 1;
      return;
    }
    record.status = "decoded";
    record.pixels = pixels;
    record.failedAttempts = 0;
    record.retryAtMs = 0;
  }

  private handleLoadFailure(
    key: string,
    record: ImageryRecord,
    error: unknown,
    token: number,
  ): void {
    const active = this.activeRequests.get(key);
    const requestIsCurrent =
      active?.token === token && this.requestTokens.isCurrent(key, token);
    if (isAbortError(error)) {
      this.diagnostics.abortTotal += 1;
      if (!requestIsCurrent || !this.wanted.has(key)) {
        this.diagnostics.staleTotal += 1;
      }
      if (requestIsCurrent && record.status === "loading") {
        record.status = "absent";
      }
      return;
    }
    if (!requestIsCurrent || !this.wanted.has(key)) {
      this.diagnostics.staleTotal += 1;
      return;
    }
    this.diagnostics.failureTotal += 1;
    const requestError =
      error instanceof ImageryRequestError
        ? error
        : new ImageryRequestError(
            error instanceof Error ? error.message : "Imagery request failed.",
            "transient",
          );
    if (requestError.kind === "not-found") {
      record.status = "permanent";
      record.retryAtMs = Infinity;
      return;
    }
    record.status = "failed";
    record.failedAttempts += 1;
    if (requestError.kind === "malformed") {
      this.diagnostics.malformedTotal += 1;
      record.retryAtMs = Date.now() + IMAGERY_MALFORMED_RETRY_MS;
    } else {
      const delay =
        IMAGERY_TRANSIENT_RETRY_DELAYS_MS[
          Math.min(
            record.failedAttempts - 1,
            IMAGERY_TRANSIENT_RETRY_DELAYS_MS.length - 1,
          )
        ]!;
      record.retryAtMs = Date.now() + delay;
    }
  }

  private stitchStagedGutters(
    staged: ReadonlyArray<{
      key: string;
      record: ImageryRecord;
      slot: number;
    }>,
  ): Set<number> {
    if (!this.provider) return new Set();
    const available = new Map<
      string,
      { address: ImageryAddress; slot: number }
    >();
    for (const [key, record] of this.records) {
      if (record.status === "resident" && record.slot !== undefined) {
        available.set(key, { address: record.address, slot: record.slot });
      }
    }
    for (const { key, record, slot } of staged) {
      available.set(key, { address: record.address, slot });
    }

    const affected = new Map<
      string,
      { address: ImageryAddress; slot: number }
    >();
    for (const { key, record, slot } of staged) {
      affected.set(key, { address: record.address, slot });
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const neighbor = available.get(
            imageryKey({
              z: record.address.z,
              x: wrapImageryX(
                record.address.x + offsetX,
                record.address.z,
              ),
              y: record.address.y + offsetY,
            }),
          );
          if (neighbor) {
            affected.set(imageryKey(neighbor.address), neighbor);
          }
        }
      }
    }

    const touchedSlots = new Set<number>();
    for (const destination of affected.values()) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const source = available.get(
            imageryKey({
              z: destination.address.z,
              x: wrapImageryX(
                destination.address.x + offsetX,
                destination.address.z,
              ),
              y: destination.address.y + offsetY,
            }),
          );
          if (!source) continue;
          stitchImageryGutter(
            this.poolPixels,
            this.provider.tileSize,
            IMAGERY_GUTTER_PIXELS,
            destination.slot,
            source.slot,
            offsetX as -1 | 0 | 1,
            offsetY as -1 | 0 | 1,
          );
          touchedSlots.add(destination.slot);
        }
      }
    }
    return touchedSlots;
  }

  private uploadDecodedTiles(): void {
    if (!this.provider || this.poolLayers <= 1) return;
    const decoded = [...this.records.entries()]
      .filter(
        ([key, record]) =>
          record.status === "decoded" &&
          this.wanted.has(key) &&
          record.pixels,
      )
      .sort((first, second) => {
        const firstTask = this.wanted.get(first[0]);
        const secondTask = this.wanted.get(second[0]);
        return (
          (firstTask?.priority ?? Infinity) -
            (secondTask?.priority ?? Infinity) ||
          first[0].localeCompare(second[0])
        );
      })
      .slice(0, MAX_IMAGERY_UPLOADS_PER_FRAME);
    if (decoded.length === 0) return;
    const staged: Array<{
      key: string;
      record: ImageryRecord;
      slot: number;
    }> = [];
    const layerBytes =
      (this.provider.tileSize + IMAGERY_GUTTER_PIXELS * 2) ** 2 * 4;
    for (const [key, record] of decoded) {
      const slot = this.allocateSlot();
      if (slot === undefined || !record.pixels) break;
      this.poolPixels.set(record.pixels, slot * layerBytes);
      staged.push({ key, record, slot });
    }
    if (staged.length > 0) {
      const touchedSlots = this.stitchStagedGutters(staged);
      for (const { slot } of staged) touchedSlots.add(slot);
      for (const slot of touchedSlots) {
        this.poolTexture.addLayerUpdate(slot);
      }
      this.poolTexture.needsUpdate = true;
      const context = this.renderer.getContext();
      context.getError();
      this.renderer.initTexture(this.poolTexture);
      if (context.getError() !== context.NO_ERROR) {
        this.diagnostics.gpuFailureTotal += 1;
        for (const { record, slot } of staged) {
          record.pixels = undefined;
          record.slot = undefined;
          record.status = "failed";
          record.retryAtMs = Date.now() + IMAGERY_MALFORMED_RETRY_MS;
          this.freeSlots.push(slot);
        }
        return;
      }
      for (const { record, slot } of staged) {
        record.pixels = undefined;
        record.slot = slot;
        record.status = "resident";
        record.usedAt = ++this.sequence;
        this.diagnostics.uploadTotal += 1;
      }
    }
  }

  private allocateSlot(): number | undefined {
    const free = this.freeSlots.pop();
    if (free !== undefined) return free;
    const pinned = this.pinnedKeys();
    const candidateKey = selectUnpinnedLruKey(
      [...this.records.entries()]
        .filter(
          ([, record]) =>
            record.status === "resident" && record.slot !== undefined,
        )
        .map(([key, record]) => ({
          key,
          usedAt: record.usedAt,
          pinned: pinned.has(key),
        })),
    );
    if (!candidateKey) return undefined;
    const record = this.records.get(candidateKey)!;
    const slot = record.slot;
    record.slot = undefined;
    record.status = "evicted";
    return slot;
  }

  private taskTerminal(task: ImageryLoadTask): boolean {
    const status = this.records.get(imageryKey(task.address))?.status;
    return (
      status === "resident" ||
      status === "permanent" ||
      status === "failed"
    );
  }

  private groupReady(plan: ImageryOnionPlan, group: number): boolean {
    const tasks = plan.tasks.filter((task) => task.group === group);
    return tasks.length === 0 || tasks.every((task) => this.taskTerminal(task));
  }

  private candidateReady(): boolean {
    return Boolean(
      this.candidatePlan && this.groupReady(this.candidatePlan, 0),
    );
  }

  private commitCandidateIfReady(): void {
    if (!this.candidatePlan || !this.candidateReady()) return;
    if (!this.commitMapping(this.candidatePlan, 0, true)) return;
    this.visiblePlan = this.candidatePlan;
    this.visibleGroup = 0;
    this.candidatePlan = undefined;
    this.syncWanted();
    this.cancelUnwantedRequests();
    this.discardUnwantedDecoded();
  }

  private advanceVisibleGroups(): void {
    if (!this.visiblePlan) return;
    while (
      this.visibleGroup + 1 < this.visiblePlan.groupCount &&
      this.groupReady(this.visiblePlan, this.visibleGroup + 1)
    ) {
      const nextGroup = this.visibleGroup + 1;
      if (!this.commitMapping(this.visiblePlan, nextGroup, true)) return;
      this.visibleGroup = nextGroup;
    }
  }

  private refreshVisibleMapping(): void {
    if (!this.visiblePlan) return;
    this.commitMapping(this.visiblePlan, this.visibleGroup, false);
  }

  private commitMapping(
    plan: ImageryOnionPlan,
    maximumGroup: number,
    force: boolean,
  ): boolean {
    const entries = new Float32Array(
      IMAGERY_PAGE_TABLE_SIZE * IMAGERY_PAGE_TABLE_SIZE * 4,
    );
    const nextVisibleKeys = new Set<string>();
    for (const cell of plan.cells) {
      if (cell.group > maximumGroup) continue;
      const sourceAddress = cell.sourceAddress ?? cell.address;
      const record = this.records.get(imageryKey(sourceAddress));
      if (record?.status !== "resident" || record.slot === undefined) continue;
      for (let childY = 0; childY < cell.tableSpan; childY += 1) {
        for (let childX = 0; childX < cell.tableSpan; childX += 1) {
          const tableX = cell.tableX + childX;
          const tableY = cell.tableY + childY;
          if (
            tableX < 0 ||
            tableY < 0 ||
            tableX >= IMAGERY_PAGE_TABLE_SIZE ||
            tableY >= IMAGERY_PAGE_TABLE_SIZE
          ) {
            continue;
          }
          const index =
            (tableY * IMAGERY_PAGE_TABLE_SIZE + tableX) * 4;
          if (entries[index] !== 0) continue;
          const targetAddress = {
            z: plan.finestZoom,
            x: wrapImageryPageX(
              cell.address.x * cell.tableSpan + childX,
              plan.tableReferenceX,
              2 ** plan.finestZoom,
            ),
            y: cell.address.y * cell.tableSpan + childY,
          };
          targetAddress.x = ((targetAddress.x % 2 ** plan.finestZoom) +
            2 ** plan.finestZoom) % 2 ** plan.finestZoom;
          const resolved = resolvePageEntry(
            targetAddress,
            sourceAddress,
            record.slot,
          );
          entries[index] = resolved.layer + 1;
          entries[index + 1] = resolved.scale;
          entries[index + 2] = resolved.offsetX;
          entries[index + 3] = resolved.offsetY;
        }
      }
      record.usedAt = ++this.sequence;
      nextVisibleKeys.add(imageryKey(sourceAddress));
    }
    const visibleEntries = entries.reduce(
      (count, value, index) =>
        index % 4 === 0 && value > 0
          ? count + 1
          : count,
      0,
    );
    const signature = `${plan.signature}:${maximumGroup}:${visibleEntries}:${Array.from(
      entries,
    ).join(",")}`;
    if (!force && signature === this.mappingSignature) {
      this.sharedUniforms.imageryEnabled!.value = 1;
      return true;
    }
    const stagingIndex = this.activePageTable === 0 ? 1 : 0;
    const staging = this.pageTables[stagingIndex];
    const stagingData = staging.image.data as Float32Array;
    stagingData.set(entries);
    staging.needsUpdate = true;
    const context = this.renderer.getContext();
    context.getError();
    this.renderer.initTexture(staging);
    if (context.getError() !== context.NO_ERROR) {
      this.diagnostics.gpuFailureTotal += 1;
      return false;
    }
    this.activePageTable = stagingIndex;
    this.sharedUniforms.imageryPageTable!.value = staging;
    this.sharedUniforms.imageryEnabled!.value = 1;
    this.visibleKeys.clear();
    for (const key of nextVisibleKeys) this.visibleKeys.add(key);
    this.mappingSignature = signature;
    this.mappedCellCount = visibleEntries;
    this.pageTableEpoch += 1;
    this.diagnostics.commitTotal += 1;
    return true;
  }

  private updateDiagnostics(): void {
    if (typeof document === "undefined") return;
    const resident = [...this.records.values()].filter(
      (record) => record.status === "resident",
    ).length;
    const decoded = [...this.records.values()].filter(
      (record) => record.status === "decoded",
    ).length;
    const permanent = [...this.records.values()].filter(
      (record) => record.status === "permanent",
    ).length;
    document.body.dataset.imageryProvider = this.provider?.id ?? "none";
    document.body.dataset.imageryActivation = !this.provider
      ? "inactive"
      : this.visiblePlan
        ? "active"
        : "prefetching";
    document.body.dataset.imageryRefinement = this.candidatePlan
      ? "prefetching"
      : this.visiblePlan
        ? "active"
        : "inactive";
    document.body.dataset.imageryDesiredZoom =
      this.desiredZoom === undefined ? "" : String(this.desiredZoom);
    document.body.dataset.imageryVisibleZoom =
      this.visiblePlan === undefined
        ? ""
        : String(this.visiblePlan.finestZoom);
    document.body.dataset.imageryRenderedTileWidth =
      this.desiredZoom === undefined
        ? ""
        : this.renderedTileWidthM.toFixed(3);
    document.body.dataset.imageryCentimetresPerTexel =
      this.desiredZoom === undefined
        ? ""
        : (this.sourceTexelWidthM * 100).toFixed(3);
    document.body.dataset.imagerySourceZoom =
      this.desiredZoom === undefined
        ? ""
        : String(Math.min(this.desiredZoom, this.provider!.maxZoom));
    document.body.dataset.imageryVisibleGroup =
      this.visiblePlan === undefined ? "" : String(this.visibleGroup);
    document.body.dataset.imageryPlanMode =
      this.visiblePlan?.mode ?? "";
    document.body.dataset.imageryMappedCells = String(this.mappedCellCount);
    document.body.dataset.imageryFallbackCells = String(
      Math.max(
        0,
        (this.visiblePlan?.tableSpan ?? 0) ** 2 - this.mappedCellCount,
      ),
    );
    document.body.dataset.imageryWindow =
      this.visiblePlan?.signature ?? "";
    document.body.dataset.imageryVisiblePlan =
      this.visiblePlan?.signature ?? "";
    document.body.dataset.imageryCandidatePlan =
      this.candidatePlan?.signature ?? "";
    document.body.dataset.imageryRequests = String(
      this.activeRequests.size,
    );
    document.body.dataset.imageryRequestTotal = String(
      this.diagnostics.requestTotal,
    );
    document.body.dataset.imageryAbortTotal = String(
      this.diagnostics.abortTotal,
    );
    document.body.dataset.imageryFailureTotal = String(
      this.diagnostics.failureTotal,
    );
    document.body.dataset.imageryMalformedTotal = String(
      this.diagnostics.malformedTotal,
    );
    document.body.dataset.imageryStaleTotal = String(
      this.diagnostics.staleTotal,
    );
    document.body.dataset.imageryResident = String(resident);
    document.body.dataset.imageryDecoded = String(decoded);
    document.body.dataset.imageryPermanentFailures = String(permanent);
    document.body.dataset.imageryVisibleSources = String(
      this.visibleKeys.size,
    );
    document.body.dataset.imageryVisibleExact = String(
      [...this.visibleKeys].filter((key) => {
        const record = this.records.get(key);
        return record?.address.z === this.visiblePlan?.finestZoom;
      }).length,
    );
    document.body.dataset.imageryUploadTotal = String(
      this.diagnostics.uploadTotal,
    );
    document.body.dataset.imageryCommitTotal = String(
      this.diagnostics.commitTotal,
    );
    document.body.dataset.imageryGpuFailureTotal = String(
      this.diagnostics.gpuFailureTotal,
    );
    document.body.dataset.imageryPageTableEpoch = String(this.pageTableEpoch);
    document.body.dataset.imageryPoolLayers = String(this.poolLayers);
    document.body.dataset.imageryWindowSize = String(
      IMAGERY_PAGE_TABLE_SIZE,
    );
    document.body.dataset.imageryPinnedPages = String(
      this.pinnedKeys().size,
    );
    document.body.dataset.imageryTransitionCount = String(
      this.diagnostics.commitTotal,
    );
  }
}

async function decodeImageryTile(
  blob: Blob,
  sourceTileSize: number,
  gpuPageSize: number,
  gutter: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new ImageryRequestError(
      "The imagery tile could not be decoded.",
      "malformed",
    );
  }
  try {
    if (signal.aborted) {
      throw new DOMException("The imagery request was aborted.", "AbortError");
    }
    if (
      bitmap.width !== sourceTileSize ||
      bitmap.height !== sourceTileSize
    ) {
      throw new ImageryRequestError(
        `The imagery tile must be ${sourceTileSize} × ${sourceTileSize} pixels.`,
        "malformed",
      );
    }
    const paddedSize = gpuPageSize + gutter * 2;
    const canvas = document.createElement("canvas");
    canvas.width = paddedSize;
    canvas.height = paddedSize;
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!context) {
      throw new ImageryRequestError(
        "A canvas could not stage the imagery tile.",
        "malformed",
      );
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      0,
      0,
      sourceTileSize,
      sourceTileSize,
      gutter,
      gutter,
      gpuPageSize,
      gpuPageSize,
    );
    context.drawImage(
      bitmap,
      0,
      0,
      sourceTileSize,
      1,
      gutter,
      0,
      gpuPageSize,
      gutter,
    );
    context.drawImage(
      bitmap,
      0,
      sourceTileSize - 1,
      sourceTileSize,
      1,
      gutter,
      gutter + gpuPageSize,
      gpuPageSize,
      gutter,
    );
    context.drawImage(
      bitmap,
      0,
      0,
      1,
      sourceTileSize,
      0,
      gutter,
      gutter,
      gpuPageSize,
    );
    context.drawImage(
      bitmap,
      sourceTileSize - 1,
      0,
      1,
      sourceTileSize,
      gutter + gpuPageSize,
      gutter,
      gutter,
      gpuPageSize,
    );
    for (const [sourceX, sourceY, targetX, targetY] of [
      [0, 0, 0, 0],
      [sourceTileSize - 1, 0, gutter + gpuPageSize, 0],
      [0, sourceTileSize - 1, 0, gutter + gpuPageSize],
      [
        sourceTileSize - 1,
        sourceTileSize - 1,
        gutter + gpuPageSize,
        gutter + gpuPageSize,
      ],
    ]) {
      context.drawImage(
        bitmap,
        sourceX!,
        sourceY!,
        1,
        1,
        targetX!,
        targetY!,
        gutter,
        gutter,
      );
    }
    const image = context.getImageData(0, 0, paddedSize, paddedSize);
    return new Uint8Array(
      image.data.buffer.slice(
        image.data.byteOffset,
        image.data.byteOffset + image.data.byteLength,
      ),
    );
  } finally {
    bitmap.close();
  }
}
