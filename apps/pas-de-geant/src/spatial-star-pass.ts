import {
  OCTREE_DEFAULT,
  createStarOctreeProviderService,
  type StarOctreeProviderService,
  type StarOctreeProviderSession,
} from "@found-in-space/star-octree-provider";
import {
  createObserverShellStrategy,
  type StarCellData,
  type StarCellDelta,
} from "@found-in-space/star-trees";
import {
  createSkykitStarPreloadRequestsFromSpatialHints,
} from "@found-in-space/skykit";
import {
  createThreeStarField,
  type ThreeStarField,
  type ThreeStarFieldMaterialProfile,
  type ThreeStarFieldView,
} from "@found-in-space/three-star-field";
import * as THREE from "three";
import {
  STELLAR_METRES_PER_PARSEC,
  type JourneyVector3,
} from "./earth-to-gaia-journey.js";

export const SPATIAL_STAR_LIMITING_MAGNITUDE = 6.5;
export const SYNTHETIC_SUN_ABSOLUTE_MAGNITUDE = 4.83;
export const SYNTHETIC_SUN_TEMPERATURE_K = 5_772;

export interface SpatialStarView {
  /** Fixed catalogue viewpoint; the journey keeps this stable for sky continuity. */
  readonly observerJ2000Pc: JourneyVector3;
  /** Independently authored viewpoint used only to place and photometer the Sun. */
  readonly sunObserverJ2000Pc: JourneyVector3;
  readonly j2000ToWorld: THREE.Quaternion;
  /** World-space tracking origin used to derive per-eye and room offsets. */
  readonly trackingAnchorWorld: THREE.Vector3;
  readonly parallaxBlend: number;
  readonly sunOpacity: number;
}

export interface SpatialStarSnapshot {
  readonly status: "idle" | "loading" | "ready" | "failed" | "disposed";
  readonly starCount: number;
  readonly lastError: string | null;
}

export interface SpatialStarPassOptions {
  readonly provider?: StarOctreeProviderService;
}

interface ProjectionMaterial {
  readonly profile: ThreeStarFieldMaterialProfile;
  setView(view: SpatialStarView, opacity: number): void;
}

export class SpatialStarPass {
  readonly scene = new THREE.Scene();

  private readonly provider: StarOctreeProviderService;
  private readonly ownsProvider: boolean;
  private readonly catalogField: ThreeStarField;
  private readonly sunField: ThreeStarField;
  private readonly catalogMaterial: ProjectionMaterial;
  private readonly sunMaterial: ProjectionMaterial;
  private readonly session: StarOctreeProviderSession;
  private readonly unsubscribe: () => void;
  private readonly liveCells = new Map<string, StarCellData>();
  private lastValidCells = new Map<string, StarCellData>();
  private status: SpatialStarSnapshot["status"] = "idle";
  private lastError: string | null = null;
  private disposed = false;
  private initialLoad: Promise<void> | null = null;

  constructor(options: SpatialStarPassOptions = {}) {
    this.provider = options.provider ?? createStarOctreeProviderService({
      url: OCTREE_DEFAULT,
      persistentCache: "on",
    });
    this.ownsProvider = options.provider === undefined;
    this.catalogMaterial = createProjectionMaterial();
    this.sunMaterial = createProjectionMaterial();
    this.catalogField = createThreeStarField({
      id: "pas-de-geant-spatial-stars",
      materialProfile: this.catalogMaterial.profile,
      disposeMaterialProfile: true,
      frustumCulled: false,
    });
    this.sunField = createThreeStarField({
      id: "pas-de-geant-stellar-sun",
      materialProfile: this.sunMaterial.profile,
      disposeMaterialProfile: true,
      frustumCulled: false,
    });
    this.sunField.setCells([syntheticSunCell()]);
    this.scene.add(this.catalogField.object3d, this.sunField.object3d);
    this.session = this.provider.createSession({
      id: "pas-de-geant-spatial-stars",
      strategy: createObserverShellStrategy(),
      attributes: ["position", "teffLog8", "magAbs"],
      memory: { ownership: "copy" },
    });
    this.unsubscribe = this.session.subscribe((delta) => {
      if (this.disposed) return;
      if (delta.type === "stars/cells-upsert") {
        for (const cell of delta.cells) this.liveCells.set(cell.cellKey, cell);
      } else if (delta.type === "stars/cells-remove") {
        for (const cellKey of delta.cellKeys) this.liveCells.delete(cellKey);
      }
      if (delta.type === "stars/error") {
        this.status = "failed";
        this.lastError = delta.error.message;
        if (this.lastValidCells.size > 0) {
          this.liveCells.clear();
          for (const [cellKey, cell] of this.lastValidCells) {
            this.liveCells.set(cellKey, cell);
          }
          this.catalogField.setCells(this.lastValidCells.values());
        }
      }
      this.catalogField.apply(delta);
      if (delta.type === "stars/current") {
        if (delta.starCount > 0 && this.liveCells.size > 0) {
          this.lastValidCells = new Map(this.liveCells);
          this.status = "ready";
          this.lastError = null;
        } else {
          this.status = "failed";
          this.lastError = "SkyKit returned no stars for the current observer.";
          if (this.lastValidCells.size > 0) {
            this.liveCells.clear();
            for (const [cellKey, cell] of this.lastValidCells) {
              this.liveCells.set(cellKey, cell);
            }
            this.catalogField.setCells(this.lastValidCells.values());
          }
        }
      } else if (delta.type !== "stars/error") {
        this.status = "loading";
      }
    });
  }

  load(
    observerJ2000Pc: JourneyVector3,
    signal?: AbortSignal,
  ): Promise<void> {
    this.status = "loading";
    this.initialLoad ??= this.provider.ensureBootstrap()
      .then(() => undefined)
      .catch((error) => {
        this.status = "failed";
        this.lastError = errorMessage(error);
        this.initialLoad = null;
        throw error;
      });
    const bootstrap = this.initialLoad;
    return bootstrap.then(() => {
      throwIfAbortedSignal(signal);
      return this.waitForCurrent(observerJ2000Pc, signal);
    })
      .catch((error) => {
        this.status = "failed";
        this.lastError = errorMessage(error);
        throw error;
      });
  }

  async warmJourney(
    routePointsPc: readonly JourneyVector3[],
    destinationPc: JourneyVector3,
    signal: AbortSignal,
  ): Promise<void> {
    if (routePointsPc.length < 2) {
      throw new Error("The stellar preload route needs at least two points.");
    }
    await this.provider.ensureBootstrap();
    throwIfAborted(signal);
    const sampleIndices = [
      0,
      Math.floor((routePointsPc.length - 1) / 2),
      routePointsPc.length - 1,
    ];
    const shellWarmups = sampleIndices.map((index) =>
      this.provider.warmCells({
        id: `earth-to-gaia-shell-${index}`,
        strategy: createObserverShellStrategy(),
        view: {
          observerPc: routePointsPc[index]!,
          limitingMagnitude: SPATIAL_STAR_LIMITING_MAGNITUDE,
          mDesired: SPATIAL_STAR_LIMITING_MAGNITUDE,
        },
        attributes: ["position", "teffLog8", "magAbs"],
        signal,
      })
    );
    const preloadRequests = createSkykitStarPreloadRequestsFromSpatialHints([
      {
        kind: "path-volume",
        pointsPc: Array.from(routePointsPc),
        radiusPc: 0.25,
        priority: 1,
      },
      {
        kind: "sphere-volume",
        centerPc: destinationPc,
        radiusPc: 30,
        priority: 2,
      },
    ]);
    const volumeWarmups = preloadRequests.map((request, index) =>
      this.provider.warmCells({
        id: `earth-to-gaia-volume-${index}`,
        strategy: request.strategy,
        ...(request.view ? { view: request.view } : {}),
        attributes: ["position", "teffLog8", "magAbs"],
        signal,
      })
    );
    await Promise.all([...shellWarmups, ...volumeWarmups]);
    throwIfAborted(signal);
  }

  setView(view: SpatialStarView): void {
    if (this.disposed) return;
    this.catalogMaterial.setView(view, 1);
    this.sunMaterial.setView({
      ...view,
      observerJ2000Pc: view.sunObserverJ2000Pc,
    }, view.sunOpacity);
    this.session.updateView({
      observerPc: view.observerJ2000Pc,
      limitingMagnitude: SPATIAL_STAR_LIMITING_MAGNITUDE,
      mDesired: SPATIAL_STAR_LIMITING_MAGNITUDE,
    }, { reason: "pas-de-geant.observer" });
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (!this.disposed) renderer.render(this.scene, camera);
  }

  getSnapshot(): SpatialStarSnapshot {
    return {
      status: this.status,
      starCount: this.catalogField.getSnapshot().starCount,
      lastError: this.lastError,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.status = "disposed";
    this.unsubscribe();
    await this.session.dispose();
    this.catalogField.dispose();
    this.sunField.dispose();
    this.scene.clear();
    this.liveCells.clear();
    this.lastValidCells.clear();
    if (this.ownsProvider) await this.provider.dispose();
  }

  private async waitForCurrent(
    observerJ2000Pc: JourneyVector3,
    signal?: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let requestedViewRevision: number | undefined;
      let pendingCurrent: Extract<
        StarCellDelta,
        { type: "stars/current" }
      > | undefined;
      const finish = (result: "resolve" | "reject", error?: Error): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        if (result === "resolve") resolve();
        else reject(error);
      };
      const onAbort = (): void => finish(
        "reject",
        new DOMException("Stellar preload aborted.", "AbortError"),
      );
      const acceptCurrent = (
        delta: NonNullable<typeof pendingCurrent>,
      ): void => {
        if (
          requestedViewRevision !== undefined &&
          delta.viewRevision !== undefined &&
          delta.viewRevision < requestedViewRevision
        ) return;
        if (delta.starCount > 0 && this.liveCells.size > 0) {
          finish("resolve");
        } else {
          finish(
            "reject",
            new Error("SkyKit returned no stars for the current observer."),
          );
        }
      };
      const unsubscribe = this.session.subscribe((delta) => {
        if (delta.type === "stars/current") {
          if (requestedViewRevision === undefined) pendingCurrent = delta;
          else acceptCurrent(delta);
        } else if (delta.type === "stars/error") {
          finish("reject", new Error(delta.error.message));
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const receipt = this.session.updateView({
        observerPc: observerJ2000Pc,
        limitingMagnitude: SPATIAL_STAR_LIMITING_MAGNITUDE,
        mDesired: SPATIAL_STAR_LIMITING_MAGNITUDE,
      }, { demand: "force", reason: "pas-de-geant.initial" });
      requestedViewRevision = receipt.viewRevision;
      if (pendingCurrent) acceptCurrent(pendingCurrent);
    });
  }
}

function createProjectionMaterial(): ProjectionMaterial {
  const uniforms = {
    uObserverPc: { value: new THREE.Vector3() },
    uTrackingAnchorWorld: { value: new THREE.Vector3() },
    uWorldToJ2000: { value: new THREE.Matrix3() },
    uJ2000ToWorld: { value: new THREE.Matrix3() },
    uParallaxBlend: { value: 0 },
    uMetresPerParsec: { value: STELLAR_METRES_PER_PARSEC },
    uLimitingMagnitude: { value: SPATIAL_STAR_LIMITING_MAGNITUDE },
    uOpacity: { value: 1 },
    uExposure: { value: 2_500 },
    uBaseSize: { value: 0.9 },
    uSizeScale: { value: 3 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: STAR_VERTEX_SHADER,
    fragmentShader: STAR_FRAGMENT_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const rotationMatrix = new THREE.Matrix4();
  const inverseQuaternion = new THREE.Quaternion();
  const profile: ThreeStarFieldMaterialProfile = {
    material,
    haloMaterial: null,
    updateUniforms({ view }: { view: ThreeStarFieldView }) {
      uniforms.uLimitingMagnitude.value = view.limitingMagnitude;
    },
    dispose() {
      material.dispose();
    },
  };
  return {
    profile,
    setView(view, opacity) {
      uniforms.uObserverPc.value.set(
        view.observerJ2000Pc.x,
        view.observerJ2000Pc.y,
        view.observerJ2000Pc.z,
      );
      uniforms.uTrackingAnchorWorld.value.copy(view.trackingAnchorWorld);
      uniforms.uParallaxBlend.value = THREE.MathUtils.clamp(
        view.parallaxBlend,
        0,
        1,
      );
      uniforms.uOpacity.value = THREE.MathUtils.clamp(opacity, 0, 1);
      rotationMatrix.makeRotationFromQuaternion(view.j2000ToWorld);
      uniforms.uJ2000ToWorld.value.setFromMatrix4(rotationMatrix);
      inverseQuaternion.copy(view.j2000ToWorld).invert();
      rotationMatrix.makeRotationFromQuaternion(inverseQuaternion);
      uniforms.uWorldToJ2000.value.setFromMatrix4(rotationMatrix);
    },
  };
}

function syntheticSunCell(): StarCellData {
  return {
    cellKey: "0:pas-de-geant-sun",
    cell: { level: 0, mortonCode: "pas-de-geant-sun" },
    bounds: {
      centerPc: { x: 0, y: 0, z: 0 },
      halfSizePc: 0,
      gridX: 0,
      gridY: 0,
      gridZ: 0,
    },
    count: 1,
    coordinates: {
      name: "icrs-parsec-position",
      frame: "icrs",
      units: ["pc", "pc", "pc"],
      components: new Float32Array([0, 0, 0]),
    },
    attributes: {
      magAbs: new Float32Array([SYNTHETIC_SUN_ABSOLUTE_MAGNITUDE]),
      teffLog8: new Uint8Array([
        encodeTemperature(SYNTHETIC_SUN_TEMPERATURE_K),
      ]),
    },
  };
}

function encodeTemperature(temperatureK: number): number {
  const normalized = Math.log(temperatureK / 2_000) / Math.log(25);
  return Math.round(THREE.MathUtils.clamp(normalized, 0, 1) * 255);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Stellar preload aborted.", "AbortError");
}

function throwIfAbortedSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Stellar preload aborted.", "AbortError");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STAR_VERTEX_SHADER = /* glsl */ `
  attribute float teff_log8;
  attribute float magAbs;

  uniform vec3 uObserverPc;
  uniform vec3 uTrackingAnchorWorld;
  uniform mat3 uWorldToJ2000;
  uniform mat3 uJ2000ToWorld;
  uniform float uParallaxBlend;
  uniform float uMetresPerParsec;
  uniform float uLimitingMagnitude;
  uniform float uOpacity;
  uniform float uExposure;
  uniform float uBaseSize;
  uniform float uSizeScale;

  varying vec3 vColor;
  varying float vAlpha;

  float decodeTemperature(float log8) {
    if (log8 >= 0.996) return 5800.0;
    return 2000.0 * pow(25.0, log8);
  }

  vec3 blackbodyToRGB(float temp) {
    float t = clamp(temp, 1000.0, 40000.0) / 100.0;
    vec3 c;
    if (t <= 66.0) c.r = 255.0;
    else c.r = 329.698727446 * pow(t - 60.0, -0.1332047592);
    if (t <= 66.0) c.g = 99.4708025861 * log(t) - 161.119568166;
    else c.g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
    if (t >= 66.0) c.b = 255.0;
    else if (t <= 19.0) c.b = 0.0;
    else c.b = 138.5177312231 * log(t - 10.0) - 305.0447927307;
    return clamp(c / 255.0, 0.0, 1.0);
  }

  void main() {
    vec3 trackedWorldM = cameraPosition - uTrackingAnchorWorld;
    vec3 trackedPc = uWorldToJ2000 * trackedWorldM /
      max(uMetresPerParsec, 0.000001);
    vec3 eyeObserverPc = uObserverPc + trackedPc * uParallaxBlend;
    vec3 relativePc = position - eyeObserverPc;
    float distancePc = max(length(relativePc), 0.000001);
    float apparentMag = magAbs + 5.0 * (log(distancePc) / log(10.0) - 1.0);
    float magnitudeFade = 1.0 - smoothstep(
      uLimitingMagnitude - 0.75,
      uLimitingMagnitude,
      apparentMag
    );
    float flux = pow(10.0, -0.4 * apparentMag);
    float energy = max(flux * uExposure, 0.0);
    gl_PointSize = magnitudeFade > 0.0
      ? uBaseSize + uSizeScale * pow(energy, 0.32)
      : 0.0;
    vAlpha = magnitudeFade * clamp(1.0 - exp(-energy), 0.04, 1.0) * uOpacity;
    vColor = blackbodyToRGB(decodeTemperature(teff_log8));

    vec3 worldDirection = uJ2000ToWorld * (relativePc / distancePc);
    vec3 viewDirection = mat3(viewMatrix) * worldDirection;
    if (viewDirection.z >= -0.000001 || vAlpha <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    vec4 clip = projectionMatrix * vec4(viewDirection, 1.0);
    clip.z = clip.w * 0.999999;
    gl_Position = clip;
  }
`;

const STAR_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    if (vAlpha <= 0.0) discard;
    float distanceFromCentre = distance(gl_PointCoord, vec2(0.5));
    if (distanceFromCentre > 0.5) discard;
    float core = exp(-distanceFromCentre * 16.0);
    float halo = 1.0 - smoothstep(0.08, 0.5, distanceFromCentre);
    float alpha = max(core, halo * 0.28) * vAlpha;
    if (alpha < 0.003) discard;
    vec3 color = mix(vColor, vec3(1.0), core * 0.55);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;
