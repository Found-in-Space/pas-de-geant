import * as THREE from "three";
import {
  IMAGERY_INTERMEDIATE_MAX_ZOOM,
  IMAGERY_PAGE_TABLE_SIZE,
  WEB_MERCATOR_MAX_LATITUDE,
  encodePageEntry,
  imageryActivationForScale,
  imageryBaseActivationForScale,
  imageryKey,
  imageryPlanForWindow,
  imageryWindowForContact,
  isValidImageryAddress,
  resolvedImagerySource,
  selectImageryZoom,
  type ImageryActivation,
  type ImageryAddress,
  type ImageryLoadTask,
  type ImageryPlan,
  type ImageryView,
} from "./imagery-core.js";

const IMAGERY_GUTTER_PIXELS = 2;
const IMAGERY_POOL_LAYER_LIMIT = 96;
const IMAGERY_POOL_BYTE_LIMIT = 64 * 1024 * 1024;
const MAX_CONCURRENT_IMAGERY_REQUESTS = 6;
const MAX_IMAGERY_UPLOADS_PER_FRAME = 2;
const IMAGERY_TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
const IMAGERY_MALFORMED_RETRY_MS = 5 * 60_000;

export interface ImageryProvider {
  readonly id: string;
  readonly attribution: string;
  readonly tileSize: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  load(address: ImageryAddress, signal: AbortSignal): Promise<Blob>;
}

export interface XyzImageryConfiguration {
  id?: string;
  urlTemplate: string;
  attribution: string;
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
}

declare global {
  interface Window {
    __PAS_DE_GEANT_IMAGERY_CONFIG__?: XyzImageryConfiguration;
    __PAS_DE_GEANT_IMAGERY_PROVIDER__?: ImageryProvider;
  }
}

export class ImageryRequestError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "transient" | "malformed",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ImageryRequestError";
  }
}

export class XyzImageryProvider implements ImageryProvider {
  readonly id: string;
  readonly attribution: string;
  readonly tileSize: number;
  readonly minZoom: number;
  readonly maxZoom: number;

  constructor(private readonly configuration: XyzImageryConfiguration) {
    if (
      !configuration.urlTemplate.includes("{z}") ||
      !configuration.urlTemplate.includes("{x}") ||
      !configuration.urlTemplate.includes("{y}")
    ) {
      throw new Error(
        "The imagery URL template must contain {z}, {x}, and {y}.",
      );
    }
    if (!configuration.attribution.trim()) {
      throw new Error("Photographic imagery requires provider attribution.");
    }
    this.id = configuration.id?.trim() || "configured-xyz";
    this.attribution = configuration.attribution.trim();
    this.tileSize = Math.max(
      1,
      Math.min(1_024, Math.floor(configuration.tileSize ?? 256)),
    );
    this.minZoom = Math.max(0, Math.floor(configuration.minZoom ?? 0));
    this.maxZoom = Math.max(
      this.minZoom,
      Math.min(20, Math.floor(configuration.maxZoom ?? 20)),
    );
  }

  async load(address: ImageryAddress, signal: AbortSignal): Promise<Blob> {
    if (
      !isValidImageryAddress(address) ||
      address.z < this.minZoom ||
      address.z > this.maxZoom
    ) {
      throw new ImageryRequestError(
        "The imagery address is outside provider coverage.",
        "not-found",
      );
    }
    const url = this.configuration.urlTemplate
      .replaceAll("{z}", String(address.z))
      .replaceAll("{x}", String(address.x))
      .replaceAll("{y}", String(address.y));
    const response = await fetch(url, {
      cache: "default",
      mode: "cors",
      signal,
    });
    if (!response.ok) {
      throw new ImageryRequestError(
        `Imagery tile request failed with ${response.status}.`,
        response.status === 404 ? "not-found" : "transient",
        response.status,
      );
    }
    const blob = await response.blob();
    if (!blob.type.toLowerCase().startsWith("image/")) {
      throw new ImageryRequestError(
        "The imagery response is not an image.",
        "malformed",
      );
    }
    return blob;
  }
}

export function configuredXyzImageryProvider(
  configuration: XyzImageryConfiguration | undefined,
): ImageryProvider | undefined {
  return configuration ? new XyzImageryProvider(configuration) : undefined;
}

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
  generation: number;
  failedAttempts: number;
  retryAtMs: number;
  pixels?: Uint8Array;
  slot?: number;
  usedAt: number;
}

interface ActiveRequest {
  controller: AbortController;
  generation: number;
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
  in vec2 vBlueMarbleUv;
  in vec2 vImageryUv;

  vec3 resolvedImageryAlbedo() {
    if (imageryEnabled < 0.5) {
      return texture(blueMarbleMap, vBlueMarbleUv).rgb;
    }
    vec2 pageCoordinate =
      imageryCoordOriginScale.xy +
      vImageryUv * imageryCoordOriginScale.zw;
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
    float layerByte = floor(encoded.r * 255.0 + 0.5);
    if (layerByte < 0.5) {
      return texture(blueMarbleMap, vBlueMarbleUv).rgb;
    }
    float ancestorDelta = floor(encoded.g * 255.0 + 0.5);
    vec2 childOffset = floor(encoded.ba * 255.0 + 0.5);
    float ancestorScale = exp2(ancestorDelta);
    vec2 targetUv = fract(pageCoordinate);
    vec2 sourceUv = (childOffset + targetUv) / ancestorScale;
    float tileSize = imageryPoolLayout.x;
    float gutter = imageryPoolLayout.y;
    float paddedSize = imageryPoolLayout.z;
    vec2 poolUv = (vec2(gutter) + sourceUv * tileSize) / paddedSize;
    return texture(
      imageryTilePool,
      vec3(poolUv, layerByte - 1.0)
    ).rgb;
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
  private baseActivation: ImageryActivation = "inactive";
  private refinementActivation: ImageryActivation = "inactive";
  private plan: ImageryPlan | undefined;
  private generation = 0;
  private desiredZoom: number | undefined;
  private visibleZoomCeiling: number | undefined;
  private mappingSignature = "";
  private pageTableEpoch = 0;
  private sequence = 0;
  private poolUnavailable = false;
  private windowSize = IMAGERY_PAGE_TABLE_SIZE;

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
    };
  }

  configureMaterial(
    material: THREE.ShaderMaterial,
    bounds: ImageryCoordinateBounds,
  ): void {
    const value = material.uniforms.imageryCoordOriginScale
      ?.value as THREE.Vector4 | undefined;
    const window = this.plan?.window;
    if (!value || !window) {
      value?.set(0, 0, 0, 0);
      return;
    }
    const worldWidth = 2 ** window.zoom;
    let west = bounds.west * worldWidth;
    const reference = window.originX + window.size * 0.5;
    west += Math.round((reference - west) / worldWidth) * worldWidth;
    value.set(
      west - window.originX,
      bounds.north * worldWidth - window.originY,
      (bounds.east - bounds.west) * worldWidth,
      (bounds.south - bounds.north) * worldWidth,
    );
  }

  update(options: ImageryUpdateOptions): void {
    const nowMs = options.nowMs ?? Date.now();
    const nextBaseActivation = this.provider
      ? imageryBaseActivationForScale(
          options.displayRadiusM,
          this.baseActivation,
        )
      : "inactive";
    if (nextBaseActivation !== this.baseActivation) {
      this.baseActivation = nextBaseActivation;
      if (nextBaseActivation === "inactive") {
        this.clearPlan();
      }
    }
    this.refinementActivation = this.provider
      ? imageryActivationForScale(
          options.displayRadiusM,
          this.refinementActivation,
        )
      : "inactive";
    if (
      this.provider &&
      this.baseActivation !== "inactive" &&
      Math.abs(options.latitudeDegrees) <= WEB_MERCATOR_MAX_LATITUDE
    ) {
      this.ensurePool();
      if (this.poolUnavailable) {
        this.clearPlan();
        this.updateDiagnostics();
        return;
      }
      const desiredZoom = selectImageryZoom({
        ...options,
        tileSize: this.provider.tileSize,
        minZoom: this.provider.minZoom,
        maxZoom: this.provider.maxZoom,
        previousZoom: this.desiredZoom,
      });
      const intermediateZoomCeiling = Math.max(
        this.provider.minZoom,
        Math.min(
          this.provider.maxZoom,
          IMAGERY_INTERMEDIATE_MAX_ZOOM,
        ),
      );
      const planZoom =
        this.refinementActivation === "inactive"
          ? Math.min(desiredZoom, intermediateZoomCeiling)
          : desiredZoom;
      this.visibleZoomCeiling =
        this.refinementActivation === "active"
          ? planZoom
          : Math.min(planZoom, intermediateZoomCeiling);
      const window = imageryWindowForContact(
        options.latitudeDegrees,
        options.longitudeDegrees,
        planZoom,
        this.plan?.window,
        this.windowSize,
      );
      const nextPlan = imageryPlanForWindow(
        window,
        this.provider.minZoom,
      );
      if (nextPlan.signature !== this.plan?.signature) {
        this.applyPlan(nextPlan);
      }
      this.desiredZoom = desiredZoom;
    } else if (this.baseActivation !== "inactive" && this.plan) {
      this.clearPlan();
    }
    this.uploadDecodedTiles();
    if (this.baseActivation === "active") {
      this.commitResolvedMapping();
    } else {
      this.sharedUniforms.imageryEnabled!.value = 0;
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
      new Uint8Array(IMAGERY_PAGE_TABLE_SIZE * IMAGERY_PAGE_TABLE_SIZE * 4),
      IMAGERY_PAGE_TABLE_SIZE,
      IMAGERY_PAGE_TABLE_SIZE,
      THREE.RGBAFormat,
      THREE.UnsignedByteType,
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
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
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
    if (maximumLayers < 2) {
      this.poolUnavailable = true;
      this.diagnostics.gpuFailureTotal += 1;
      return;
    }
    const paddedSize =
      this.provider.tileSize + IMAGERY_GUTTER_PIXELS * 2;
    const layerBytes = paddedSize * paddedSize * 4;
    this.poolLayers = Math.max(
      1,
      Math.min(
        IMAGERY_POOL_LAYER_LIMIT,
        maximumLayers || IMAGERY_POOL_LAYER_LIMIT,
        Math.floor(IMAGERY_POOL_BYTE_LIMIT / layerBytes),
      ),
    );
    if (this.poolLayers < 5) {
      this.poolUnavailable = true;
      this.diagnostics.gpuFailureTotal += 1;
      return;
    }
    const budgetedWindowSize = Math.floor(
      Math.sqrt(this.poolLayers / 1.25),
    );
    this.windowSize = Math.max(
      2,
      Math.min(
        IMAGERY_PAGE_TABLE_SIZE,
        budgetedWindowSize - (budgetedWindowSize % 2),
      ),
    );
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

  private applyPlan(plan: ImageryPlan): void {
    this.plan = plan;
    this.generation += 1;
    this.wanted.clear();
    for (const task of plan.tasks) {
      this.wanted.set(imageryKey(task.address), task);
    }
    for (const [key, request] of this.activeRequests) {
      if (
        !this.wanted.has(key) ||
        request.generation !== this.generation
      ) {
        request.controller.abort();
      }
    }
    for (const [key, record] of this.records) {
      if (record.status === "evicted" && this.wanted.has(key)) {
        record.status = "absent";
      }
      if (
        record.status === "decoded" &&
        (!this.wanted.has(key) || record.generation !== this.generation)
      ) {
        record.status = "absent";
        record.pixels = undefined;
      }
    }
    if (this.baseActivation === "active") {
      this.commitResolvedMapping(true);
    }
  }

  private clearPlan(): void {
    if (
      !this.plan &&
      this.wanted.size === 0 &&
      Number(this.sharedUniforms.imageryEnabled!.value) === 0
    ) {
      this.desiredZoom = undefined;
      this.visibleZoomCeiling = undefined;
      return;
    }
    this.plan = undefined;
    this.desiredZoom = undefined;
    this.visibleZoomCeiling = undefined;
    this.generation += 1;
    this.wanted.clear();
    for (const request of this.activeRequests.values()) {
      request.controller.abort();
    }
    this.sharedUniforms.imageryEnabled!.value = 0;
    this.visibleKeys.clear();
    this.mappingSignature = "";
  }

  private pumpRequests(nowMs = Date.now()): void {
    if (
      !this.provider ||
      !this.plan ||
      this.baseActivation === "inactive"
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
      const generation = this.generation;
      const existing = this.records.get(key);
      const record: ImageryRecord = existing ?? {
        address: task.address,
        status: "absent",
        generation,
        failedAttempts: 0,
        retryAtMs: 0,
        usedAt: 0,
      };
      record.status = "loading";
      record.generation = generation;
      this.records.set(key, record);
      this.activeRequests.set(key, { controller, generation });
      this.diagnostics.requestTotal += 1;
      void this.loadTile(task, controller.signal, generation)
        .catch((error: unknown) =>
          this.handleLoadFailure(key, record, error, generation),
        )
        .finally(() => {
          const active = this.activeRequests.get(key);
          if (active?.generation === generation) {
            this.activeRequests.delete(key);
          }
          this.pumpRequests();
        });
    }
  }

  private async loadTile(
    task: ImageryLoadTask,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    if (!this.provider) return;
    const key = imageryKey(task.address);
    const blob = await this.provider.load(task.address, signal);
    const pixels = await decodeImageryTile(
      blob,
      this.provider.tileSize,
      IMAGERY_GUTTER_PIXELS,
      signal,
    );
    const active = this.activeRequests.get(key);
    if (
      signal.aborted ||
      active?.generation !== generation ||
      this.generation !== generation ||
      !this.wanted.has(key)
    ) {
      this.diagnostics.staleTotal += 1;
      return;
    }
    const record = this.records.get(key);
    if (!record || record.generation !== generation) {
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
    generation: number,
  ): void {
    if (isAbortError(error)) {
      this.diagnostics.abortTotal += 1;
      if (record.generation !== generation || this.generation !== generation) {
        this.diagnostics.staleTotal += 1;
      }
      if (record.generation === generation && record.status === "loading") {
        record.status = "absent";
      }
      return;
    }
    if (
      record.generation !== generation ||
      this.generation !== generation ||
      !this.wanted.has(key)
    ) {
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

  private uploadDecodedTiles(): void {
    if (!this.provider || this.poolLayers <= 1) return;
    const decoded = [...this.records.entries()]
      .filter(
        ([key, record]) =>
          record.status === "decoded" &&
          record.generation === this.generation &&
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
      record: ImageryRecord;
      slot: number;
    }> = [];
    const layerBytes =
      (this.provider.tileSize + IMAGERY_GUTTER_PIXELS * 2) ** 2 * 4;
    for (const [, record] of decoded) {
      const slot = this.allocateSlot();
      if (slot === undefined || !record.pixels) break;
      this.poolPixels.set(record.pixels, slot * layerBytes);
      this.poolTexture.addLayerUpdate(slot);
      staged.push({ record, slot });
    }
    if (staged.length > 0) {
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
    const candidate = [...this.records.entries()]
      .filter(
        ([key, record]) =>
          record.status === "resident" &&
          record.slot !== undefined &&
          !this.visibleKeys.has(key) &&
          (!this.wanted.has(key) ||
            record.address.z < (this.plan?.window.zoom ?? 0)),
      )
      .sort(
        (first, second) =>
          first[1].usedAt - second[1].usedAt ||
          first[0].localeCompare(second[0]),
      )[0];
    if (!candidate) return undefined;
    const [, record] = candidate;
    const slot = record.slot;
    record.slot = undefined;
    record.status = "evicted";
    return slot;
  }

  private commitResolvedMapping(force = false): void {
    if (!this.plan || this.baseActivation !== "active") return;
    const resident = new Set(
      [...this.records]
        .filter(([, record]) => record.status === "resident")
        .map(([key]) => key),
    );
    const bytes = new Uint8Array(
      IMAGERY_PAGE_TABLE_SIZE * IMAGERY_PAGE_TABLE_SIZE * 4,
    );
    const nextVisibleKeys = new Set<string>();
    let visibleEntries = 0;
    for (const cell of this.plan.cells) {
      const source = resolvedImagerySource(
        cell.address,
        resident,
        this.provider?.minZoom ?? 0,
        this.visibleZoomCeiling ?? cell.address.z,
      );
      if (!source) continue;
      const record = this.records.get(imageryKey(source));
      if (record?.status !== "resident" || record.slot === undefined) continue;
      const entry = encodePageEntry(cell.address, source, record.slot);
      const index =
        (cell.tableY * IMAGERY_PAGE_TABLE_SIZE + cell.tableX) * 4;
      bytes[index] = entry.layerByte;
      bytes[index + 1] = entry.ancestorDelta;
      bytes[index + 2] = entry.childOffsetX;
      bytes[index + 3] = entry.childOffsetY;
      record.usedAt = ++this.sequence;
      nextVisibleKeys.add(imageryKey(source));
      visibleEntries += 1;
    }
    const signature = `${this.plan.signature}:${visibleEntries}:${Array.from(
      bytes,
    ).join(",")}`;
    if (!force && signature === this.mappingSignature) {
      this.sharedUniforms.imageryEnabled!.value = 1;
      return;
    }
    const stagingIndex = this.activePageTable === 0 ? 1 : 0;
    const staging = this.pageTables[stagingIndex];
    const stagingData = staging.image.data as Uint8Array;
    stagingData.set(bytes);
    staging.needsUpdate = true;
    const context = this.renderer.getContext();
    context.getError();
    this.renderer.initTexture(staging);
    if (context.getError() !== context.NO_ERROR) {
      this.diagnostics.gpuFailureTotal += 1;
      return;
    }
    this.activePageTable = stagingIndex;
    this.sharedUniforms.imageryPageTable!.value = staging;
    this.sharedUniforms.imageryEnabled!.value = 1;
    this.visibleKeys.clear();
    for (const key of nextVisibleKeys) this.visibleKeys.add(key);
    this.mappingSignature = signature;
    this.pageTableEpoch += 1;
    this.diagnostics.commitTotal += 1;
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
    document.body.dataset.imageryActivation = this.baseActivation;
    document.body.dataset.imageryRefinement =
      this.refinementActivation;
    document.body.dataset.imageryDesiredZoom =
      this.desiredZoom === undefined ? "" : String(this.desiredZoom);
    document.body.dataset.imageryVisibleZoom =
      this.visibleZoomCeiling === undefined
        ? ""
        : String(this.visibleZoomCeiling);
    document.body.dataset.imageryWindow = this.plan?.signature ?? "";
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
        return record?.address.z === this.plan?.window.zoom;
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
    document.body.dataset.imageryWindowSize = String(this.windowSize);
  }
}

async function decodeImageryTile(
  blob: Blob,
  tileSize: number,
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
    if (bitmap.width !== tileSize || bitmap.height !== tileSize) {
      throw new ImageryRequestError(
        `The imagery tile must be ${tileSize} × ${tileSize} pixels.`,
        "malformed",
      );
    }
    const paddedSize = tileSize + gutter * 2;
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
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, gutter, gutter);
    context.drawImage(
      bitmap,
      0,
      0,
      tileSize,
      1,
      gutter,
      0,
      tileSize,
      gutter,
    );
    context.drawImage(
      bitmap,
      0,
      tileSize - 1,
      tileSize,
      1,
      gutter,
      gutter + tileSize,
      tileSize,
      gutter,
    );
    context.drawImage(
      bitmap,
      0,
      0,
      1,
      tileSize,
      0,
      gutter,
      gutter,
      tileSize,
    );
    context.drawImage(
      bitmap,
      tileSize - 1,
      0,
      1,
      tileSize,
      gutter + tileSize,
      gutter,
      gutter,
      tileSize,
    );
    for (const [sourceX, sourceY, targetX, targetY] of [
      [0, 0, 0, 0],
      [tileSize - 1, 0, gutter + tileSize, 0],
      [0, tileSize - 1, 0, gutter + tileSize],
      [
        tileSize - 1,
        tileSize - 1,
        gutter + tileSize,
        gutter + tileSize,
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
