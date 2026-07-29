import * as THREE from "three";
import {
  deleteCachedElevation,
  loadCachedElevation,
  type ElevationCacheStatus,
} from "./elevation-cache.js";
import { normalizedRadialOffsetForMetres } from "./planet-state.js";
import type { ReliefDataset } from "./relief.js";
import {
  LOCAL_HEIGHT_CACHE_LIMIT,
  LOCAL_RING_LEVELS,
  LOCAL_TILE_SIZE,
  LruCache,
  TileRequestQueue,
  elevationFailureDecision,
  heightLoadTasksForWindow,
  isValidMercatorAddress,
  localDetailEnabled,
  mercatorCoordinatesForTilePoint,
  mercatorTileKey,
  nativeTerrainPlanAnchorKey,
  selectNativeTerrainPlan,
  selectNativeTerrainZoom,
  wrapMercatorX,
  type LocalTerrainWorkerRequest,
  type LocalTerrainWorkerResult,
  type MercatorTileAddress,
  type NativeTerrainPlan,
  type NativeTerrainTile,
  type TileLoadTask,
} from "./local-terrain-core.js";

const HEIGHT_RETRY_DELAY_MS = 30_000;
const LOCAL_MIN_SKIRT_DEPTH_WORLD_M = 0.0005;

interface ElevationPayload {
  bytes: ArrayBuffer;
  contentType: string;
  cacheStatus: ElevationCacheStatus;
}

class ElevationRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ElevationRequestError";
  }
}

interface RenderedLocalTile {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  address: NativeTerrainTile;
  requestedSegments: number;
  actualSegments: number;
  geometryBytes: number;
}

interface PendingWorkerRequest {
  address: MercatorTileAddress;
  kind: "decode" | "mesh";
  generation: number;
  segments?: number;
  finishDecode?: () => void;
}

interface QueuedMeshRequest {
  address: NativeTerrainTile;
  generation: number;
  segments: number;
}

type PreparedLocalTile = Extract<LocalTerrainWorkerResult, { type: "mesh" }>;

export interface LocalTerrainImageryPatch {
  key: string;
  texture: THREE.Texture;
  targetBounds: {
    west: number;
    east: number;
    north: number;
    south: number;
  };
  sourceBounds: {
    west: number;
    east: number;
    north: number;
    south: number;
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function loadElevation(
  address: MercatorTileAddress,
  signal: AbortSignal,
): Promise<ElevationPayload> {
  const payload = await loadCachedElevation(address, signal);
  if (payload.status < 200 || payload.status >= 300) {
    throw new ElevationRequestError(
      `Elevation tile request failed with ${payload.status}.`,
      payload.status,
    );
  }
  return {
    bytes: payload.bytes,
    contentType: payload.contentType,
    cacheStatus: payload.cacheStatus,
  };
}

function localTerrainMaterial(
  relief: ReliefDataset,
  fallbackTexture: THREE.Texture,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
    uniforms: {
      heightMap: { value: relief.texture },
      heightOffsetM: { value: relief.metadata.offsetMetres },
      heightScaleM: { value: relief.metadata.scaleMetres },
      fallbackMap: { value: fallbackTexture },
      detailImageMap: { value: fallbackTexture },
      imageScale: { value: new THREE.Vector2(1, 1) },
      imageOffset: { value: new THREE.Vector2(0, 0) },
      normalizedRadialMetres: { value: 0 },
      normalizedSkirtDepth: { value: 0 },
      oceanSurface: { value: 1 },
      imageryMix: { value: 0 },
      outerEdges: { value: new THREE.Vector4() },
      unavailableEdges: { value: new THREE.Vector4() },
      skirtEdges: { value: new THREE.Vector4() },
      sunlight: { value: new THREE.Vector3(-0.38, 0.82, 0.42).normalize() },
    },
    vertexShader: `
      attribute vec2 heightUv;
      attribute float detailHeightM;
      attribute float skirtEdge;
      uniform sampler2D heightMap;
      uniform float heightOffsetM;
      uniform float heightScaleM;
      uniform float normalizedRadialMetres;
      uniform float normalizedSkirtDepth;
      uniform float oceanSurface;
      uniform vec4 outerEdges;
      uniform vec4 unavailableEdges;
      uniform vec4 skirtEdges;
      varying vec2 vImageUv;
      varying vec2 vHeightUv;
      varying vec3 vBaseNormal;
      varying float vHeightM;
      varying float vDetailWeight;
      float fadeEdge(float distance, float outerEdge, float unavailableEdge) {
        float outerWeight = mix(
          1.0,
          smoothstep(0.0, 1.0, distance),
          clamp(outerEdge, 0.0, 1.0)
        );
        float unavailableWeight = mix(
          1.0,
          smoothstep(0.0, 0.25, distance),
          clamp(unavailableEdge, 0.0, 1.0)
        );
        return min(outerWeight, unavailableWeight);
      }
      void main() {
        vec2 packedHeight = texture2D(heightMap, heightUv).rg;
        float encodedHeight =
          packedHeight.r * 255.0 + packedHeight.g * 65280.0;
        float globalHeightM =
          encodedHeight * heightScaleM + heightOffsetM;
        float detailWeight = min(
          min(
            fadeEdge(uv.y, outerEdges.x, unavailableEdges.x),
            fadeEdge(1.0 - uv.x, outerEdges.y, unavailableEdges.y)
          ),
          min(
            fadeEdge(1.0 - uv.y, outerEdges.z, unavailableEdges.z),
            fadeEdge(uv.x, outerEdges.w, unavailableEdges.w)
          )
        );
        float resolvedDetailM = detailHeightM;
        if (abs(detailHeightM) < 0.5 && globalHeightM < 0.0) {
          resolvedDetailM = globalHeightM;
        }
        float heightM = mix(globalHeightM, resolvedDetailM, detailWeight);
        float displayedHeightM = heightM;
        if (oceanSurface > 0.5 && heightM < 0.0) displayedHeightM = 0.0;
        float skirtEnabled = 0.0;
        if (skirtEdge > 0.5 && skirtEdge < 1.5) {
          skirtEnabled = skirtEdges.x;
        } else if (skirtEdge < 2.5) {
          skirtEnabled = skirtEdges.y;
        } else if (skirtEdge < 3.5) {
          skirtEnabled = skirtEdges.z;
        } else if (skirtEdge < 4.5) {
          skirtEnabled = skirtEdges.w;
        }
        vec3 displaced =
          position +
          normal * displayedHeightM * normalizedRadialMetres -
          normal * normalizedSkirtDepth * skirtEnabled;
        vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
        vBaseNormal = normalize(mat3(modelMatrix) * normal);
        vImageUv = uv;
        vHeightUv = heightUv;
        vHeightM = heightM;
        vDetailWeight = detailWeight;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D fallbackMap;
      uniform sampler2D detailImageMap;
      uniform vec2 imageScale;
      uniform vec2 imageOffset;
      uniform float imageryMix;
      uniform vec3 sunlight;
      uniform float oceanSurface;
      varying vec2 vImageUv;
      varying vec2 vHeightUv;
      varying vec3 vBaseNormal;
      varying float vHeightM;
      varying float vDetailWeight;
      void main() {
        vec3 fallbackAlbedo = texture2D(fallbackMap, vHeightUv).rgb;
        vec3 detailAlbedo = texture2D(
          detailImageMap,
          imageOffset + vImageUv * imageScale
        ).rgb;
        vec3 albedo = mix(
          fallbackAlbedo,
          detailAlbedo,
          vDetailWeight * imageryMix
        );
        vec3 reliefNormal = normalize(vBaseNormal);
        float direct = max(0.0, dot(reliefNormal, normalize(sunlight)));
        float light = 0.46 + direct * 0.72;
        vec3 colour = albedo * light;
        if (oceanSurface > 0.5 && vHeightM < 0.0) {
          float depthTint = clamp(-vHeightM / 7000.0, 0.0, 1.0);
          vec3 water = mix(
            vec3(0.025, 0.22, 0.34),
            vec3(0.012, 0.075, 0.15),
            depthTint
          );
          colour = mix(water, albedo * 0.42, 0.18) * (0.72 + direct * 0.28);
        }
        colour += vec3(0.025, 0.045, 0.065) * (1.0 - direct);
        gl_FragColor = vec4(colour, 1.0);
      }
    `,
  });
}

function geometryForLocalTile(result: PreparedLocalTile): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(result.positions, 3),
  );
  geometry.setAttribute("normal", new THREE.BufferAttribute(result.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(result.uvs, 2));
  geometry.setAttribute(
    "heightUv",
    new THREE.BufferAttribute(result.heightUvs, 2),
  );
  geometry.setAttribute(
    "detailHeightM",
    new THREE.BufferAttribute(result.detailHeightsM, 1),
  );
  geometry.setAttribute(
    "skirtEdge",
    new THREE.BufferAttribute(result.skirtEdges, 1),
  );
  geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3().fromArray(result.boundingCentre),
    result.boundingRadius,
  );
  return geometry;
}

function tileBounds(address: MercatorTileAddress): {
  west: number;
  east: number;
  north: number;
  south: number;
} {
  const northWest = mercatorCoordinatesForTilePoint(address, 0, 0);
  const southEast = mercatorCoordinatesForTilePoint(
    address,
    LOCAL_TILE_SIZE,
    LOCAL_TILE_SIZE,
  );
  return {
    west: northWest.longitudeDegrees,
    east: southEast.longitudeDegrees,
    north: northWest.latitudeDegrees,
    south: southEast.latitudeDegrees,
  };
}

function patchForTile(
  address: MercatorTileAddress,
  patches: readonly LocalTerrainImageryPatch[],
): LocalTerrainImageryPatch | undefined {
  const bounds = tileBounds(address);
  const longitude = (bounds.west + bounds.east) * 0.5;
  const latitude = (bounds.north + bounds.south) * 0.5;
  return patches
    .filter(
      (patch) =>
        longitude >= patch.targetBounds.west &&
        longitude <= patch.targetBounds.east &&
        latitude <= patch.targetBounds.north &&
        latitude >= patch.targetBounds.south,
    )
    .sort((first, second) => {
      const firstArea =
        (first.targetBounds.east - first.targetBounds.west) *
        (first.targetBounds.north - first.targetBounds.south);
      const secondArea =
        (second.targetBounds.east - second.targetBounds.west) *
        (second.targetBounds.north - second.targetBounds.south);
      return firstArea - secondArea;
    })[0];
}

function imageryTransform(
  address: MercatorTileAddress,
  patch: LocalTerrainImageryPatch,
): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } {
  const target = tileBounds(address);
  const source = patch.sourceBounds;
  const sourceWidth = Math.max(1e-9, source.east - source.west);
  const sourceHeight = Math.max(1e-9, source.north - source.south);
  return {
    scaleX: (target.east - target.west) / sourceWidth,
    scaleY: (target.north - target.south) / sourceHeight,
    offsetX: (target.west - source.west) / sourceWidth,
    offsetY: (source.north - target.north) / sourceHeight,
  };
}

function parentAddress(
  address: MercatorTileAddress,
): MercatorTileAddress | undefined {
  if (address.z <= 0) return undefined;
  return {
    z: address.z - 1,
    x: Math.floor(address.x / 2),
    y: Math.floor(address.y / 2),
  };
}

function coverageSets(
  addresses: readonly MercatorTileAddress[],
): {
  exact: Set<string>;
  descendantAncestors: Set<string>;
} {
  const exact = new Set(addresses.map(mercatorTileKey));
  const descendantAncestors = new Set<string>();
  for (const address of addresses) {
    let parent = parentAddress(address);
    while (parent) {
      descendantAncestors.add(mercatorTileKey(parent));
      parent = parentAddress(parent);
    }
  }
  return { exact, descendantAncestors };
}

function hasCoverage(
  address: MercatorTileAddress,
  sets: ReturnType<typeof coverageSets>,
): boolean {
  if (sets.exact.has(mercatorTileKey(address))) return true;
  let parent = parentAddress(address);
  while (parent) {
    if (sets.exact.has(mercatorTileKey(parent))) return true;
    parent = parentAddress(parent);
  }
  return sets.descendantAncestors.has(mercatorTileKey(address));
}

export class LocalTerrainRenderer {
  readonly group = new THREE.Group();
  private readonly worker: Worker;
  private readonly rendered = new Map<string, RenderedLocalTile>();
  private readonly decoded = new LruCache<"decoded" | "ocean">(
    LOCAL_HEIGHT_CACHE_LIMIT,
  );
  private readonly failedUntil = new Map<string, number>();
  private readonly retryCounts = new Map<string, number>();
  private readonly permanentFailures = new Set<string>();
  private readonly failedMeshUntil = new Map<string, number>();
  private readonly pendingDecodeKeys = new Map<string, number>();
  private readonly pendingWorker = new Map<number, PendingWorkerRequest>();
  private readonly meshQueue = new Map<string, QueuedMeshRequest>();
  private readonly loadQueue: TileRequestQueue<ElevationPayload>;
  private plan: NativeTerrainPlan | undefined;
  private active = new Map<string, NativeTerrainTile>();
  private generation = 0;
  private requestId = 0;
  private baseZoom: number | undefined;
  private planAnchor = "";
  private lodBias = 0;
  private displayRadiusM = 1;
  private radialMultiplier = 1;
  private oceanSurface = true;
  private imageryPatches: LocalTerrainImageryPatch[] = [];
  private imageryPatchSignature = "";
  private geometryBytes = 0;
  private diagnosticsDirty = true;
  private elevationRequestTotal = 0;
  private elevationAbortTotal = 0;
  private elevationRetryTotal = 0;
  private elevationPersistentCacheHits = 0;
  private elevationPersistentCacheWrites = 0;
  private elevationPersistentCacheErrors = 0;
  private elevationPersistentCacheDeletes = 0;
  private staleWorkerResults = 0;

  constructor(
    private readonly relief: ReliefDataset,
    private readonly fallbackTexture: THREE.Texture,
    private readonly stencilAvailable = true,
  ) {
    this.group.name = "local-terrain";
    this.worker = new Worker(
      new URL("./local-terrain-worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.addEventListener(
      "message",
      (event: MessageEvent<LocalTerrainWorkerResult>) =>
        this.handleWorkerResult(event.data),
    );
    this.loadQueue = new TileRequestQueue(
      (address, signal) => {
        this.elevationRequestTotal += 1;
        signal.addEventListener(
          "abort",
          () => {
            this.elevationAbortTotal += 1;
          },
          { once: true },
        );
        return loadElevation(address, signal);
      },
      (task, payload) => this.handleElevationLoaded(task, payload),
      (task, error) => this.handleElevationFailed(task, error),
    );
  }

  setImageryPatches(patches: LocalTerrainImageryPatch[]): void {
    const signature = patches
      .map((patch) => `${patch.key}:${patch.texture.uuid}`)
      .join("|");
    if (signature === this.imageryPatchSignature) return;
    this.imageryPatchSignature = signature;
    this.imageryPatches = patches.slice(0, 32);
    for (const tile of this.rendered.values()) this.applyImagery(tile);
    this.diagnosticsDirty = true;
  }

  getLodStatus(): {
    minZoom: number;
    maxZoom: number;
    bias: number;
    budgetLimited: boolean;
  } {
    return {
      minZoom: this.plan?.minZoom ?? 0,
      maxZoom: this.plan?.maxZoom ?? 0,
      bias: this.lodBias,
      budgetLimited: false,
    };
  }

  getImageryTextureUuidsInUse(): Set<string> {
    const textureUuids = new Set<string>();
    for (const tile of this.rendered.values()) {
      const texture = tile.mesh.material.uniforms.detailImageMap
        ?.value as THREE.Texture | undefined;
      if (texture && texture !== this.fallbackTexture) {
        textureUuids.add(texture.uuid);
      }
    }
    return textureUuids;
  }

  update(
    latitudeDegrees: number,
    longitudeDegrees: number,
    displayRadiusM: number,
    radialMultiplier: number,
    oceanSurface: boolean,
    lodBias = 0,
    _eyeHeightWorldM = 1.65,
    _focalLengthPixels = 1_000,
  ): void {
    this.displayRadiusM = Math.max(0.001, displayRadiusM);
    this.radialMultiplier = radialMultiplier;
    this.oceanSurface = oceanSurface;
    this.lodBias = Math.max(-3, Math.min(3, Math.round(lodBias)));

    if (!this.stencilAvailable || !localDetailEnabled(latitudeDegrees)) {
      this.clearPlan();
      this.updateDiagnostics();
      return;
    }

    const nextBaseZoom = selectNativeTerrainZoom(
      latitudeDegrees,
      this.displayRadiusM,
      this.baseZoom,
    );
    const finestZoom = Math.max(
      0,
      Math.min(12, nextBaseZoom + this.lodBias),
    );
    const nextAnchor = nativeTerrainPlanAnchorKey(
      latitudeDegrees,
      longitudeDegrees,
      finestZoom,
      LOCAL_RING_LEVELS,
    );
    if (
      !this.plan ||
      nextBaseZoom !== this.baseZoom ||
      nextAnchor !== this.planAnchor
    ) {
      this.baseZoom = nextBaseZoom;
      this.planAnchor = nextAnchor;
      this.applyPlan(
        selectNativeTerrainPlan({
          latitudeDegrees,
          longitudeDegrees,
          displayRadiusM: this.displayRadiusM,
          previousBaseZoom: nextBaseZoom,
          lodBias: this.lodBias,
        }),
      );
    }

    this.updateMaterialUniforms();
    this.scheduleElevation();
    this.queueBuildableMeshes();
    this.dispatchNextMesh();
    if (this.diagnosticsDirty) this.updateDiagnostics();
  }

  dispose(): void {
    this.loadQueue.dispose();
    this.worker.postMessage({ type: "dispose" } satisfies LocalTerrainWorkerRequest);
    this.worker.terminate();
    this.clearRendered();
  }

  private applyPlan(plan: NativeTerrainPlan): void {
    this.plan = plan;
    this.generation += 1;
    this.active = new Map(
      plan.active.map((address) => [mercatorTileKey(address), address]),
    );
    this.meshQueue.clear();
    for (const [key, tile] of this.rendered) {
      const activeAddress = this.active.get(key);
      if (!activeAddress) {
        this.removeRenderedTile(key);
      } else {
        tile.address = activeAddress;
      }
    }
    this.refreshEdgeTargets();
    this.diagnosticsDirty = true;
  }

  private clearPlan(): void {
    if (!this.plan && this.rendered.size === 0) return;
    this.generation += 1;
    this.plan = undefined;
    this.active.clear();
    this.planAnchor = "";
    this.meshQueue.clear();
    this.loadQueue.sync([]);
    this.clearRendered();
    this.diagnosticsDirty = true;
  }

  private updateMaterialUniforms(): void {
    const normalizedRadialMetres = normalizedRadialOffsetForMetres(
      1,
      this.radialMultiplier,
    );
    for (const tile of this.rendered.values()) {
      const uniforms = tile.mesh.material.uniforms;
      uniforms.normalizedRadialMetres!.value = normalizedRadialMetres;
      uniforms.normalizedSkirtDepth!.value =
        LOCAL_MIN_SKIRT_DEPTH_WORLD_M / this.displayRadiusM;
      uniforms.oceanSurface!.value = this.oceanSurface ? 1 : 0;
    }
  }

  private scheduleElevation(): void {
    if (!this.plan) {
      this.loadQueue.sync([]);
      return;
    }
    const now = Date.now();
    const tasks: TileLoadTask[] = [];
    for (const task of heightLoadTasksForWindow(this.plan)) {
      const key = mercatorTileKey(task.address);
      if (this.decoded.get(key) || this.pendingDecodeKeys.has(key)) continue;
      if (this.permanentFailures.has(key)) continue;
      const retryAt = this.failedUntil.get(key) ?? 0;
      if (retryAt <= now) {
        this.failedUntil.delete(key);
        tasks.push(task);
      }
    }
    this.loadQueue.sync(tasks);
  }

  private handleElevationLoaded(
    task: TileLoadTask,
    payload: ElevationPayload,
  ): Promise<void> {
    if (payload.cacheStatus === "hit") {
      this.elevationPersistentCacheHits += 1;
    } else if (payload.cacheStatus === "stored") {
      this.elevationPersistentCacheWrites += 1;
    } else if (payload.cacheStatus === "error") {
      this.elevationPersistentCacheErrors += 1;
    }
    const key = mercatorTileKey(task.address);
    const requestId = ++this.requestId;
    this.pendingDecodeKeys.set(key, requestId);
    return new Promise<void>((resolve) => {
      this.pendingWorker.set(requestId, {
        address: task.address,
        kind: "decode",
        generation: this.generation,
        finishDecode: resolve,
      });
      const request: LocalTerrainWorkerRequest = {
        type: "decode",
        requestId,
        generation: this.generation,
        address: task.address,
        bytes: payload.bytes,
        contentType: payload.contentType,
      };
      this.worker.postMessage(request, [payload.bytes]);
      this.diagnosticsDirty = true;
    });
  }

  private handleElevationFailed(task: TileLoadTask, error: unknown): void {
    if (isAbortError(error)) return;
    const key = mercatorTileKey(task.address);
    if (error instanceof ElevationRequestError && error.status === 404) {
      this.permanentFailures.add(key);
      this.failedUntil.delete(key);
    } else {
      const retries = (this.retryCounts.get(key) ?? 0) + 1;
      this.retryCounts.set(key, retries);
      const decision = elevationFailureDecision(
        "transient",
        retries,
        Date.now(),
      );
      if (decision.retryScheduled) this.elevationRetryTotal += 1;
      this.failedUntil.set(key, decision.retryAtMs);
    }
    this.refreshEdgeTargets();
    this.diagnosticsDirty = true;
  }

  private handleWorkerResult(result: LocalTerrainWorkerResult): void {
    const pending = this.pendingWorker.get(result.requestId);
    if (!pending) return;
    this.pendingWorker.delete(result.requestId);
    const key = mercatorTileKey(pending.address);
    if (
      pending.kind === "decode" &&
      this.pendingDecodeKeys.get(key) === result.requestId
    ) {
      this.pendingDecodeKeys.delete(key);
    }

    if (result.type === "decoded") {
      this.decoded.set(key, result.oceanOnly ? "ocean" : "decoded");
      this.failedUntil.delete(key);
      this.retryCounts.delete(key);
      this.failedMeshUntil.delete(key);
    } else if (result.type === "mesh") {
      if (
        result.generation === this.generation &&
        this.active.has(key) &&
        this.segmentsForAddress(this.active.get(key)!) ===
          result.requestedSegments
      ) {
        this.installMesh(result);
      } else {
        this.staleWorkerResults += 1;
      }
    } else if (result.missing && pending.kind === "mesh") {
      this.decoded.delete(key);
    } else if (pending.kind === "decode") {
      void deleteCachedElevation(pending.address).then((status) => {
        if (status === "deleted") {
          this.elevationPersistentCacheDeletes += 1;
        } else if (status === "error") {
          this.elevationPersistentCacheErrors += 1;
        }
        this.diagnosticsDirty = true;
      });
      this.failedUntil.set(
        key,
        elevationFailureDecision("malformed", 1, Date.now()).retryAtMs,
      );
    } else {
      this.failedMeshUntil.set(key, Date.now() + HEIGHT_RETRY_DELAY_MS);
    }

    pending.finishDecode?.();
    this.queueBuildableMeshes();
    this.dispatchNextMesh();
    this.refreshEdgeTargets();
    this.diagnosticsDirty = true;
  }

  private prerequisiteState(
    address: MercatorTileAddress,
  ): "decoded" | "ocean" | "failed" | "pending" {
    if (!isValidMercatorAddress(address)) return "failed";
    const key = mercatorTileKey(address);
    const cached = this.decoded.get(key);
    if (cached) return cached;
    if (this.permanentFailures.has(key)) return "failed";
    if ((this.failedUntil.get(key) ?? 0) > Date.now()) return "failed";
    return "pending";
  }

  private segmentsForAddress(address: NativeTerrainTile): number {
    return address.meshSegments;
  }

  private queueBuildableMeshes(): void {
    if (!this.plan) return;
    for (const address of this.plan.active) {
      const key = mercatorTileKey(address);
      const segments = this.segmentsForAddress(address);
      if (this.rendered.get(key)?.requestedSegments === segments) continue;
      if (this.meshQueue.get(key)?.segments === segments) continue;
      if (
        [...this.pendingWorker.values()].some(
          (pending) =>
            pending.kind === "mesh" &&
            mercatorTileKey(pending.address) === key &&
            pending.generation === this.generation &&
            pending.segments === segments,
        )
      ) {
        continue;
      }
      if ((this.failedMeshUntil.get(key) ?? 0) > Date.now()) continue;
      if (this.prerequisiteState(address) !== "decoded") continue;
      const neighbours = this.meshPrerequisites(address);
      if (
        neighbours.some(
          (neighbour) =>
            this.active.has(mercatorTileKey(neighbour)) &&
            this.prerequisiteState(neighbour) === "pending",
        )
      ) {
        continue;
      }
      this.meshQueue.set(key, {
        address,
        generation: this.generation,
        segments,
      });
    }
  }

  private dispatchNextMesh(): void {
    if (
      [...this.pendingWorker.values()].some(
        (pending) => pending.kind === "mesh",
      )
    ) {
      return;
    }
    const next = this.meshQueue.entries().next().value as
      | [string, QueuedMeshRequest]
      | undefined;
    if (!next) return;
    const [key, task] = next;
    this.meshQueue.delete(key);
    if (task.generation !== this.generation) {
      this.dispatchNextMesh();
      return;
    }
    const requestId = ++this.requestId;
    this.pendingWorker.set(requestId, {
      address: task.address,
      kind: "mesh",
      generation: task.generation,
      segments: task.segments,
    });
    this.worker.postMessage({
      type: "mesh",
      requestId,
      generation: task.generation,
      address: task.address,
      segments: task.segments,
    } satisfies LocalTerrainWorkerRequest);
    this.diagnosticsDirty = true;
  }

  private meshPrerequisites(
    address: MercatorTileAddress,
  ): MercatorTileAddress[] {
    return [
      {
        z: address.z,
        x: wrapMercatorX(address.x + 1, address.z),
        y: address.y,
      },
      { z: address.z, x: address.x, y: address.y + 1 },
      {
        z: address.z,
        x: wrapMercatorX(address.x + 1, address.z),
        y: address.y + 1,
      },
    ];
  }

  private installMesh(result: PreparedLocalTile): void {
    const key = mercatorTileKey(result.address);
    const address = this.active.get(key);
    if (!address) return;
    const geometry = geometryForLocalTile(result);
    const existing = this.rendered.get(key);
    if (existing) {
      this.geometryBytes -= existing.geometryBytes;
      existing.mesh.geometry.dispose();
      existing.mesh.geometry = geometry;
      existing.address = address;
      existing.requestedSegments = result.requestedSegments;
      existing.actualSegments = result.actualSegments;
      existing.geometryBytes = result.geometryBytes;
      this.geometryBytes += result.geometryBytes;
      this.applyImagery(existing);
    } else {
      const material = localTerrainMaterial(this.relief, this.fallbackTexture);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = -1;
      const tile: RenderedLocalTile = {
        mesh,
        address,
        requestedSegments: result.requestedSegments,
        actualSegments: result.actualSegments,
        geometryBytes: result.geometryBytes,
      };
      this.rendered.set(key, tile);
      this.group.add(mesh);
      this.geometryBytes += result.geometryBytes;
      this.applyImagery(tile);
    }
    this.updateMaterialUniforms();
  }

  private applyImagery(tile: RenderedLocalTile): void {
    const material = tile.mesh.material;
    const patch = patchForTile(tile.address, this.imageryPatches);
    if (!patch) {
      material.uniforms.detailImageMap!.value = this.fallbackTexture;
      material.uniforms.imageryMix!.value = 0;
      return;
    }
    const transform = imageryTransform(tile.address, patch);
    material.uniforms.detailImageMap!.value = patch.texture;
    material.uniforms.imageScale!.value.set(
      transform.scaleX,
      transform.scaleY,
    );
    material.uniforms.imageOffset!.value.set(
      transform.offsetX,
      transform.offsetY,
    );
    material.uniforms.imageryMix!.value = 1;
  }

  private refreshEdgeTargets(): void {
    if (!this.plan) return;
    const renderedSets = coverageSets(
      [...this.rendered.values()].map((tile) => tile.address),
    );
    const directions = [
      ["north", 0, -1, 0],
      ["east", 1, 0, 1],
      ["south", 0, 1, 2],
      ["west", -1, 0, 3],
    ] as const;
    for (const tile of this.rendered.values()) {
      const outer = [
        tile.address.outerEdges.north,
        tile.address.outerEdges.east,
        tile.address.outerEdges.south,
        tile.address.outerEdges.west,
      ];
      const skirts = [
        tile.address.skirtEdges.north,
        tile.address.skirtEdges.east,
        tile.address.skirtEdges.south,
        tile.address.skirtEdges.west,
      ];
      const unavailable = [0, 0, 0, 0];
      for (const [edge, deltaX, deltaY, index] of directions) {
        if (tile.address.outerEdges[edge] > 0) continue;
        const neighbour = {
          z: tile.address.z,
          x: wrapMercatorX(tile.address.x + deltaX, tile.address.z),
          y: tile.address.y + deltaY,
        };
        if (!hasCoverage(neighbour, renderedSets)) unavailable[index] = 1;
      }
      const uniforms = tile.mesh.material.uniforms;
      (uniforms.outerEdges!.value as THREE.Vector4).fromArray(outer);
      (uniforms.unavailableEdges!.value as THREE.Vector4).fromArray(unavailable);
      (uniforms.skirtEdges!.value as THREE.Vector4).fromArray(skirts);
    }
  }

  private removeRenderedTile(key: string): void {
    const tile = this.rendered.get(key);
    if (!tile) return;
    this.group.remove(tile.mesh);
    this.geometryBytes = Math.max(0, this.geometryBytes - tile.geometryBytes);
    tile.mesh.geometry.dispose();
    tile.mesh.material.dispose();
    this.rendered.delete(key);
  }

  private clearRendered(): void {
    for (const key of [...this.rendered.keys()]) this.removeRenderedTile(key);
  }

  private diagnosticStatus(): string {
    if (!this.stencilAvailable || !this.plan) return "disabled";
    if (this.rendered.size > 0) return "ready";
    const now = Date.now();
    const allUnavailable = this.plan.active.every((address) => {
      const key = mercatorTileKey(address);
      return (
        this.decoded.peek(key) === "ocean" ||
        this.permanentFailures.has(key) ||
        (this.failedUntil.get(key) ?? 0) > now ||
        (this.failedMeshUntil.get(key) ?? 0) > now
      );
    });
    return allUnavailable ? "fallback" : "loading";
  }

  private updateDiagnostics(): void {
    if (typeof document === "undefined") return;
    const plan = this.plan;
    const states: string[] = [];
    let fallbackCells = 0;
    const now = Date.now();
    for (const address of plan?.active ?? []) {
      const key = mercatorTileKey(address);
      let state = "p";
      if (this.rendered.has(key)) {
        state = "r";
      } else if (this.decoded.peek(key) === "ocean") {
        state = "o";
        fallbackCells += 1;
      } else if (
        this.permanentFailures.has(key) ||
        (this.failedUntil.get(key) ?? 0) > now ||
        (this.failedMeshUntil.get(key) ?? 0) > now
      ) {
        state = "f";
        fallbackCells += 1;
      } else if (this.decoded.peek(key) === "decoded") {
        state = "d";
      }
      states.push(state);
    }
    const actualSegments = [
      ...new Set([...this.rendered.values()].map((tile) => tile.actualSegments)),
    ].sort((first, second) => first - second);
    const requestedSegments = [
      ...new Set(
        (plan?.active ?? []).map((address) =>
          this.segmentsForAddress(address)
        ),
      ),
    ].sort((first, second) => first - second);
    document.body.dataset.detailRelief = this.diagnosticStatus();
    document.body.dataset.detailMeshCount = String(this.rendered.size);
    document.body.dataset.detailHeightCache = String(this.decoded.size);
    document.body.dataset.detailHeightRequests = String(
      this.loadQueue.activeCount,
    );
    document.body.dataset.detailWindowOrigin = this.planAnchor;
    document.body.dataset.detailWindowSize = plan
      ? String(plan.active.length)
      : "";
    document.body.dataset.detailTerrainZoom = plan
      ? String(plan.finestZoom)
      : "";
    document.body.dataset.detailActiveZoom = plan
      ? String(plan.finestZoom)
      : "";
    document.body.dataset.detailTargetZoom = plan
      ? String(plan.finestZoom)
      : "";
    document.body.dataset.detailDesiredZoom = plan
      ? String(plan.finestZoom)
      : "";
    document.body.dataset.detailCalculatedZoom = plan
      ? String(plan.baseZoom)
      : "";
    document.body.dataset.detailZoomOverride = String(this.lodBias);
    document.body.dataset.detailSourceZoomRange = plan
      ? `${plan.minZoom}-${plan.maxZoom}`
      : "";
    document.body.dataset.detailLodBias = String(this.lodBias);
    document.body.dataset.detailSourceSampleMetres = plan
      ? (plan.finestTileWidthM / LOCAL_TILE_SIZE).toFixed(4)
      : "";
    document.body.dataset.detailSourceSamplePixels = "";
    document.body.dataset.detailRequestedErrorMetres = "";
    document.body.dataset.detailActualErrorMetres = "";
    document.body.dataset.detailMeshSegments = requestedSegments.join(",");
    document.body.dataset.detailActualMeshSegments =
      actualSegments.join(",");
    document.body.dataset.detailHorizonDegrees = "";
    document.body.dataset.detailHorizonDistanceKm = "";
    document.body.dataset.detailHorizonCoverage = String(Boolean(plan));
    document.body.dataset.detailCoverageMargins = "";
    document.body.dataset.detailBudgetLimited = "false";
    document.body.dataset.detailActiveTileBudget = plan
      ? String(plan.active.length)
      : "0";
    document.body.dataset.detailStaging = String(
      this.rendered.size + fallbackCells < (plan?.active.length ?? 0),
    );
    document.body.dataset.detailStreamingState =
      this.rendered.size + fallbackCells >= (plan?.active.length ?? 0)
        ? "steady"
        : "streaming";
    document.body.dataset.detailScaleMotion = "false";
    document.body.dataset.detailLodHeadDeadzoneMetres = "";
    document.body.dataset.detailLodHeadMovementMetres = "";
    document.body.dataset.detailPlanSelectionTotal = plan ? "1" : "0";
    document.body.dataset.detailStagedMeshes = "0";
    document.body.dataset.detailAtomicSwapTotal = "0";
    document.body.dataset.detailReadyCells = String(this.rendered.size);
    document.body.dataset.detailFallbackCells = String(fallbackCells);
    document.body.dataset.detailOverbudgetCells = "0";
    document.body.dataset.detailCentreState = states[0] ?? "p";
    document.body.dataset.detailTileStates = states.join("");
    document.body.dataset.detailImageryCache = "0";
    document.body.dataset.detailImageryRequests = "0";
    document.body.dataset.detailImageryPatches = String(
      this.imageryPatches.length,
    );
    document.body.dataset.detailImageryDraws = String(
      [...this.rendered.values()].filter(
        (tile) => tile.mesh.material.uniforms.imageryMix!.value === 1,
      ).length,
    );
    document.body.dataset.detailWorkerQueued = String(this.meshQueue.size);
    document.body.dataset.detailWorkerInflight = String(
      Number(
        [...this.pendingWorker.values()].some(
          (pending) => pending.kind === "mesh",
        ),
      ),
    );
    document.body.dataset.detailWorkerStale = String(this.staleWorkerResults);
    document.body.dataset.detailElevationRequestTotal = String(
      this.elevationRequestTotal,
    );
    document.body.dataset.detailElevationAbortTotal = String(
      this.elevationAbortTotal,
    );
    document.body.dataset.detailElevationRetryTotal = String(
      this.elevationRetryTotal,
    );
    document.body.dataset.detailElevationPersistentCacheHits = String(
      this.elevationPersistentCacheHits,
    );
    document.body.dataset.detailElevationPersistentCacheWrites = String(
      this.elevationPersistentCacheWrites,
    );
    document.body.dataset.detailElevationPersistentCacheErrors = String(
      this.elevationPersistentCacheErrors,
    );
    document.body.dataset.detailElevationPersistentCacheDeletes = String(
      this.elevationPersistentCacheDeletes,
    );
    document.body.dataset.detailGeometryBytes = String(this.geometryBytes);
    document.body.dataset.detailVertices = String(
      [...this.rendered.values()].reduce(
        (total, tile) =>
          total + (tile.mesh.geometry.getAttribute("position")?.count ?? 0),
        0,
      ),
    );
    document.body.dataset.detailStencil = String(this.stencilAvailable);
    document.body.dataset.detailMaterialSide = "double";
    this.diagnosticsDirty = false;
  }
}
