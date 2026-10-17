import * as THREE from "three";
import { createSkykitViewer, type SkykitActionMetadata, type SkykitPluginContext, type SkykitPluginInput, type SkykitViewer, type SkykitViewerOptions } from "./skykit-runtime.js";
import { resolveGeantConfiguration, type GeantConfiguration } from "./config.js";
import { createGeantNavigation, type GeantNavigation } from "./navigation/controller.js";
import { registerGeantMotionActions } from "./navigation/motion.js";
import type { SolarSystemBodyId, Vector3d } from "./worlds/solar-system.js";
import type { WorldRuntime } from "./worlds/world-runtime.js";

const GEANT_CONTEXT = Symbol("geant:context");
export interface GeantContext {
  readonly three: typeof THREE;
  readonly navigation: GeantNavigation;
  readonly presentation: { observerJ2000M: Vector3d | null; originJ2000M: Vector3d; systemRotation: THREE.Quaternion; translation: THREE.Vector3 };
  movement: { command(action: string, payload: Readonly<Record<string, unknown>>, metadata?: SkykitActionMetadata): unknown } | null;
  movementRevision: number;
  readonly host: HTMLElement | null;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly cameraRoot: THREE.Group;
  readonly worlds: ReadonlyMap<SolarSystemBodyId, WorldRuntime>;
}
export function getGeantContext(context: SkykitPluginContext): GeantContext {
  return context.useStore<GeantContext>(GEANT_CONTEXT, () => { throw new Error("This plugin requires a Geant viewer."); });
}
export interface GeantViewerOptions extends GeantConfiguration {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene?: THREE.Scene;
  readonly camera?: THREE.PerspectiveCamera;
  readonly cameraRoot?: THREE.Group;
  readonly host?: HTMLElement;
  readonly plugins?: Iterable<SkykitPluginInput>;
}
/** Explicit composition: owns domain state and plugins, borrows the supplied renderer. */
export async function createGeantViewer(options: GeantViewerOptions) {
  const configuration = resolveGeantConfiguration(options);
  const navigation = createGeantNavigation(configuration);
  const scene = options.scene ?? new THREE.Scene();
  const camera = options.camera ?? new THREE.PerspectiveCamera(62, 1, 0.025, 100_000_000);
  const cameraRoot = options.cameraRoot ?? new THREE.Group();
  const previousCameraParent = camera.parent;
  const previousRootParent = cameraRoot.parent;
  function restoreCameraRoots() {
    if (previousCameraParent !== cameraRoot) { camera.removeFromParent(); previousCameraParent?.add(camera); }
    if (!options.cameraRoot) cameraRoot.removeFromParent();
    else if (cameraRoot.parent !== previousRootParent) { cameraRoot.removeFromParent(); previousRootParent?.add(cameraRoot); }
  }
  cameraRoot.name ||= "geant-observer";
  cameraRoot.add(camera); scene.add(cameraRoot);
  const worlds = new Map<SolarSystemBodyId, WorldRuntime>();
  const context: GeantContext = { three: THREE, navigation, movement: null, movementRevision: 0,
    presentation: { observerJ2000M: null, originJ2000M: { x: 0, y: 0, z: 0 }, systemRotation: new THREE.Quaternion(), translation: new THREE.Vector3() },
    scene, camera, renderer: options.renderer, host: options.host ?? null, cameraRoot, worlds };
  // Geant owns physical navigation. SkyKit supplies parts/actions, without its star-flight input policy.
  const observerRig: SkykitViewerOptions["observerRig"] = {
    type: "geant", getObserverPc: () => ({ x: 0, y: 0, z: 0 }), getRenderObserverPosition: () => ({ x: 0, y: 0, z: 0 }),
  };
  let viewer: SkykitViewer | undefined;
  try {
    viewer = await createSkykitViewer({ scene, camera, cameraRoot: false, renderer: options.renderer, observerRig, autoMountRenderer: false });
    await viewer.addPlugin({ id: "geant:domain", setup(ctx) {
      ctx.useStore(GEANT_CONTEXT, () => context);
      ctx.addDisposable(navigation.register(ctx.actions));
      ctx.addDisposable(registerGeantMotionActions(context, ctx.actions));
      ctx.addDisposable(() => navigation.dispose());
    } });
    for (const plugin of options.plugins ?? []) await viewer.addPlugin(plugin);
  } catch (error) {
    await viewer?.dispose(); navigation.dispose(); restoreCameraRoots(); throw error;
  }
  const runtime = viewer;
  const disposables = new Set<() => void | Promise<void>>();
  let disposal: Promise<void> | undefined;
  return {
    viewer: runtime, context, three: THREE, configuration, navigation, actions: runtime.actions, scene, camera, renderer: options.renderer, cameraRoot,
    worlds,
    update: runtime.update, render: runtime.render, frame: runtime.frame, resize: runtime.resize,
    install: (plugin: SkykitPluginInput) => runtime.addPlugin(plugin),
    getSnapshot: navigation.getSnapshot,
    addDisposable(dispose: () => void | Promise<void>) {
      disposables.add(dispose);
      return () => { disposables.delete(dispose); };
    },
    dispose(): Promise<void> {
      disposal ??= (async () => {
        const errors: unknown[] = [];
        for (const dispose of [...disposables].reverse()) { try { await dispose(); } catch (error) { errors.push(error); } }
        disposables.clear();
        try { await runtime.dispose(); } catch (error) { errors.push(error); }
        restoreCameraRoots(); worlds.clear();
        if (!options.scene) scene.clear();
        if (errors.length) throw new AggregateError(errors, "Geant viewer cleanup failed.");
      })();
      return disposal;
    },
  };
}
export type GeantViewer = Awaited<ReturnType<typeof createGeantViewer>>;
