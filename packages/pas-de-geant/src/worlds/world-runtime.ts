import * as THREE from "three";
import { type CelestialBodyDefinition } from "./solar-system.js";
import { createBodySurfaceModel, type SurfaceModel } from "./surface-model.js";
import { TerrainSurface, type TerrainSurfaceOptions, type TerrainSurfaceView } from "./terrain-surface.js";
import { FlatElevationTileProvider } from "./elevation-tile-provider.js";
import { observeBodySurface } from "./surface-observation.js";

export interface WorldSurfaceSource extends Omit<TerrainSurfaceOptions, "renderer" | "initialView"> {
  /** A failed initial source-base request also permits the supplied fallback to become ready. */
  readonly baseFallback?: boolean;
  readonly disposeBaseTexture?: boolean;
  readonly disposeNightTexture?: boolean;
}

export interface WorldRuntimeOptions {
  readonly body: CelestialBodyDefinition;
  readonly renderer: THREE.WebGLRenderer;
  readonly initialView: TerrainSurfaceView;
  readonly surface?: WorldSurfaceSource;
  readonly root?: THREE.Group;
}

export interface WorldReadiness {
  readonly ready: boolean;
  readonly imagery: "base" | "loading" | "ready" | "fallback";
}

/** Complete body-root pose in its parent's render coordinates. */
export interface WorldPose {
  readonly position: THREE.Vector3;
  readonly orientation: THREE.Quaternion;
  readonly displayRadiusM: number;
}

/** Supply the host's desktop camera; the renderer supplies XR eyes when presenting. */
export interface WorldCameraFrame {
  readonly pose: WorldPose;
  readonly camera: THREE.Camera;
  readonly terrainMultiplier: number;
}

/** Caller supplies URLs and owns provenance; a failed source leaves a usable base. */
export async function loadWorldBaseTexture(options: {
  sourceUrl?: string;
  fallbackUrl: string;
  loadTexture?: (url: string) => Promise<THREE.Texture>;
}): Promise<{ texture: THREE.Texture; baseFallback: boolean }> {
  const load = options.loadTexture ?? ((url) => new THREE.TextureLoader().loadAsync(url));
  if (options.sourceUrl) {
    try {
      return { texture: await load(options.sourceUrl), baseFallback: false };
    } catch {
      return { texture: await load(options.fallbackUrl), baseFallback: true };
    }
  }
  return { texture: await load(options.fallbackUrl), baseFallback: false };
}

/** A source failure makes the rendered base usable; streaming may still recover later. */
export function worldSurfaceReadiness(options: {
  committedSurface: boolean;
  configuredImagery: boolean;
  completeImagery: boolean;
  imageryFailed: boolean;
}): WorldReadiness {
  const imagery = !options.configuredImagery ? "base"
    : options.completeImagery ? "ready"
    : options.imageryFailed ? "fallback" : "loading";
  return { ready: options.committedSurface && imagery !== "loading", imagery };
}

export interface WorldRuntime {
  readonly body: CelestialBodyDefinition;
  readonly object3d: THREE.Group;
  readonly surfaceModel: SurfaceModel;
  readonly surface: TerrainSurface | null;
  /** Apply a complete pose, measure the rendered view, then update tile selection. */
  updateFromCamera(frame: WorldCameraFrame): TerrainSurfaceView;
  /** Explicit low-level path for a host that already owns a complete measured view. */
  update(view: TerrainSurfaceView): void;
  /** Last view supplied to tile selection, or the initial seed before the first update. */
  getView(): TerrainSurfaceView;
  processFrame(): void;
  beforeRender(camera: THREE.Camera): void;
  setSunlightDirection(directionWorld: THREE.Vector3): void;
  getReadiness(): WorldReadiness;
  dispose(): void;
}

export function createWorldRuntime(
  options: WorldRuntimeOptions & { surface: WorldSurfaceSource },
): WorldRuntime & { readonly surface: TerrainSurface };
export function createWorldRuntime(options: WorldRuntimeOptions): WorldRuntime;
export function createWorldRuntime(options: WorldRuntimeOptions): WorldRuntime {
  const object3d = options.root ?? new THREE.Group();
  object3d.name ||= `${options.body.id}-root`;
  const surfaceModel = options.surface?.surfaceModel ?? createBodySurfaceModel(options.body);
  if (options.surface) {
    const texture = options.surface.baseTexture;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
  }
  const surface = options.surface ? new TerrainSurface({
    ...options.surface,
    surfaceModel,
    elevationProvider: options.surface.elevationProvider ??
      new FlatElevationTileProvider(surfaceModel.elevationMetadata.tilePixels),
    renderer: options.renderer,
    initialView: options.initialView,
  }) : null;
  const globe = surface ? null : new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 24),
    new THREE.MeshStandardMaterial({
      color: options.body.placeholderColor,
      roughness: 0.88,
      emissive: options.body.id === "sun" ? options.body.placeholderColor : 0,
      emissiveIntensity: options.body.id === "sun" ? 1 : 0,
    }),
  );
  if (globe) {
    const { shape, referenceRadiusM } = options.body;
    if (shape.kind === "sphere") {
      globe.scale.setScalar(shape.radiusM / referenceRadiusM);
    } else {
      globe.scale.set(
        shape.equatorialRadiusM / referenceRadiusM,
        shape.polarRadiusM / referenceRadiusM,
        shape.equatorialRadiusM / referenceRadiusM,
      );
    }
  }
  const content = surface?.group ?? globe!;
  object3d.add(content);
  object3d.scale.setScalar(options.initialView.displayRadiusM);
  let latestView = { ...options.initialView, projection: surfaceModel.projection };
  const drawingBuffer = new THREE.Vector2();
  function updateSurface(view: TerrainSurfaceView) {
    latestView = { ...view, projection: surfaceModel.projection };
    surface?.update(latestView);
  }
  let disposed = false;
  return {
    body: options.body, object3d, surfaceModel, surface,
    updateFromCamera(frame) {
      object3d.position.copy(frame.pose.position);
      object3d.quaternion.copy(frame.pose.orientation);
      object3d.scale.setScalar(frame.pose.displayRadiusM);
      if (options.renderer.xr?.isPresenting && frame.camera instanceof THREE.PerspectiveCamera) {
        // Also works without Geant movement: a host may have changed the rig this frame.
        frame.camera.parent?.updateWorldMatrix(true, false);
        options.renderer.xr.updateCamera(frame.camera);
      }
      const camera = options.renderer.xr?.isPresenting ? options.renderer.xr.getCamera() : frame.camera;
      let focalLengthPixels = 1;
      if (camera instanceof THREE.ArrayCamera) {
        // XR matrices belong to WebXR. Their viewports are independent of the desktop canvas.
        for (const eye of camera.cameras) {
          if (eye.viewport) focalLengthPixels = Math.max(focalLengthPixels, eye.viewport.w * eye.projectionMatrix.elements[5]! * 0.5);
        }
      } else {
        options.renderer.getDrawingBufferSize(drawingBuffer);
        focalLengthPixels = Math.max(1, drawingBuffer.y * camera.projectionMatrix.elements[5]! * 0.5);
      }
      const view: TerrainSurfaceView = {
        ...observeBodySurface({ bodyId: options.body.id, root: object3d, camera,
          surface: surface ?? { sampleElevationMetres: () => 0 }, terrainMultiplier: frame.terrainMultiplier }),
        terrainMultiplier: frame.terrainMultiplier, focalLengthPixels,
      };
      updateSurface(view);
      return { ...latestView };
    },
    update(view) {
      object3d.scale.setScalar(view.displayRadiusM);
      updateSurface(view);
    },
    getView() { return { ...latestView }; },
    processFrame() { surface?.processFrame(); },
    beforeRender(camera) { surface?.updateRenderVisibility(camera); },
    setSunlightDirection(direction) { surface?.setSunlightDirection(direction); },
    getReadiness() {
      if (!surface) return { ready: true, imagery: "base" };
      return worldSurfaceReadiness({
        committedSurface: surface.hasCommittedSurface,
        configuredImagery: Boolean(options.surface?.imageryProvider || options.surface?.nightImageryProvider),
        completeImagery: surface.hasCompleteImagery,
        imageryFailed: Boolean(options.surface?.baseFallback) || surface.hasImageryFailure,
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      surface?.dispose();
      globe?.geometry.dispose();
      globe?.material.dispose();
      object3d.remove(content);
      if (options.surface?.disposeBaseTexture) options.surface.baseTexture.dispose();
      if (options.surface?.disposeNightTexture) options.surface.nightTexture?.dispose();
    },
  };
}
