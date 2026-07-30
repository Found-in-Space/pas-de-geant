import * as THREE from "three";
import {
  deleteCachedElevation,
  loadCachedElevation,
  type ElevationCacheStatus,
} from "./elevation-cache.js";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
  normalizedRadialOffsetForMetres,
} from "./planet-state.js";
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
const GEBCO_FALLBACK_MESH_SEGMENTS = 16;
const WGS84_ECCENTRICITY_SQUARED =
  1 - (WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);

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
  fallback: boolean;
}

interface StagedLocalTile {
  geometry: THREE.BufferGeometry;
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
  blueMarbleTexture: THREE.Texture,
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
      blueMarbleMap: { value: blueMarbleTexture },
      normalizedRadialMetres: { value: 0 },
      normalizedSkirtDepth: { value: 0 },
      detailAvailable: { value: 0 },
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
      uniform float detailAvailable;
      uniform vec4 skirtEdges;
      varying vec2 vHeightUv;
      varying vec3 vBaseNormal;
      void main() {
        vec2 packedHeight = texture2D(heightMap, heightUv).rg;
        float encodedHeight =
          packedHeight.r * 255.0 + packedHeight.g * 65280.0;
        float globalHeightM =
          encodedHeight * heightScaleM + heightOffsetM;
        float resolvedDetailM = detailHeightM;
        if (abs(detailHeightM) < 0.5 && globalHeightM < 0.0) {
          resolvedDetailM = globalHeightM;
        }
        float heightM = mix(globalHeightM, resolvedDetailM, detailAvailable);
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
          normal * heightM * normalizedRadialMetres -
          normal * normalizedSkirtDepth * skirtEnabled;
        vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
        vBaseNormal = normalize(mat3(modelMatrix) * normal);
        vHeightUv = heightUv;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D blueMarbleMap;
      uniform vec3 sunlight;
      varying vec2 vHeightUv;
      varying vec3 vBaseNormal;
      void main() {
        vec3 albedo = texture2D(blueMarbleMap, vHeightUv).rgb;
        vec3 reliefNormal = normalize(vBaseNormal);
        float direct = max(0.0, dot(reliefNormal, normalize(sunlight)));
        float light = 0.46 + direct * 0.72;
        vec3 colour = albedo * light;
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

function gebcoFallbackGeometry(
  address: MercatorTileAddress,
): { geometry: THREE.BufferGeometry; geometryBytes: number } {
  const segments = GEBCO_FALLBACK_MESH_SEGMENTS;
  const side = segments + 1;
  const vertexCount = side * side;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const heightUvs = new Float32Array(vertexCount * 2);
  const detailHeightsM = new Float32Array(vertexCount);
  const skirtEdges = new Float32Array(vertexCount);
  const indices = new Uint32Array(segments * segments * 6);

  let vertex = 0;
  for (let row = 0; row <= segments; row += 1) {
    for (let column = 0; column <= segments; column += 1) {
      const u = column / segments;
      const v = row / segments;
      const coordinates = mercatorCoordinatesForTilePoint(
        address,
        u * LOCAL_TILE_SIZE,
        v * LOCAL_TILE_SIZE,
      );
      const latitude = coordinates.latitudeDegrees * Math.PI / 180;
      const longitude = coordinates.longitudeDegrees * Math.PI / 180;
      const sineLatitude = Math.sin(latitude);
      const cosineLatitude = Math.cos(latitude);
      const sineLongitude = Math.sin(longitude);
      const cosineLongitude = Math.cos(longitude);
      const primeVerticalRadius =
        WGS84_A_KM /
        Math.sqrt(
          1 -
            WGS84_ECCENTRICITY_SQUARED *
              sineLatitude *
              sineLatitude,
        );
      const positionOffset = vertex * 3;
      positions[positionOffset] =
        primeVerticalRadius *
        cosineLatitude *
        cosineLongitude /
        EARTH_MEAN_RADIUS_KM;
      positions[positionOffset + 1] =
        primeVerticalRadius *
        (1 - WGS84_ECCENTRICITY_SQUARED) *
        sineLatitude /
        EARTH_MEAN_RADIUS_KM;
      positions[positionOffset + 2] =
        -primeVerticalRadius *
        cosineLatitude *
        sineLongitude /
        EARTH_MEAN_RADIUS_KM;
      normals[positionOffset] = cosineLatitude * cosineLongitude;
      normals[positionOffset + 1] = sineLatitude;
      normals[positionOffset + 2] = -cosineLatitude * sineLongitude;
      const uvOffset = vertex * 2;
      uvs[uvOffset] = u;
      uvs[uvOffset + 1] = v;
      heightUvs[uvOffset] = (coordinates.longitudeDegrees + 180) / 360;
      heightUvs[uvOffset + 1] = (90 - coordinates.latitudeDegrees) / 180;
      vertex += 1;
    }
  }

  let index = 0;
  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const northWest = row * side + column;
      const northEast = northWest + 1;
      const southWest = northWest + side;
      const southEast = southWest + 1;
      indices[index++] = northWest;
      indices[index++] = northEast;
      indices[index++] = southWest;
      indices[index++] = northEast;
      indices[index++] = southEast;
      indices[index++] = southWest;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute(
    "heightUv",
    new THREE.BufferAttribute(heightUvs, 2),
  );
  geometry.setAttribute(
    "detailHeightM",
    new THREE.BufferAttribute(detailHeightsM, 1),
  );
  geometry.setAttribute(
    "skirtEdge",
    new THREE.BufferAttribute(skirtEdges, 1),
  );
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return {
    geometry,
    geometryBytes:
      positions.byteLength +
      normals.byteLength +
      uvs.byteLength +
      heightUvs.byteLength +
      detailHeightsM.byteLength +
      skirtEdges.byteLength +
      indices.byteLength,
  };
}

export class LocalTerrainRenderer {
  readonly group = new THREE.Group();
  private readonly worker: Worker;
  private readonly rendered = new Map<string, RenderedLocalTile>();
  private readonly staged = new Map<string, StagedLocalTile>();
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
  private atomicSwapTotal = 0;

  constructor(
    private readonly relief: ReliefDataset,
    private readonly blueMarbleTexture: THREE.Texture,
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

  update(
    latitudeDegrees: number,
    longitudeDegrees: number,
    displayRadiusM: number,
    radialMultiplier: number,
    lodBias = 0,
    _eyeHeightWorldM = 1.65,
    _focalLengthPixels = 1_000,
  ): void {
    this.displayRadiusM = Math.max(0.001, displayRadiusM);
    this.radialMultiplier = radialMultiplier;
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
    this.clearStaged();
    this.clearRendered();
  }

  private applyPlan(plan: NativeTerrainPlan): void {
    this.plan = plan;
    this.generation += 1;
    this.clearStaged();
    this.active = new Map(
      plan.active.map((address) => [mercatorTileKey(address), address]),
    );
    this.meshQueue.clear();
    for (const address of plan.active) {
      const key = mercatorTileKey(address);
      if (!this.rendered.has(key)) this.installGebcoFallback(address);
    }
    for (const [key, tile] of this.rendered) {
      const activeAddress = this.active.get(key);
      if (!activeAddress) {
        this.removeRenderedTile(key);
      } else {
        tile.address = activeAddress;
      }
    }
    this.commitReadyGroups();
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
    this.clearStaged();
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
    this.commitReadyGroups();
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
        this.stageMesh(result);
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
    this.commitReadyGroups();
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
      if (this.staged.get(key)?.requestedSegments === segments) continue;
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

  private stageMesh(result: PreparedLocalTile): void {
    const key = mercatorTileKey(result.address);
    const address = this.active.get(key);
    if (!address) return;
    const geometry = geometryForLocalTile(result);
    const previous = this.staged.get(key);
    previous?.geometry.dispose();
    this.staged.set(key, {
      geometry,
      address,
      requestedSegments: result.requestedSegments,
      actualSegments: result.actualSegments,
      geometryBytes: result.geometryBytes,
    });
    this.commitReadyGroups();
  }

  private commitStagedTile(key: string, staged: StagedLocalTile): void {
    const existing = this.rendered.get(key);
    if (existing) {
      this.geometryBytes -= existing.geometryBytes;
      existing.mesh.geometry.dispose();
      existing.mesh.geometry = staged.geometry;
      existing.address = staged.address;
      existing.requestedSegments = staged.requestedSegments;
      existing.actualSegments = staged.actualSegments;
      existing.geometryBytes = staged.geometryBytes;
      existing.fallback = false;
      existing.mesh.material.uniforms.detailAvailable!.value = 1;
      this.geometryBytes += staged.geometryBytes;
    } else {
      const material = localTerrainMaterial(
        this.relief,
        this.blueMarbleTexture,
      );
      const mesh = new THREE.Mesh(staged.geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = -1;
      const tile: RenderedLocalTile = {
        mesh,
        address: staged.address,
        requestedSegments: staged.requestedSegments,
        actualSegments: staged.actualSegments,
        geometryBytes: staged.geometryBytes,
        fallback: false,
      };
      material.uniforms.detailAvailable!.value = 1;
      this.rendered.set(key, tile);
      this.group.add(mesh);
      this.geometryBytes += staged.geometryBytes;
    }
    this.staged.delete(key);
  }

  private installGebcoFallback(address: NativeTerrainTile): void {
    const key = mercatorTileKey(address);
    if (this.rendered.has(key)) return;
    const { geometry, geometryBytes } = gebcoFallbackGeometry(address);
    const material = localTerrainMaterial(
      this.relief,
      this.blueMarbleTexture,
    );
    material.uniforms.detailAvailable!.value = 0;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    const tile: RenderedLocalTile = {
      mesh,
      address,
      requestedSegments: 0,
      actualSegments: GEBCO_FALLBACK_MESH_SEGMENTS,
      geometryBytes,
      fallback: true,
    };
    this.rendered.set(key, tile);
    this.group.add(mesh);
    this.geometryBytes += geometryBytes;
  }

  private coherentGroupKey(address: NativeTerrainTile): string {
    return `${address.ring}:${address.meshSegments}`;
  }

  private nativeReady(address: NativeTerrainTile): boolean {
    const rendered = this.rendered.get(mercatorTileKey(address));
    return Boolean(
      rendered &&
        !rendered.fallback &&
        rendered.requestedSegments === this.segmentsForAddress(address),
    );
  }

  private fallbackEligible(address: NativeTerrainTile): boolean {
    const key = mercatorTileKey(address);
    const now = Date.now();
    return (
      this.decoded.peek(key) === "ocean" ||
      this.permanentFailures.has(key) ||
      (this.failedUntil.get(key) ?? 0) > now ||
      (this.failedMeshUntil.get(key) ?? 0) > now
    );
  }

  private commitReadyGroups(): void {
    if (!this.plan || this.staged.size === 0) return;
    const groups = new Map<string, NativeTerrainTile[]>();
    for (const address of this.plan.active) {
      const key = this.coherentGroupKey(address);
      const group = groups.get(key) ?? [];
      group.push(address);
      groups.set(key, group);
    }
    let committed = false;
    for (const group of groups.values()) {
      const ready = group.every((address) => {
        if (this.nativeReady(address) || this.fallbackEligible(address)) {
          return true;
        }
        const staged = this.staged.get(mercatorTileKey(address));
        return staged?.requestedSegments ===
          this.segmentsForAddress(address);
      });
      if (!ready) continue;
      let committedGroup = false;
      for (const address of group) {
        const key = mercatorTileKey(address);
        const staged = this.staged.get(key);
        if (!staged) continue;
        this.commitStagedTile(key, staged);
        committedGroup = true;
      }
      if (committedGroup) {
        this.atomicSwapTotal += 1;
        committed = true;
      }
    }
    if (committed) {
      this.updateMaterialUniforms();
      this.refreshEdgeTargets();
      this.diagnosticsDirty = true;
    }
  }

  private refreshEdgeTargets(): void {
    if (!this.plan) return;
    for (const tile of this.rendered.values()) {
      const skirts = [
        tile.address.skirtEdges.north,
        tile.address.skirtEdges.east,
        tile.address.skirtEdges.south,
        tile.address.skirtEdges.west,
      ];
      const uniforms = tile.mesh.material.uniforms;
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

  private clearStaged(): void {
    for (const tile of this.staged.values()) tile.geometry.dispose();
    this.staged.clear();
  }

  private diagnosticStatus(): string {
    if (!this.stencilAvailable || !this.plan) return "disabled";
    if (
      this.plan.active.every((address) =>
        this.rendered.has(mercatorTileKey(address)),
      )
    ) {
      return "ready";
    }
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
    let readyCells = 0;
    const now = Date.now();
    for (const address of plan?.active ?? []) {
      const key = mercatorTileKey(address);
      const rendered = this.rendered.get(key);
      let state = "p";
      if (
        rendered &&
        !rendered.fallback &&
        rendered.requestedSegments === this.segmentsForAddress(address)
      ) {
        state = "r";
        readyCells += 1;
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
    document.body.dataset.detailMeshCount = String(readyCells);
    document.body.dataset.detailCoverageMeshCount = String(
      this.rendered.size,
    );
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
      readyCells + fallbackCells < (plan?.active.length ?? 0),
    );
    document.body.dataset.detailStreamingState =
      readyCells + fallbackCells >= (plan?.active.length ?? 0)
        ? "steady"
        : "streaming";
    document.body.dataset.detailScaleMotion = "false";
    document.body.dataset.detailLodHeadDeadzoneMetres = "";
    document.body.dataset.detailLodHeadMovementMetres = "";
    document.body.dataset.detailPlanSelectionTotal = plan ? "1" : "0";
    document.body.dataset.detailStagedMeshes = String(this.staged.size);
    document.body.dataset.detailAtomicSwapTotal = String(
      this.atomicSwapTotal,
    );
    document.body.dataset.detailReadyCells = String(readyCells);
    document.body.dataset.detailFallbackCells = String(fallbackCells);
    document.body.dataset.detailOverbudgetCells = "0";
    document.body.dataset.detailCentreState = states[0] ?? "p";
    document.body.dataset.detailTileStates = states.join("");
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
