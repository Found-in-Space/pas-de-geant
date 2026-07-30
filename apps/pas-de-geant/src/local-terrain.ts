import * as THREE from "three";
import {
  deleteCachedElevation,
  loadCachedElevation,
  type ElevationCacheStatus,
} from "./elevation-cache.js";
import {
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
import {
  IMAGERY_FRAGMENT_DECLARATIONS,
  ImageryVirtualTexture,
  imageryBoundsForMercatorAddress,
} from "./imagery.js";

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
  geometrySignature: string;
}

interface StagedLocalTile {
  geometry: THREE.BufferGeometry;
  address: NativeTerrainTile;
  requestedSegments: number;
  actualSegments: number;
  geometryBytes: number;
  geometrySignature: string;
}

interface PendingWorkerRequest {
  address: MercatorTileAddress;
  kind: "decode" | "mesh";
  segments?: number;
  geometrySignature?: string;
  finishDecode?: () => void;
}

interface QueuedMeshRequest {
  address: NativeTerrainTile;
  segments: number;
  geometrySignature: string;
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
  imagery: ImageryVirtualTexture,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
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
      ...imagery.materialUniforms(),
      normalizedRadialMetres: { value: 0 },
      normalizedSkirtDepth: { value: 0 },
      detailAvailable: { value: 0 },
      skirtEdges: { value: new THREE.Vector4() },
      sunlight: { value: new THREE.Vector3(-0.38, 0.82, 0.42).normalize() },
    },
    vertexShader: `
      in vec2 heightUv;
      in float detailHeightM;
      in float skirtEdge;
      uniform sampler2D heightMap;
      uniform float heightOffsetM;
      uniform float heightScaleM;
      uniform float normalizedRadialMetres;
      uniform float normalizedSkirtDepth;
      uniform float detailAvailable;
      uniform vec4 skirtEdges;
      out vec2 vBlueMarbleUv;
      out vec2 vImageryUv;
      out vec3 vBaseNormal;
      void main() {
        vec2 packedHeight = texture(heightMap, heightUv).rg;
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
        vBlueMarbleUv = heightUv;
        vImageryUv = uv;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      ${IMAGERY_FRAGMENT_DECLARATIONS}
      uniform vec3 sunlight;
      in vec3 vBaseNormal;
      out vec4 terrainColour;
      void main() {
        vec3 albedo = resolvedImageryAlbedo();
        vec3 reliefNormal = normalize(vBaseNormal);
        float direct = max(0.0, dot(reliefNormal, normalize(sunlight)));
        float light = 0.46 + direct * 0.72;
        vec3 colour = albedo * light;
        colour += vec3(0.025, 0.045, 0.065) * (1.0 - direct);
        terrainColour = vec4(colour, 1.0);
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
  private visiblePlan: NativeTerrainPlan | undefined;
  private candidatePlan: NativeTerrainPlan | undefined;
  private candidateGroupsCommitted = new Set<string>();
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
    private readonly imagery: ImageryVirtualTexture,
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
    const plan = this.candidatePlan ?? this.visiblePlan;
    return {
      minZoom: plan?.minZoom ?? 0,
      maxZoom: plan?.maxZoom ?? 0,
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
      !(this.candidatePlan ?? this.visiblePlan) ||
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
    if (this.visiblePlan?.signature === plan.signature) {
      this.candidatePlan = undefined;
      this.candidateGroupsCommitted.clear();
      const visibleSignatures = new Set(
        this.visiblePlan.active.map(
          (address) => address.geometrySignature,
        ),
      );
      for (const [signature, staged] of this.staged) {
        if (visibleSignatures.has(signature)) continue;
        staged.geometry.dispose();
        this.staged.delete(signature);
      }
      this.meshQueue.clear();
      this.diagnosticsDirty = true;
      return;
    }
    this.candidatePlan = plan;
    this.candidateGroupsCommitted.clear();
    const referencedSignatures = new Set([
      ...(this.visiblePlan?.active ?? []).map(
        (address) => address.geometrySignature,
      ),
      ...plan.active.map((address) => address.geometrySignature),
    ]);
    for (const [signature, tile] of this.staged) {
      if (!referencedSignatures.has(signature)) {
        tile.geometry.dispose();
        this.staged.delete(signature);
      }
    }
    this.meshQueue.clear();
    this.commitReadyGroups();
    this.refreshEdgeTargets();
    this.diagnosticsDirty = true;
  }

  private clearPlan(): void {
    if (
      !this.visiblePlan &&
      !this.candidatePlan &&
      this.rendered.size === 0
    ) {
      return;
    }
    this.visiblePlan = undefined;
    this.candidatePlan = undefined;
    this.candidateGroupsCommitted.clear();
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
      this.imagery.configureMaterial(
        tile.mesh.material,
        imageryBoundsForMercatorAddress(tile.address),
      );
    }
  }

  private scheduleElevation(): void {
    const plan = this.candidatePlan ?? this.visiblePlan;
    if (!plan) {
      this.loadQueue.sync([]);
      return;
    }
    const now = Date.now();
    const tasks: TileLoadTask[] = [];
    for (const task of heightLoadTasksForWindow(plan)) {
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
        finishDecode: resolve,
      });
      const request: LocalTerrainWorkerRequest = {
        type: "decode",
        requestId,
        generation: requestId,
        address: task.address,
        bytes: payload.bytes,
        contentType: payload.contentType,
        retainOcean: true,
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
      const address = pending.geometrySignature
        ? this.tileForSignature(pending.geometrySignature)
        : undefined;
      if (
        address &&
        pending.segments === result.requestedSegments &&
        pending.geometrySignature === address.geometrySignature
      ) {
        this.stageMesh(result, address);
      } else {
        this.staleWorkerResults += 1;
      }
    } else if (result.missing && pending.kind === "mesh") {
      this.decoded.delete(
        mercatorTileKey(result.missingAddress ?? pending.address),
      );
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
      this.failedMeshUntil.set(
        pending.geometrySignature ?? key,
        Date.now() + HEIGHT_RETRY_DELAY_MS,
      );
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

  private planningPlan(): NativeTerrainPlan | undefined {
    return this.candidatePlan ?? this.visiblePlan;
  }

  private tileForSignature(signature: string): NativeTerrainTile | undefined {
    return [
      ...(this.candidatePlan?.active ?? []),
      ...(this.visiblePlan?.active ?? []),
    ].find((address) => address.geometrySignature === signature);
  }

  private queueBuildableMeshes(): void {
    const plan = this.planningPlan();
    if (!plan) return;
    for (const address of plan.active) {
      const key = mercatorTileKey(address);
      const segments = this.segmentsForAddress(address);
      const geometrySignature = address.geometrySignature;
      if (this.rendered.get(key)?.geometrySignature === geometrySignature) {
        continue;
      }
      if (this.staged.has(geometrySignature)) continue;
      if (this.meshQueue.has(geometrySignature)) continue;
      if (
        [...this.pendingWorker.values()].some(
          (pending) =>
            pending.kind === "mesh" &&
            pending.geometrySignature === geometrySignature,
        )
      ) {
        continue;
      }
      if (
        (this.failedMeshUntil.get(geometrySignature) ?? 0) > Date.now()
      ) {
        continue;
      }
      if (this.prerequisiteState(address) !== "decoded") continue;
      const neighbours = this.meshPrerequisites(address);
      if (
        neighbours.some(
          (neighbour) => this.prerequisiteState(neighbour) === "pending",
        )
      ) {
        continue;
      }
      if (
        neighbours.some(
          (neighbour) => {
            if (this.prerequisiteState(neighbour) !== "failed") return false;
            return !this.permanentFailures.has(mercatorTileKey(neighbour));
          },
        )
      ) {
        continue;
      }
      if (
        Object.values(address.edgeConstraints).some((constraint) => {
          const state = this.prerequisiteState(constraint.address);
          return state === "failed";
        })
      ) {
        continue;
      }
      this.meshQueue.set(geometrySignature, {
        address,
        segments,
        geometrySignature,
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
    const [signature, task] = next;
    this.meshQueue.delete(signature);
    if (!this.tileForSignature(task.geometrySignature)) {
      this.dispatchNextMesh();
      return;
    }
    const requestId = ++this.requestId;
    this.pendingWorker.set(requestId, {
      address: task.address,
      kind: "mesh",
      segments: task.segments,
      geometrySignature: task.geometrySignature,
    });
    this.worker.postMessage({
      type: "mesh",
      requestId,
      generation: requestId,
      address: task.address,
      segments: task.segments,
      skirtEdges: task.address.skirtEdges,
      edgeConstraints: task.address.edgeConstraints,
    } satisfies LocalTerrainWorkerRequest);
    this.diagnosticsDirty = true;
  }

  private meshPrerequisites(
    address: NativeTerrainTile,
  ): MercatorTileAddress[] {
    const sources = [
      address,
      ...Object.values(address.edgeConstraints).map(
        (constraint) => constraint.address,
      ),
    ];
    const prerequisites: MercatorTileAddress[] = [];
    const keys = new Set<string>();
    for (const source of sources) {
      for (const [deltaX, deltaY] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const dependency = {
          z: source.z,
          x: wrapMercatorX(source.x + deltaX, source.z),
          y: source.y + deltaY,
        };
        if (!isValidMercatorAddress(dependency)) continue;
        const key = mercatorTileKey(dependency);
        if (keys.has(key)) continue;
        keys.add(key);
        prerequisites.push(dependency);
      }
    }
    return prerequisites;
  }

  private stageMesh(
    result: PreparedLocalTile,
    address: NativeTerrainTile,
  ): void {
    const geometry = geometryForLocalTile(result);
    const signature = address.geometrySignature;
    const previous = this.staged.get(signature);
    previous?.geometry.dispose();
    this.staged.set(signature, {
      geometry,
      address,
      requestedSegments: result.requestedSegments,
      actualSegments: result.actualSegments,
      geometryBytes: result.geometryBytes,
      geometrySignature: signature,
    });
    this.commitReadyGroups();
  }

  private commitStagedTile(staged: StagedLocalTile): void {
    const key = mercatorTileKey(staged.address);
    const existing = this.rendered.get(key);
    if (existing) {
      this.geometryBytes -= existing.geometryBytes;
      existing.mesh.geometry.dispose();
      existing.mesh.geometry = staged.geometry;
      existing.address = staged.address;
      existing.requestedSegments = staged.requestedSegments;
      existing.actualSegments = staged.actualSegments;
      existing.geometryBytes = staged.geometryBytes;
      existing.geometrySignature = staged.geometrySignature;
      existing.mesh.material.uniforms.detailAvailable!.value = 1;
      this.geometryBytes += staged.geometryBytes;
    } else {
      const material = localTerrainMaterial(
        this.relief,
        this.imagery,
      );
      this.imagery.configureMaterial(
        material,
        imageryBoundsForMercatorAddress(staged.address),
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
        geometrySignature: staged.geometrySignature,
      };
      material.uniforms.detailAvailable!.value = 1;
      this.rendered.set(key, tile);
      this.group.add(mesh);
      this.geometryBytes += staged.geometryBytes;
    }
    this.staged.delete(staged.geometrySignature);
  }

  private coherentGroupKey(address: NativeTerrainTile): string {
    if (address.ring === 0 && address.meshSegments >= 512) {
      return "underfoot";
    }
    return address.ring === 0 ? "finest" : `ring-${address.ring}`;
  }

  private nativeReady(address: NativeTerrainTile): boolean {
    const rendered = this.rendered.get(mercatorTileKey(address));
    return Boolean(
      rendered &&
        rendered.geometrySignature === address.geometrySignature,
    );
  }

  private fallbackEligible(address: NativeTerrainTile): boolean {
    const centreState = this.prerequisiteState(address);
    if (centreState === "ocean" || centreState === "failed") return true;
    if (
      (this.failedMeshUntil.get(address.geometrySignature) ?? 0) > Date.now()
    ) {
      return true;
    }
    if (
      Object.values(address.edgeConstraints).some((constraint) => {
        const state = this.prerequisiteState(constraint.address);
        return state === "failed";
      })
    ) {
      return true;
    }
    return this.meshPrerequisites(address).some((dependency) => {
      const state = this.prerequisiteState(dependency);
      return (
        state === "failed" &&
        !this.permanentFailures.has(mercatorTileKey(dependency))
      );
    });
  }

  private commitReadyGroups(): void {
    const plan = this.candidatePlan ?? this.visiblePlan;
    if (!plan) return;
    if (!this.candidatePlan && this.staged.size === 0) return;
    const groups = new Map<string, NativeTerrainTile[]>();
    for (const address of plan.active) {
      const key = this.coherentGroupKey(address);
      const group = groups.get(key) ?? [];
      group.push(address);
      groups.set(key, group);
    }
    let committed = false;
    for (const group of groups.values()) {
      const groupKey = this.coherentGroupKey(group[0]!);
      if (
        this.candidatePlan &&
        this.candidateGroupsCommitted.has(groupKey) &&
        !group.some((address) =>
          this.staged.has(address.geometrySignature)
        )
      ) {
        continue;
      }
      const ready = group.every((address) => {
        if (this.nativeReady(address) || this.fallbackEligible(address)) {
          return true;
        }
        return this.staged.has(address.geometrySignature);
      });
      if (!ready) continue;

      const groupSignatures = new Set(
        group.map((address) => address.geometrySignature),
      );
      const uncommittedTargetKeys = new Set(
        plan.active
          .filter(
            (address) =>
              this.coherentGroupKey(address) !== groupKey &&
              !this.candidateGroupsCommitted.has(
                this.coherentGroupKey(address),
              ),
          )
          .map(mercatorTileKey),
      );
      for (const [key, rendered] of this.rendered) {
        if (this.coherentGroupKey(rendered.address) !== groupKey) continue;
        if (groupSignatures.has(rendered.geometrySignature)) continue;
        if (uncommittedTargetKeys.has(key)) continue;
        this.removeRenderedTile(key);
      }

      let committedGroup = this.candidatePlan !== undefined;
      for (const address of group) {
        const staged = this.staged.get(address.geometrySignature);
        if (!staged) continue;
        this.commitStagedTile(staged);
        committedGroup = true;
      }
      if (committedGroup) {
        this.candidateGroupsCommitted.add(groupKey);
        this.atomicSwapTotal += 1;
        committed = true;
      }
    }
    if (this.candidatePlan) {
      const candidateGroupKeys = new Set(
        this.candidatePlan.active.map((address) =>
          this.coherentGroupKey(address)
        ),
      );
      if (
        [...candidateGroupKeys].every((key) =>
          this.candidateGroupsCommitted.has(key)
        )
      ) {
        const targetSignatures = new Set(
          this.candidatePlan.active.map(
            (address) => address.geometrySignature,
          ),
        );
        for (const [key, rendered] of this.rendered) {
          if (!targetSignatures.has(rendered.geometrySignature)) {
            this.removeRenderedTile(key);
          }
        }
        this.visiblePlan = this.candidatePlan;
        this.candidatePlan = undefined;
        this.candidateGroupsCommitted.clear();
      }
    }
    if (committed) {
      this.updateMaterialUniforms();
      this.refreshEdgeTargets();
      this.diagnosticsDirty = true;
    }
  }

  private refreshEdgeTargets(): void {
    if (!this.visiblePlan && !this.candidatePlan) return;
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
    const plan = this.visiblePlan ?? this.candidatePlan;
    if (!this.stencilAvailable || !plan) return "disabled";
    if (this.visiblePlan && !this.candidatePlan) {
      return this.rendered.size > 0 ? "ready" : "fallback";
    }
    if (
      plan.active.every((address) => this.nativeReady(address))
    ) {
      return "ready";
    }
    const now = Date.now();
    const allUnavailable = plan.active.every((address) => {
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
    const plan = this.candidatePlan ?? this.visiblePlan;
    const visiblePlan = this.visiblePlan;
    const states: string[] = [];
    let fallbackCells = 0;
    let readyCells = 0;
    const now = Date.now();
    for (const address of plan?.active ?? []) {
      const key = mercatorTileKey(address);
      const rendered = this.rendered.get(key);
      let state = "p";
      if (
        rendered?.geometrySignature === address.geometrySignature
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
    document.body.dataset.detailVisiblePlan =
      visiblePlan?.signature ?? "";
    document.body.dataset.detailCandidatePlan =
      this.candidatePlan?.signature ?? "";
    document.body.dataset.detailTransitionCount = String(
      this.atomicSwapTotal,
    );
    const underfoot = (plan?.active ?? []).filter(
      (address) => this.coherentGroupKey(address) === "underfoot",
    );
    document.body.dataset.detailContactOwner =
      underfoot.length > 0 &&
      underfoot.every((address) => this.nativeReady(address))
        ? "native"
        : "global";
    document.body.dataset.detailBaseGlobeVisible = "true";
    const ringStates = new Map<string, string>();
    for (const address of plan?.active ?? []) {
      const group = this.coherentGroupKey(address);
      const current = ringStates.get(group);
      if (current === "loading") continue;
      if (this.nativeReady(address)) {
        ringStates.set(group, current ?? "ready");
      } else if (this.fallbackEligible(address)) {
        ringStates.set(group, current === "ready" ? "fallback" : "fallback");
      } else {
        ringStates.set(group, "loading");
      }
    }
    document.body.dataset.detailRingStates = [...ringStates]
      .map(([group, state]) => `${group}:${state}`)
      .join(",");
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
