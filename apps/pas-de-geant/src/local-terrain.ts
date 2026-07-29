import * as THREE from "three";
import {
  deleteCachedElevation,
  loadCachedElevation,
  type ElevationCacheStatus,
} from "./elevation-cache.js";
import { normalizedRadialOffsetForMetres } from "./planet-state.js";
import type { ReliefDataset } from "./relief.js";
import { terrainHorizonSourceDistanceKm } from "./terrain-horizon.js";
import {
  LOCAL_ACTIVE_TILE_BUDGET,
  LOCAL_GEOMETRY_BUDGET_BYTES,
  LOCAL_HEIGHT_CACHE_LIMIT,
  LOCAL_LOD_HEADPOSE_DEADZONE_M,
  LOCAL_MESH_VERTEX_LIMIT,
  LOCAL_RETIRE_SECONDS,
  LOCAL_SCALE_SETTLE_MS,
  LOCAL_TILE_SIZE,
  LruCache,
  TileRequestQueue,
  elevationFailureDecision,
  heightLoadTasksForWindow,
  isValidMercatorAddress,
  localDetailEnabled,
  mercatorHorizonBounds,
  mercatorAddressForCoordinates,
  mercatorCoordinatesForTilePoint,
  mercatorTileKey,
  screenSpaceRtinErrorBucket,
  screenSpacePlanningPoseMovementM,
  selectScreenSpaceTerrainPlan,
  terrainScaleInputChanged,
  terrainScaleInputIsStable,
  wrapMercatorX,
  type LocalTerrainWorkerRequest,
  type LocalTerrainWorkerResult,
  type MercatorTileAddress,
  type ScreenSpaceLocalTile,
  type ScreenSpacePlanningPose,
  type ScreenSpaceTerrainPlan,
  type TileLoadTask,
} from "./local-terrain-core.js";

const HEIGHT_RETRY_DELAY_MS = 30_000;
const LOCAL_TRANSITION_SECONDS = 0.25;
const LOCAL_MIN_SKIRT_DEPTH_WORLD_M = 0.0005;
const LOCAL_MAX_SKIRT_DEPTH_WORLD_M = 0.003;
const LAND_AMBIENT_LIGHT = 0.46;
const LAND_DIRECT_LIGHT = 0.72;
const LAND_DARK_SHADOW_LIFT = 0.18;
const LAND_DARK_LUMINANCE = 0.12;
const LAND_BRIGHT_LUMINANCE = 0.5;
const LAND_DARK_TONE_LIFT = 0.16;
const LAND_LIT_TONE_FRACTION = 0.35;
const LOCAL_IMAGERY_OVERLAY_LIMIT = 128;

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
  address: ScreenSpaceLocalTile;
  requestedErrorM: number;
  actualErrorM: number;
  geometryBytes: number;
  detailTarget: number;
  overlays: Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>>;
  outerEdges: THREE.Vector4;
  unavailableEdges: THREE.Vector4;
  skirtEdges: THREE.Vector4;
}

interface PendingWorkerRequest {
  address: MercatorTileAddress;
  kind: "decode" | "mesh";
  generation: number;
  errorM?: number;
}

interface QueuedMeshRequest {
  address: ScreenSpaceLocalTile;
  generation: number;
  errorM: number;
}

interface PreparedTerrainPlan extends ScreenSpaceTerrainPlan {
  requestedErrors: Map<string, number>;
  signature: string;
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

type StreamingState = "steady" | "waiting" | "streaming";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function mercatorTileContains(
  ancestor: MercatorTileAddress,
  address: MercatorTileAddress,
): boolean {
  if (ancestor.z > address.z) return false;
  const divisor = 2 ** (address.z - ancestor.z);
  return (
    Math.floor(address.x / divisor) === ancestor.x &&
    Math.floor(address.y / divisor) === ancestor.y
  );
}

function mercatorTilesOverlap(
  first: MercatorTileAddress,
  second: MercatorTileAddress,
): boolean {
  return (
    mercatorTileContains(first, second) ||
    mercatorTileContains(second, first)
  );
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
    side: THREE.FrontSide,
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
      detailMix: { value: 0 },
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
      uniform float detailMix;
      uniform vec4 outerEdges;
      uniform vec4 unavailableEdges;
      uniform vec4 skirtEdges;
      varying vec2 vImageUv;
      varying vec2 vHeightUv;
      varying vec3 vWorldPosition;
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
        float edgeWeight = min(
          min(
            fadeEdge(uv.y, outerEdges.x, unavailableEdges.x),
            fadeEdge(1.0 - uv.x, outerEdges.y, unavailableEdges.y)
          ),
          min(
            fadeEdge(1.0 - uv.y, outerEdges.z, unavailableEdges.z),
            fadeEdge(uv.x, outerEdges.w, unavailableEdges.w)
          )
        );
        float detailWeight = edgeWeight * detailMix;
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
        vWorldPosition = worldPosition.xyz;
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
      varying vec3 vWorldPosition;
      varying vec3 vBaseNormal;
      varying float vHeightM;
      varying float vDetailWeight;
      void main() {
        vec2 imageUv = imageOffset + vImageUv * imageScale;
        vec3 fallbackAlbedo = texture2D(fallbackMap, vHeightUv).rgb;
        vec3 detailAlbedo = texture2D(detailImageMap, imageUv).rgb;
        vec3 albedo = mix(
          fallbackAlbedo,
          detailAlbedo,
          vDetailWeight * imageryMix
        );
        vec3 reliefNormal =
          normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
        if (dot(reliefNormal, vBaseNormal) < 0.0) reliefNormal *= -1.0;
        float direct = max(0.0, dot(reliefNormal, normalize(sunlight)));
        float luminance = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
        float darkSurface = 1.0 - smoothstep(
          ${LAND_DARK_LUMINANCE.toFixed(2)},
          ${LAND_BRIGHT_LUMINANCE.toFixed(2)},
          luminance
        );
        float toneLift =
          ${LAND_DARK_TONE_LIFT.toFixed(2)} *
          darkSurface *
          mix(1.0, ${LAND_LIT_TONE_FRACTION.toFixed(2)}, direct);
        float liftedLuminance =
          mix(luminance, sqrt(max(luminance, 0.0)), toneLift);
        vec3 balancedAlbedo =
          albedo * (liftedLuminance / max(luminance, 0.001));
        float shadowLift =
          ${LAND_DARK_SHADOW_LIFT.toFixed(2)} * darkSurface;
        float light =
          ${LAND_AMBIENT_LIGHT.toFixed(2)} +
          shadowLift +
          direct * (${LAND_DIRECT_LIGHT.toFixed(2)} - shadowLift);
        vec3 colour = balancedAlbedo * light;
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

function normalizedBounds(bounds: LocalTerrainImageryPatch["targetBounds"]): {
  west: number;
  east: number;
  north: number;
  south: number;
} {
  return {
    west: (bounds.west + 180) / 360,
    east: (bounds.east + 180) / 360,
    north: (90 - bounds.north) / 180,
    south: (90 - bounds.south) / 180,
  };
}

function localImageryMaterial(
  base: THREE.ShaderMaterial,
  patch: LocalTerrainImageryPatch,
): THREE.ShaderMaterial {
  const material = base.clone();
  for (const name of [
    "heightMap",
    "heightOffsetM",
    "heightScaleM",
    "normalizedRadialMetres",
    "normalizedSkirtDepth",
    "oceanSurface",
    "detailMix",
    "outerEdges",
    "unavailableEdges",
    "skirtEdges",
    "sunlight",
  ]) {
    material.uniforms[name] = base.uniforms[name]!;
  }
  const target = normalizedBounds(patch.targetBounds);
  const source = normalizedBounds(patch.sourceBounds);
  const sourceWidth = Math.max(1e-9, source.east - source.west);
  const sourceHeight = Math.max(1e-9, source.south - source.north);
  material.uniforms.detailImageMap!.value = patch.texture;
  material.uniforms.imageryMix!.value = 1;
  material.uniforms.patchBounds = {
    value: new THREE.Vector4(
      target.west,
      target.east,
      target.north,
      target.south,
    ),
  };
  material.uniforms.patchImageScale = {
    value: new THREE.Vector2(1 / sourceWidth, 1 / sourceHeight),
  };
  material.uniforms.patchImageOffset = {
    value: new THREE.Vector2(
      -source.west / sourceWidth,
      -source.north / sourceHeight,
    ),
  };
  material.fragmentShader = material.fragmentShader
    .replace(
      "void main() {",
      `
      uniform vec4 patchBounds;
      uniform vec2 patchImageScale;
      uniform vec2 patchImageOffset;
      void main() {
        if (
          vHeightUv.x < patchBounds.x ||
          vHeightUv.x > patchBounds.y ||
          vHeightUv.y < patchBounds.z ||
          vHeightUv.y > patchBounds.w
        ) discard;
      `,
    )
    .replace(
      "texture2D(detailImageMap, imageUv)",
      "texture2D(detailImageMap, vHeightUv * patchImageScale + patchImageOffset)",
    );
  material.stencilWrite = true;
  material.stencilWriteMask = 0x00;
  material.stencilRef = 1;
  material.stencilFunc = THREE.EqualStencilFunc;
  material.stencilFuncMask = 0xff;
  material.depthWrite = false;
  material.depthFunc = THREE.EqualDepth;
  material.needsUpdate = true;
  return material;
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
  private readonly overbudgetMeshes = new Map<string, string>();
  private readonly pendingDecodeKeys = new Map<string, number>();
  private readonly pendingWorker = new Map<number, PendingWorkerRequest>();
  private readonly meshQueue = new Map<string, QueuedMeshRequest>();
  private readonly installQueue: PreparedLocalTile[] = [];
  private readonly stagedMeshes = new Map<string, PreparedLocalTile>();
  private readonly loadQueue: TileRequestQueue<ElevationPayload>;
  private currentWindow: PreparedTerrainPlan | undefined;
  private candidateWindow: PreparedTerrainPlan | undefined;
  private active = new Map<string, ScreenSpaceLocalTile>();
  private currentLodSignature = "";
  private streamingState: StreamingState = "waiting";
  private generation = 0;
  private requestId = 0;
  private latitudeDegrees = 0;
  private longitudeDegrees = 0;
  private displayRadiusM = 1;
  private radialMultiplier = 1;
  private previousDisplayRadiusM: number | undefined;
  private previousRadialMultiplier: number | undefined;
  private lastScaleChangeMs = -Infinity;
  private scaleMotion = false;
  private oceanSurface = true;
  private imageryPatches: LocalTerrainImageryPatch[] = [];
  private imageryPatchSignature = "";
  private readonly imageryRefreshQueue = new Set<string>();
  private imageryOverlayCount = 0;
  private geometryBytes = 0;
  private activeTileBudget = LOCAL_ACTIVE_TILE_BUDGET;
  private staleWorkerResults = 0;
  private elevationRequestTotal = 0;
  private elevationAbortTotal = 0;
  private elevationRetryTotal = 0;
  private elevationPersistentCacheHits = 0;
  private elevationPersistentCacheWrites = 0;
  private elevationPersistentCacheErrors = 0;
  private elevationPersistentCacheDeletes = 0;
  private lodBias = 0;
  private eyeHeightWorldM = 1.65;
  private focalLengthPixels = 1_000;
  private planningPose: ScreenSpacePlanningPose | undefined;
  private planningFocalLengthPixels = 1_000;
  private planningPoseMovementM = 0;
  private atomicSwapTotal = 0;
  private lastUpdateMs =
    typeof performance === "undefined" ? 0 : performance.now();

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
    for (const key of this.rendered.keys()) {
      this.imageryRefreshQueue.add(key);
    }
  }

  getLodStatus(): {
    minZoom: number;
    maxZoom: number;
    bias: number;
    budgetLimited: boolean;
  } {
    const plan = this.candidateWindow ?? this.currentWindow;
    return {
      minZoom: plan?.minZoom ?? 0,
      maxZoom: plan?.maxZoom ?? 0,
      bias: this.lodBias,
      budgetLimited: plan?.budgetLimited ?? false,
    };
  }

  private stablePlanningView(
    latitudeDegrees: number,
    longitudeDegrees: number,
    eyeHeightWorldM: number,
    focalLengthPixels: number,
  ): ScreenSpacePlanningPose & { focalLengthPixels: number } {
    const current: ScreenSpacePlanningPose = {
      latitudeDegrees,
      longitudeDegrees,
      eyeHeightWorldM,
    };
    if (!this.planningPose) {
      this.planningPose = current;
      this.planningFocalLengthPixels = focalLengthPixels;
      this.planningPoseMovementM = 0;
    } else {
      this.planningPoseMovementM = screenSpacePlanningPoseMovementM(
        this.planningPose,
        current,
        this.displayRadiusM,
      );
      if (
        this.planningPoseMovementM > LOCAL_LOD_HEADPOSE_DEADZONE_M
      ) {
        this.planningPose = current;
        this.planningPoseMovementM = 0;
      }
      const focalRatio =
        focalLengthPixels /
        Math.max(1, this.planningFocalLengthPixels);
      if (Math.abs(Math.log2(focalRatio)) > 0.02) {
        this.planningFocalLengthPixels = focalLengthPixels;
      }
    }
    return {
      ...this.planningPose,
      focalLengthPixels: this.planningFocalLengthPixels,
    };
  }

  update(
    latitudeDegrees: number,
    longitudeDegrees: number,
    displayRadiusM: number,
    radialMultiplier: number,
    oceanSurface: boolean,
    lodBias = 0,
    eyeHeightWorldM = 1.65,
    focalLengthPixels = 1_000,
  ): void {
    const nowMs = typeof performance === "undefined" ? 0 : performance.now();
    const deltaSeconds = Math.max(
      0,
      Math.min(0.1, (nowMs - this.lastUpdateMs) / 1_000),
    );
    this.lastUpdateMs = nowMs;
    if (
      terrainScaleInputChanged(
        this.previousDisplayRadiusM,
        this.previousRadialMultiplier,
        displayRadiusM,
        radialMultiplier,
      )
    ) {
      this.lastScaleChangeMs = nowMs;
    }
    this.previousDisplayRadiusM = displayRadiusM;
    this.previousRadialMultiplier = radialMultiplier;
    this.scaleMotion = !terrainScaleInputIsStable(
      nowMs,
      this.lastScaleChangeMs,
      LOCAL_SCALE_SETTLE_MS,
    );
    this.latitudeDegrees = latitudeDegrees;
    this.longitudeDegrees = longitudeDegrees;
    this.displayRadiusM = displayRadiusM;
    this.radialMultiplier = radialMultiplier;
    this.oceanSurface = oceanSurface;
    this.lodBias = Math.max(-3, Math.min(3, Math.round(lodBias)));
    this.eyeHeightWorldM = Math.max(0.001, eyeHeightWorldM);
    this.focalLengthPixels = Math.max(1, focalLengthPixels);
    if (!this.stencilAvailable || !localDetailEnabled(latitudeDegrees)) {
      this.clearActive();
      this.loadQueue.sync([]);
      this.updateMaterialUniforms(deltaSeconds);
      this.updateDiagnostics();
      return;
    }
    const planningView = this.stablePlanningView(
      latitudeDegrees,
      longitudeDegrees,
      this.eyeHeightWorldM,
      this.focalLengthPixels,
    );
    const previousActiveKeys = new Set(
      (this.currentWindow ?? this.candidateWindow)?.active.map(
        mercatorTileKey,
      ) ?? [],
    );
    const window = this.preparePlan(
      selectScreenSpaceTerrainPlan({
        latitudeDegrees: planningView.latitudeDegrees,
        longitudeDegrees: planningView.longitudeDegrees,
        displayRadiusM,
        eyeHeightWorldM: planningView.eyeHeightWorldM,
        focalLengthPixels: planningView.focalLengthPixels,
        lodBias: this.lodBias,
        previousActiveKeys,
        activeTileBudget: this.activeTileBudget,
        heightTileBudget: LOCAL_HEIGHT_CACHE_LIMIT,
      }),
    );
    const desiredLod = window.signature;
    if (
      this.currentWindow &&
      this.currentLodSignature === desiredLod
    ) {
      this.candidateWindow = undefined;
      this.currentWindow = window;
      this.active = new Map(
        window.active.map((address) => [mercatorTileKey(address), address]),
      );
      for (const [key, tile] of this.rendered) {
        const address = this.active.get(key);
        if (address) tile.address = address;
      }
    } else {
      this.candidateWindow = window;
      if (!this.scaleMotion) {
        this.beginStreaming(window);
      }
    }

    this.updateMaterialUniforms(deltaSeconds);
    this.removeRetiredTiles();
    if (this.candidateWindow && !this.scaleMotion) {
      this.beginStreaming(this.candidateWindow);
    }
    if (this.currentWindow) {
      this.scheduleElevation();
      this.queueBuildableMeshes();
      this.dispatchNextMesh();
      this.stageOnePreparedMesh();
      this.commitReadyReplacements();
      this.updateStreamingCompletion();
    } else {
      this.loadQueue.sync([]);
    }
    this.refreshEdgeTargets();
    this.refreshOneImageryTile();
    this.updateDiagnostics();
  }

  dispose(): void {
    this.loadQueue.dispose();
    this.worker.postMessage({
      type: "dispose",
    } satisfies LocalTerrainWorkerRequest);
    this.worker.terminate();
    this.clearRendered();
  }

  private updateMaterialUniforms(deltaSeconds: number): void {
    const normalizedRadialMetres = normalizedRadialOffsetForMetres(
      1,
      this.radialMultiplier,
    );
    for (const tile of this.rendered.values()) {
      const uniforms = tile.mesh.material.uniforms;
      uniforms.normalizedRadialMetres!.value = normalizedRadialMetres;
      const projectedErrorWorldM =
        normalizedRadialMetres * this.displayRadiusM * tile.actualErrorM * 2;
      const skirtDepthWorldM = Math.max(
        LOCAL_MIN_SKIRT_DEPTH_WORLD_M,
        Math.min(LOCAL_MAX_SKIRT_DEPTH_WORLD_M, projectedErrorWorldM),
      );
      uniforms.normalizedSkirtDepth!.value =
        skirtDepthWorldM / this.displayRadiusM;
      uniforms.oceanSurface!.value = this.oceanSurface ? 1 : 0;
      const transitionSeconds =
        tile.detailTarget < Number(uniforms.detailMix!.value)
          ? LOCAL_RETIRE_SECONDS
          : LOCAL_TRANSITION_SECONDS;
      const transitionStep =
        deltaSeconds <= 0 ? 0 : Math.min(1, deltaSeconds / transitionSeconds);
      const detailMix = Number(uniforms.detailMix!.value);
      uniforms.detailMix!.value =
        detailMix +
        Math.sign(tile.detailTarget - detailMix) *
          Math.min(Math.abs(tile.detailTarget - detailMix), transitionStep);
      uniforms.imageryMix!.value = 0;
      (uniforms.outerEdges!.value as THREE.Vector4).lerp(
        tile.outerEdges,
        transitionStep,
      );
      (uniforms.unavailableEdges!.value as THREE.Vector4).lerp(
        tile.unavailableEdges,
        transitionStep,
      );
      (uniforms.skirtEdges!.value as THREE.Vector4).lerp(
        tile.skirtEdges,
        transitionStep,
      );
    }
  }

  private clearActive(): void {
    this.cancelMeshGeneration();
    this.candidateWindow = undefined;
    this.currentWindow = undefined;
    this.active.clear();
    this.currentLodSignature = "";
    this.streamingState = "waiting";
    this.planningPose = undefined;
    this.planningPoseMovementM = 0;
    this.clearRendered();
  }

  private removeRetiredTiles(): void {
    for (const [key, tile] of this.rendered) {
      if (
        tile.detailTarget <= 0 &&
        Number(tile.mesh.material.uniforms.detailMix!.value) <= 0.001
      ) {
        this.removeRenderedTile(key);
      }
    }
  }

  private clearRendered(): void {
    for (const key of [...this.rendered.keys()]) {
      this.removeRenderedTile(key);
    }
  }

  private removeRenderedTile(key: string): void {
    const tile = this.rendered.get(key);
    if (!tile) return;
    this.imageryRefreshQueue.delete(key);
    this.clearTileOverlays(tile);
    this.group.remove(tile.mesh);
    this.geometryBytes = Math.max(0, this.geometryBytes - tile.geometryBytes);
    tile.mesh.geometry.dispose();
    tile.mesh.material.dispose();
    this.rendered.delete(key);
  }

  private preparePlan(plan: ScreenSpaceTerrainPlan): PreparedTerrainPlan {
    const requestedErrors = new Map<string, number>();
    for (const address of plan.active) {
      const key = mercatorTileKey(address);
      requestedErrors.set(
        key,
        screenSpaceRtinErrorBucket(
          address.distanceWorldM,
          this.displayRadiusM,
          this.radialMultiplier,
          this.planningFocalLengthPixels,
          this.lodBias,
          this.rendered.get(key)?.requestedErrorM,
        ),
      );
    }
    const signature = plan.active
      .map(
        (address) =>
          `${mercatorTileKey(address)}@${requestedErrors.get(
            mercatorTileKey(address),
          )}`,
      )
      .sort()
      .join("|");
    return { ...plan, requestedErrors, signature };
  }

  private beginStreaming(window: PreparedTerrainPlan): void {
    this.cancelMeshGeneration();
    for (const tile of this.rendered.values()) tile.detailTarget = 1;
    this.currentWindow = window;
    this.candidateWindow = undefined;
    this.currentLodSignature = window.signature;
    this.active = new Map(
      window.active.map((address) => [mercatorTileKey(address), address]),
    );
    this.streamingState = "streaming";
  }

  private cancelMeshGeneration(): void {
    this.generation += 1;
    this.meshQueue.clear();
    this.installQueue.length = 0;
    this.stagedMeshes.clear();
  }

  private scheduleElevation(): void {
    const window = this.currentWindow;
    if (!window) {
      this.loadQueue.sync([]);
      return;
    }
    const now = Date.now();
    const tasks: TileLoadTask[] = [];
    for (const task of heightLoadTasksForWindow(window)) {
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
  ): void {
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
    this.pendingWorker.set(requestId, {
      address: task.address,
      kind: "decode",
      generation: this.generation,
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
  }

  private handleElevationFailed(task: TileLoadTask, error: unknown): void {
    if (isAbortError(error)) return;
    const key = mercatorTileKey(task.address);
    if (error instanceof ElevationRequestError && error.status === 404) {
      const decision = elevationFailureDecision("not-found", 1, Date.now());
      if (decision.permanent) this.permanentFailures.add(key);
      this.failedUntil.delete(key);
    } else {
      const retries = (this.retryCounts.get(key) ?? 0) + 1;
      this.retryCounts.set(key, retries);
      const decision = elevationFailureDecision(
        "transient",
        retries,
        Date.now(),
      );
      if (decision.retryScheduled) {
        this.elevationRetryTotal += 1;
      }
      this.failedUntil.set(key, decision.retryAtMs);
    }
    this.queueBuildableMeshes();
    this.refreshEdgeTargets();
    this.scheduleElevation();
    this.updateDiagnostics();
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
      if (result.generation !== this.generation) {
        this.staleWorkerResults += 1;
      }
      this.queueBuildableMeshes();
      this.dispatchNextMesh();
      this.scheduleElevation();
    } else if (result.type === "mesh") {
      if (
        result.generation === this.generation &&
        this.active.has(key) &&
        this.errorForAddress(this.active.get(key)!) === result.requestedErrorM
      ) {
        this.installQueue.push(result);
      } else {
        this.staleWorkerResults += 1;
      }
    } else if (result.type === "overbudget") {
      if (result.generation === this.generation) {
        this.overbudgetMeshes.set(key, this.currentLodSignature);
      } else {
        this.staleWorkerResults += 1;
      }
    } else if (result.missing && pending.kind === "mesh") {
      this.decoded.delete(key);
      this.scheduleElevation();
    } else if (pending.kind === "decode") {
      void deleteCachedElevation(pending.address).then((status) => {
        if (status === "deleted") {
          this.elevationPersistentCacheDeletes += 1;
        } else if (status === "error") {
          this.elevationPersistentCacheErrors += 1;
        }
        this.updateDiagnostics();
      });
      this.failedUntil.set(
        key,
        elevationFailureDecision("malformed", 1, Date.now()).retryAtMs,
      );
      this.queueBuildableMeshes();
    } else if (pending.kind === "mesh") {
      this.failedMeshUntil.set(key, Date.now() + HEIGHT_RETRY_DELAY_MS);
    }
    this.queueBuildableMeshes();
    this.dispatchNextMesh();
    this.refreshEdgeTargets();
    this.updateDiagnostics();
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

  private queueBuildableMeshes(): void {
    if (!this.currentWindow) return;
    for (const address of this.currentWindow.active) {
      const key = mercatorTileKey(address);
      const errorM = this.errorForAddress(address);
      if (this.rendered.get(key)?.requestedErrorM === errorM) continue;
      if (this.meshQueue.get(key)?.errorM === errorM) continue;
      if (
        [...this.pendingWorker.values()].some(
          (pending) =>
            pending.kind === "mesh" &&
            mercatorTileKey(pending.address) === key &&
            pending.generation === this.generation &&
            pending.errorM === errorM,
        )
      )
        continue;
      if (
        this.installQueue.some(
          (result) =>
            mercatorTileKey(result.address) === key &&
            result.requestedErrorM === errorM,
        )
      )
        continue;
      if (this.stagedMeshes.get(key)?.requestedErrorM === errorM) continue;
      if (this.overbudgetMeshes.get(key) === this.currentLodSignature) continue;
      const centreState = this.prerequisiteState(address);
      if (centreState === "ocean" || centreState === "failed") continue;
      if (centreState !== "decoded") continue;
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
      if ((this.failedMeshUntil.get(key) ?? 0) > Date.now()) continue;
      this.failedMeshUntil.delete(key);
      this.meshQueue.set(key, {
        address,
        generation: this.generation,
        errorM,
      });
    }
  }

  private dispatchNextMesh(): void {
    if (
      [...this.pendingWorker.values()].some(
        (pending) => pending.kind === "mesh",
      )
    )
      return;
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
      errorM: task.errorM,
    });
    this.worker.postMessage({
      type: "mesh",
      requestId,
      generation: task.generation,
      address: task.address,
      errorM: task.errorM,
      vertexLimit: LOCAL_MESH_VERTEX_LIMIT,
    } satisfies LocalTerrainWorkerRequest);
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

  private errorForAddress(address: ScreenSpaceLocalTile): number {
    return (
      this.currentWindow?.requestedErrors.get(mercatorTileKey(address)) ??
      screenSpaceRtinErrorBucket(
        address.distanceWorldM,
        this.displayRadiusM,
        this.radialMultiplier,
        this.planningFocalLengthPixels,
        this.lodBias,
        this.rendered.get(mercatorTileKey(address))?.requestedErrorM,
      )
    );
  }

  private stageOnePreparedMesh(): void {
    while (this.installQueue.length > 0) {
      const result = this.installQueue.shift()!;
      const key = mercatorTileKey(result.address);
      if (
        result.generation !== this.generation ||
        !this.active.has(key) ||
        this.errorForAddress(this.active.get(key)!) !== result.requestedErrorM
      ) {
        this.staleWorkerResults += 1;
        continue;
      }
      this.stagedMeshes.set(key, result);
      break;
    }
  }

  private desiredTileTerminal(address: ScreenSpaceLocalTile): boolean {
    const key = mercatorTileKey(address);
    const requestedErrorM = this.errorForAddress(address);
    const existing = this.rendered.get(key);
    if (existing?.requestedErrorM === requestedErrorM) return true;
    if (this.stagedMeshes.get(key)?.requestedErrorM === requestedErrorM) {
      return true;
    }
    const state = this.prerequisiteState(address);
    return (
      state === "ocean" ||
      state === "failed" ||
      this.overbudgetMeshes.get(key) === this.currentLodSignature ||
      (this.failedMeshUntil.get(key) ?? 0) > Date.now()
    );
  }

  private desiredTileSettled(address: ScreenSpaceLocalTile): boolean {
    const key = mercatorTileKey(address);
    const existing = this.rendered.get(key);
    if (existing?.requestedErrorM === this.errorForAddress(address)) return true;
    const state = this.prerequisiteState(address);
    return (
      state === "ocean" ||
      state === "failed" ||
      this.overbudgetMeshes.get(key) === this.currentLodSignature ||
      (this.failedMeshUntil.get(key) ?? 0) > Date.now()
    );
  }

  private commitReadyReplacements(): void {
    const plan = this.currentWindow;
    if (!plan) return;

    // RTIN-only changes never retire a source tile. Replace its geometry after
    // the worker result is ready.
    for (const [key, result] of [...this.stagedMeshes]) {
      if (this.rendered.has(key)) {
        this.commitPreparedMeshes([result], []);
      }
    }

    // Coarsening is one atomic parent-for-descendants swap.
    for (const [key, result] of [...this.stagedMeshes]) {
      const desired = this.active.get(key);
      if (!desired) continue;
      const descendants = [...this.rendered]
        .filter(
          ([renderedKey, tile]) =>
            renderedKey !== key &&
            desired.z < tile.address.z &&
            mercatorTileContains(desired, tile.address),
        )
        .map(([renderedKey]) => renderedKey);
      if (descendants.length > 0) {
        this.commitPreparedMeshes([result], descendants);
      }
    }

    // Refinement keeps the old parent until every desired child in that region
    // is prepared or has reached a terminal fallback state.
    for (const [renderedKey, renderedTile] of [...this.rendered]) {
      if (this.active.has(renderedKey)) continue;
      const desiredDescendants = plan.active.filter(
        (address) =>
          address.z > renderedTile.address.z &&
          mercatorTileContains(renderedTile.address, address),
      );
      if (
        desiredDescendants.length === 0 ||
        !desiredDescendants.every((address) =>
          this.desiredTileTerminal(address),
        )
      ) {
        continue;
      }
      const prepared = desiredDescendants
        .map((address) => this.stagedMeshes.get(mercatorTileKey(address)))
        .filter((result): result is PreparedLocalTile => result !== undefined);
      this.commitPreparedMeshes(prepared, [renderedKey]);
    }

    // Initial tiles and newly exposed, non-overlapping regions can appear as
    // soon as they are ready.
    for (const [key, result] of [...this.stagedMeshes]) {
      const desired = this.active.get(key);
      if (!desired) continue;
      const overlapsLiveTile = [...this.rendered.values()].some((tile) =>
        mercatorTilesOverlap(desired, tile.address),
      );
      if (!overlapsLiveTile) this.commitPreparedMeshes([result], []);
    }

    const allDesiredSettled = plan.active.every((address) =>
      this.desiredTileSettled(address),
    );
    if (allDesiredSettled) {
      for (const [key, tile] of this.rendered) {
        const overlapsDesired = plan.active.some((address) =>
          mercatorTilesOverlap(address, tile.address),
        );
        if (!this.active.has(key) && !overlapsDesired) {
          tile.detailTarget = 0;
        }
      }
    }
  }

  private commitPreparedMeshes(
    results: PreparedLocalTile[],
    conflictKeys: string[],
  ): boolean {
    const validResults = results.filter((result) => {
      const key = mercatorTileKey(result.address);
      const activeAddress = this.active.get(key);
      return (
        result.generation === this.generation &&
        activeAddress !== undefined &&
        this.errorForAddress(activeAddress) === result.requestedErrorM
      );
    });
    if (validResults.length !== results.length) return false;
    const conflicts = new Set(conflictKeys);
    const exactReplacements = new Set(
      validResults
        .map((result) => mercatorTileKey(result.address))
        .filter((key) => this.rendered.has(key)),
    );
    const removedBytes = [...new Set([...conflicts, ...exactReplacements])]
      .reduce(
        (total, key) => total + (this.rendered.get(key)?.geometryBytes ?? 0),
        0,
      );
    const addedBytes = validResults.reduce(
      (total, result) => total + result.geometryBytes,
      0,
    );
    const nextGeometryBytes =
      this.geometryBytes - removedBytes + addedBytes;
    if (nextGeometryBytes > LOCAL_GEOMETRY_BUDGET_BYTES) {
      for (const result of validResults) {
        const key = mercatorTileKey(result.address);
        this.overbudgetMeshes.set(key, this.currentLodSignature);
        this.stagedMeshes.delete(key);
      }
      this.activeTileBudget = Math.max(
        1,
        Math.min(this.activeTileBudget - 1, this.rendered.size),
      );
      return false;
    }
    const geometries = validResults.map((result) => ({
      result,
      geometry: geometryForLocalTile(result),
    }));
    for (const key of conflicts) {
      if (!exactReplacements.has(key)) this.removeRenderedTile(key);
    }
    const instantDetail = conflicts.size > 0;
    for (const { result, geometry } of geometries) {
      const key = mercatorTileKey(result.address);
      const activeAddress = this.active.get(key)!;
      const existing = this.rendered.get(key);
      if (existing) {
        this.replaceRenderedGeometry(existing, activeAddress, result, geometry);
      } else {
        this.addRenderedGeometry(
          activeAddress,
          result,
          geometry,
          instantDetail,
        );
      }
      this.stagedMeshes.delete(key);
    }
    this.geometryBytes = nextGeometryBytes;
    if (conflicts.size > 0) this.atomicSwapTotal += 1;
    this.refreshEdgeTargets();
    this.updateMaterialUniforms(0);
    if (instantDetail) {
      for (const result of validResults) {
        const tile = this.rendered.get(mercatorTileKey(result.address));
        if (!tile) continue;
        const uniforms = tile.mesh.material.uniforms;
        (uniforms.outerEdges!.value as THREE.Vector4).copy(tile.outerEdges);
        (uniforms.unavailableEdges!.value as THREE.Vector4).copy(
          tile.unavailableEdges,
        );
        (uniforms.skirtEdges!.value as THREE.Vector4).copy(tile.skirtEdges);
      }
    }
    return true;
  }

  private replaceRenderedGeometry(
    existing: RenderedLocalTile,
    activeAddress: ScreenSpaceLocalTile,
    result: PreparedLocalTile,
    geometry: THREE.BufferGeometry,
  ): void {
    this.clearTileOverlays(existing);
    const previousGeometry = existing.mesh.geometry;
    existing.mesh.geometry = geometry;
    existing.address = activeAddress;
    existing.requestedErrorM = result.requestedErrorM;
    existing.actualErrorM = result.actualErrorM;
    existing.geometryBytes = result.geometryBytes;
    previousGeometry.dispose();
    existing.detailTarget = 1;
    this.imageryRefreshQueue.add(mercatorTileKey(activeAddress));
  }

  private addRenderedGeometry(
    activeAddress: ScreenSpaceLocalTile,
    result: PreparedLocalTile,
    geometry: THREE.BufferGeometry,
    instantDetail: boolean,
  ): void {
    const key = mercatorTileKey(activeAddress);
    const material = localTerrainMaterial(this.relief, this.fallbackTexture);
    if (instantDetail) material.uniforms.detailMix!.value = 1;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    const tile: RenderedLocalTile = {
      mesh,
      address: activeAddress,
      requestedErrorM: result.requestedErrorM,
      actualErrorM: result.actualErrorM,
      geometryBytes: result.geometryBytes,
      detailTarget: 1,
      overlays: new Map(),
      outerEdges: new THREE.Vector4(),
      unavailableEdges: new THREE.Vector4(),
      skirtEdges: new THREE.Vector4(),
    };
    this.rendered.set(key, tile);
    this.group.add(mesh);
    this.imageryRefreshQueue.add(key);
  }

  private clearTileOverlays(tile: RenderedLocalTile): void {
    for (const overlay of tile.overlays.values()) {
      this.group.remove(overlay);
      overlay.material.dispose();
    }
    this.imageryOverlayCount = Math.max(
      0,
      this.imageryOverlayCount - tile.overlays.size,
    );
    tile.overlays.clear();
  }

  private refreshOneImageryTile(): void {
    const queued = this.imageryRefreshQueue.values().next().value as
      | string
      | undefined;
    if (!queued) return;
    this.imageryRefreshQueue.delete(queued);
    const tile = this.rendered.get(queued);
    if (!tile) return;

    const intersecting = new Map<string, LocalTerrainImageryPatch>();
    const northWest = mercatorCoordinatesForTilePoint(tile.address, 0, 0);
    const southEast = mercatorCoordinatesForTilePoint(
      tile.address,
      LOCAL_TILE_SIZE,
      LOCAL_TILE_SIZE,
    );
    const west = (northWest.longitudeDegrees + 180) / 360;
    const east = (southEast.longitudeDegrees + 180) / 360;
    const north = (90 - northWest.latitudeDegrees) / 180;
    const south = (90 - southEast.latitudeDegrees) / 180;
    for (const patch of this.imageryPatches) {
      const target = normalizedBounds(patch.targetBounds);
      if (
        east < target.west ||
        west > target.east ||
        south < target.north ||
        north > target.south
      )
        continue;
      intersecting.set(`${patch.key}:${patch.texture.uuid}`, patch);
    }

    for (const [patchKey, overlay] of tile.overlays) {
      if (intersecting.has(patchKey)) {
        overlay.geometry = tile.mesh.geometry;
        continue;
      }
      this.group.remove(overlay);
      overlay.material.dispose();
      tile.overlays.delete(patchKey);
      this.imageryOverlayCount = Math.max(0, this.imageryOverlayCount - 1);
    }
    for (const [patchKey, patch] of intersecting) {
      if (tile.overlays.has(patchKey)) continue;
      if (this.imageryOverlayCount >= LOCAL_IMAGERY_OVERLAY_LIMIT) break;
      const material = localImageryMaterial(tile.mesh.material, patch);
      const overlay = new THREE.Mesh(tile.mesh.geometry, material);
      overlay.frustumCulled = false;
      overlay.renderOrder = 1;
      tile.overlays.set(patchKey, overlay);
      this.group.add(overlay);
      this.imageryOverlayCount += 1;
    }
  }

  private refreshEdgeTargets(): void {
    if (!this.currentWindow) return;
    const directions = [
      { deltaX: 0, deltaY: -1, pixelX: 256, pixelY: -0.5 },
      {
        deltaX: 1,
        deltaY: 0,
        pixelX: LOCAL_TILE_SIZE + 0.5,
        pixelY: 256,
      },
      {
        deltaX: 0,
        deltaY: 1,
        pixelX: 256,
        pixelY: LOCAL_TILE_SIZE + 0.5,
      },
      { deltaX: -1, deltaY: 0, pixelX: -0.5, pixelY: 256 },
    ];
    for (const tile of this.rendered.values()) {
      const outer = [0, 0, 0, 0];
      const unavailable = [0, 0, 0, 0];
      const skirts = [0, 0, 0, 0];
      for (let index = 0; index < directions.length; index += 1) {
        const direction = directions[index]!;
        const sameZoomNeighbour = {
          z: tile.address.z,
          x: wrapMercatorX(tile.address.x + direction.deltaX, tile.address.z),
          y: tile.address.y + direction.deltaY,
        };
        if (!isValidMercatorAddress(sameZoomNeighbour)) {
          outer[index] = 1;
          skirts[index] = 1;
          continue;
        }
        const coordinates = mercatorCoordinatesForTilePoint(
          tile.address,
          direction.pixelX,
          direction.pixelY,
        );
        const neighbour = [...this.rendered.values()].find((candidate) => {
          const address = mercatorAddressForCoordinates(
            coordinates.latitudeDegrees,
            coordinates.longitudeDegrees,
            candidate.address.z,
          );
          return (
            address.x === candidate.address.x &&
            address.y === candidate.address.y
          );
        });
        if (!neighbour) {
          outer[index] = 1;
          skirts[index] = 1;
        } else if (neighbour.address.z !== tile.address.z) {
          // Full-resolution RTIN edges align within one source zoom. A shallow
          // skirt hides the T-junction where different source zooms meet.
          skirts[index] = 1;
        }
      }
      tile.outerEdges.fromArray(outer);
      tile.unavailableEdges.fromArray(unavailable);
      tile.skirtEdges.fromArray(skirts);
    }
  }

  private diagnosticStatus(): string {
    if (!this.stencilAvailable) return "disabled";
    if (!this.currentWindow && !this.candidateWindow) return "disabled";
    if (this.rendered.size > 0) return "ready";
    const now = Date.now();
    const target = this.active;
    const allCentresUnavailable = [...target].every(([key]) => {
      const state = this.decoded.peek(key);
      return (
        state === "ocean" ||
        this.permanentFailures.has(key) ||
        (this.failedUntil.get(key) ?? 0) > now ||
        (this.failedMeshUntil.get(key) ?? 0) > now
      );
    });
    return allCentresUnavailable ? "fallback" : "loading";
  }

  private updateStreamingCompletion(): void {
    if (!this.currentWindow || this.streamingState !== "streaming") return;
    const requiredTerminal = this.currentWindow.required.every(
      (address) => this.prerequisiteState(address) !== "pending",
    );
    const activeTerminal = [...this.active.values()].every((address) =>
      this.desiredTileSettled(address),
    );
    const workerBusy = [...this.pendingWorker.values()].some(
      (pending) => pending.kind === "mesh",
    );
    if (
      requiredTerminal &&
      activeTerminal &&
      !workerBusy &&
      this.meshQueue.size === 0 &&
      this.installQueue.length === 0 &&
      this.stagedMeshes.size === 0
    ) {
      this.streamingState = "steady";
    }
  }

  private updateDiagnostics(): void {
    if (typeof document === "undefined") return;
    const targetWindow = this.candidateWindow ?? this.currentWindow;
    const target = targetWindow
      ? new Map(
          targetWindow.active.map((address) => [
            mercatorTileKey(address),
            address,
          ]),
        )
      : this.active;
    const states: string[] = [];
    let readyCells = 0;
    let fallbackCells = 0;
    let overbudgetCells = 0;
    const now = Date.now();
    for (const [key] of target) {
      let state = "p";
      if (this.rendered.has(key)) {
        state = "r";
        readyCells += 1;
      } else if (this.overbudgetMeshes.get(key) === this.currentLodSignature) {
        state = "b";
        fallbackCells += 1;
        overbudgetCells += 1;
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
    const horizonBounds = targetWindow
      ? mercatorHorizonBounds(
          this.latitudeDegrees,
          this.longitudeDegrees,
          this.displayRadiusM,
          this.eyeHeightWorldM,
        )
      : undefined;
    const actualErrors = [
      ...new Set([...this.rendered.values()].map((tile) => tile.actualErrorM)),
    ].sort((first, second) => first - second);
    const requestedErrors = targetWindow
      ? [...new Set(targetWindow.requestedErrors.values())].sort(
          (first, second) => first - second,
        )
      : [];
    const samplePixels = targetWindow?.active.map(
      (tile) => tile.samplePixels,
    ) ?? [];
    document.body.dataset.detailRelief = this.diagnosticStatus();
    document.body.dataset.detailMeshCount = String(this.rendered.size);
    document.body.dataset.detailHeightCache = String(this.decoded.size);
    document.body.dataset.detailHeightRequests = String(
      this.loadQueue.activeCount,
    );
    document.body.dataset.detailWindowOrigin = "";
    document.body.dataset.detailWindowSize = targetWindow
      ? String(targetWindow.active.length)
      : "";
    document.body.dataset.detailTerrainZoom = targetWindow
      ? String(targetWindow.maxZoom)
      : "";
    document.body.dataset.detailActiveZoom = this.currentWindow
      ? String(this.currentWindow.maxZoom)
      : "";
    document.body.dataset.detailTargetZoom = targetWindow
      ? String(targetWindow.maxZoom)
      : "";
    document.body.dataset.detailDesiredZoom = targetWindow
      ? String(targetWindow.maxZoom)
      : "";
    document.body.dataset.detailCalculatedZoom = targetWindow
      ? String(targetWindow.maxZoom)
      : "";
    document.body.dataset.detailZoomOverride = "";
    document.body.dataset.detailSourceZoomRange = targetWindow
      ? `${targetWindow.minZoom}-${targetWindow.maxZoom}`
      : "";
    document.body.dataset.detailLodBias = String(this.lodBias);
    document.body.dataset.detailSourceSampleMetres = "";
    document.body.dataset.detailSourceSamplePixels =
      samplePixels.length > 0
        ? `${Math.min(...samplePixels).toFixed(3)},${Math.max(
            ...samplePixels,
          ).toFixed(3)}`
        : "";
    document.body.dataset.detailRequestedErrorMetres =
      requestedErrors.join(",");
    document.body.dataset.detailActualErrorMetres = actualErrors.join(",");
    document.body.dataset.detailHorizonDegrees = horizonBounds
      ? ((horizonBounds.angularRadiusRadians * 180) / Math.PI).toFixed(3)
      : "";
    document.body.dataset.detailHorizonDistanceKm = horizonBounds
      ? terrainHorizonSourceDistanceKm(
          this.displayRadiusM,
          this.eyeHeightWorldM,
        ).toFixed(1)
      : "";
    document.body.dataset.detailHorizonCoverage = targetWindow
      ? String(targetWindow.active.length > 0)
      : "";
    document.body.dataset.detailCoverageMargins = "";
    document.body.dataset.detailBudgetLimited = String(
      targetWindow?.budgetLimited ?? false,
    );
    document.body.dataset.detailActiveTileBudget = String(
      this.activeTileBudget,
    );
    document.body.dataset.detailStaging = String(
      this.streamingState !== "steady",
    );
    document.body.dataset.detailStreamingState = this.streamingState;
    document.body.dataset.detailScaleMotion = String(this.scaleMotion);
    document.body.dataset.detailLodHeadDeadzoneMetres =
      LOCAL_LOD_HEADPOSE_DEADZONE_M.toFixed(3);
    document.body.dataset.detailLodHeadMovementMetres =
      this.planningPoseMovementM.toFixed(3);
    document.body.dataset.detailStagedMeshes = String(this.stagedMeshes.size);
    document.body.dataset.detailAtomicSwapTotal = String(this.atomicSwapTotal);
    document.body.dataset.detailReadyCells = String(readyCells);
    document.body.dataset.detailFallbackCells = String(fallbackCells);
    document.body.dataset.detailOverbudgetCells = String(overbudgetCells);
    document.body.dataset.detailCentreState = states[0] ?? "p";
    document.body.dataset.detailTileStates = states.join("");
    document.body.dataset.detailImageryCache = "0";
    document.body.dataset.detailImageryRequests = "0";
    document.body.dataset.detailImageryPatches = String(
      this.imageryPatches.length,
    );
    document.body.dataset.detailImageryDraws = String(this.imageryOverlayCount);
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
    document.body.dataset.detailMaterialSide = "front";
  }
}
