import { observeBodySurface, referenceSurfaceObservation } from "../worlds/surface-observation.js";
import * as THREE from "three";
import type { SkykitPlugin, SkykitThreeFrame } from "@found-in-space/skykit";
import { getGeantContext, type GeantContext } from "../viewer.js";
import type { GeantSurfaceFactory } from "../config.js";
import { bodyPositionJ2000M, bodyRotation, celestialBody, type SolarSystemBodyId, type Vector3d } from "../worlds/solar-system.js";
import { bodyFixedToRenderQuaternion } from "../worlds/body-attitude.js";
import { displayRadiusForScale, relativeJ2000MetresToRender, translatedObserverJ2000M } from "../worlds/world-navigation.js";
import { solveBodySurfacePose } from "../worlds/planet-state.js";
import { createWorldRuntime, type WorldRuntime, type WorldSurfaceSource } from "../worlds/world-runtime.js";
import type { TerrainSurfaceView } from "../worlds/terrain-surface.js";
import { GEANT_ACTIONS } from "../navigation/controller.js";

export interface GeantWorldsOptions {
  readonly workers?: import("../worlds/workers.js").WorldWorkerFactory;
  readonly surfaces?: Readonly<Partial<Record<SolarSystemBodyId, GeantSurfaceFactory>>>;
  readonly signal?: AbortSignal;
}
/** A reusable world composition. It retains the existing surface planners and renderers. */
export function createGeantWorldsPlugin(options: GeantWorldsOptions = {}) {
  let geant: GeantContext;
  const runtimes = new Map<SolarSystemBodyId, WorldRuntime>();
  const controllers = new Map<SolarSystemBodyId, AbortController>();
  let disposed = false;
  let previousMode: string | undefined;
  let lastObserver: Vector3d | undefined;
  let previousTrackedPosition: THREE.Vector3 | undefined;
  const frameRotation = new THREE.Quaternion();
  const cameraPosition = new THREE.Vector3();
  const floor = new THREE.Vector2();
  const replacements = new Map<SolarSystemBodyId, { world: WorldRuntime; resolve(): void; reject(error: unknown): void }>();
  const size = new THREE.Vector2();
  function view(body: SolarSystemBodyId): TerrainSurfaceView {
    const state = geant.navigation.getSnapshot(); const location = state.locations[body]!;
    const buffer = geant.renderer.getDrawingBufferSize(size);
    const runtime = runtimes.get(body);
    const observed = runtime && (state.mode !== "surface" || body !== state.focusBody) ? observeBodySurface({ bodyId: body,
      root: runtime.object3d, camera: geant.renderer.xr?.isPresenting ? geant.renderer.xr.getCamera() : geant.camera,
      surface: runtime.surface ?? { sampleElevationMetres: () => 0 }, terrainMultiplier: state.terrainMultiplier }) : undefined;
    return { ...location, ...(observed ?? {}), terrainMultiplier: state.terrainMultiplier,
      displayRadiusM: displayRadiusForScale(body, state.scaleDenominator),
      observerHeightWorldM: observed?.observerHeightWorldM ?? Math.max(0.001, geant.camera.position.y),
      focalLengthPixels: Math.max(1, buffer.y) / (2 * Math.tan(geant.camera.fov * Math.PI / 360)) };
  }
  function retire(world: WorldRuntime) { world.object3d.removeFromParent(); world.dispose(); }
  function releaseSource(source: WorldSurfaceSource) {
    source.elevationProvider?.dispose();
    if (source.disposeBaseTexture) source.baseTexture.dispose();
  }
  async function construct(body: SolarSystemBodyId, factory: GeantSurfaceFactory | undefined, signal: AbortSignal): Promise<WorldRuntime> {
    const source = await factory?.({ body, renderer: geant.renderer, signal });
    if (signal.aborted || disposed) { if (source) releaseSource(source); throw new DOMException("World loading was cancelled.", "AbortError"); }
    try { return createWorldRuntime({ body: celestialBody(body), renderer: geant.renderer, initialView: view(body), ...(source ? { surface: { ...source, workers: source.workers ?? options.workers } } : {}) }); }
    catch (error) { if (source) releaseSource(source); throw error; }
  }
  async function setSurface(body: SolarSystemBodyId, factory: GeantSurfaceFactory): Promise<void> {
    if (disposed || !runtimes.has(body)) throw new Error("World is unavailable.");
    controllers.get(body)?.abort();
    replacements.get(body)?.reject(new DOMException("Surface replacement was superseded.", "AbortError"));
    const previous = replacements.get(body); if (previous) retire(previous.world); replacements.delete(body);
    const controller = new AbortController(); controllers.set(body, controller);
    const replacement = await construct(body, factory, controller.signal);
    return new Promise((resolve, reject) => { replacements.set(body, { world: replacement, resolve, reject }); });
  }
  function update(_frame: SkykitThreeFrame) {
    let state = geant.navigation.getSnapshot();
    const viewCamera = geant.renderer.xr?.isPresenting ? geant.renderer.xr.getCamera() : geant.camera;
    if (geant.renderer.xr?.isPresenting && state.mode === "surface") {
      viewCamera.getWorldPosition(cameraPosition);
      if (previousTrackedPosition) geant.navigation.dispatch(GEANT_ACTIONS.travel, {
        eastM: (cameraPosition.x - previousTrackedPosition.x) * state.scaleDenominator,
        northM: -(cameraPosition.z - previousTrackedPosition.z) * state.scaleDenominator,
      });
      previousTrackedPosition = cameraPosition.clone(); state = geant.navigation.getSnapshot();
    } else previousTrackedPosition = undefined;
    const at = new Date(state.time); const focus = runtimes.get(state.focusBody)!;
    const focusPosition = bodyPositionJ2000M(state.focusBody, at);
    const focusedAttitude = bodyFixedToRenderQuaternion(bodyRotation(state.focusBody, at));
    if (previousMode !== undefined && state.mode !== previousMode && lastObserver) {
      geant.navigation.dispatch(GEANT_ACTIONS.setObserver, lastObserver);
      if (!geant.renderer.xr?.isPresenting && state.mode !== "surface") geant.camera.position.set(0, 0, 0);
      if (state.mode === "surface") {
        const relative = relativeJ2000MetresToRender({ x: lastObserver.x - focusPosition.x, y: lastObserver.y - focusPosition.y, z: lastObserver.z - focusPosition.z }, 1);
        const local = new THREE.Vector3(relative.x, relative.y, relative.z).applyQuaternion(focusedAttitude.clone().invert());
        const observed = referenceSurfaceObservation(focus.body, local);
        const ground = focus.surface?.sampleElevationMetres(observed.latitudeDegrees, observed.longitudeDegrees) ?? 0;
        const eyeHeight = geant.renderer.xr?.isPresenting ? geant.camera.position.y : 1.65;
        geant.navigation.dispatch(GEANT_ACTIONS.setLocation, { latitudeDegrees: observed.latitudeDegrees, longitudeDegrees: observed.longitudeDegrees,
          altitudeM: observed.heightMetres - ground * state.terrainMultiplier - eyeHeight * state.scaleDenominator });
        state = geant.navigation.getSnapshot();
        if (!geant.renderer.xr?.isPresenting) geant.camera.position.set(0, 1.65, 0);
      }
    }
    previousMode = state.mode;
    // Publish completed numeric terrain before solving its displaced contact.
    for (const world of runtimes.values()) world.processFrame();
    let origin: Vector3d = focusPosition;
    const focusCentre = new THREE.Vector3();
    if (state.mode === "surface") {
      viewCamera.getWorldPosition(cameraPosition);
      floor.set(cameraPosition.x, cameraPosition.z);
      const location = state.locations[state.focusBody]!;
      const elevation = focus.surface?.sampleElevationMetres(location.latitudeDegrees, location.longitudeDegrees) ?? 0;
      const pose = solveBodySurfacePose({ contact: geant.navigation.getContact(), terrainMultiplier: state.terrainMultiplier }, floor,
        displayRadiusForScale(state.focusBody, state.scaleDenominator), focus.surfaceModel, elevation);
      pose.centre.y -= location.altitudeM / state.scaleDenominator;
      frameRotation.copy(pose.bodyToWorld).multiply(focusedAttitude.clone().invert());
      focusCentre.copy(pose.centre);
    } else {
      frameRotation.identity();
      const authoredObserver = geant.navigation.getSnapshot().observerJ2000M;
      origin = authoredObserver ?? { x: focusPosition.x + celestialBody(state.focusBody).referenceRadiusM * 3,
        y: focusPosition.y, z: focusPosition.z };
      geant.cameraRoot.position.set(0, 0, 0);
      if (!authoredObserver) { geant.navigation.dispatch(GEANT_ACTIONS.setObserver, origin); geant.camera.position.set(0, 0, 0); }
      const position = relativeJ2000MetresToRender({ x: focusPosition.x - origin.x, y: focusPosition.y - origin.y, z: focusPosition.z - origin.z }, state.scaleDenominator);
      if (state.mode === "orbit") geant.camera.lookAt(position.x, position.y, position.z);
    }
    for (const [body, world] of runtimes) {
      const physical = bodyPositionJ2000M(body, at);
      const relative = relativeJ2000MetresToRender({ x: physical.x - origin.x, y: physical.y - origin.y, z: physical.z - origin.z }, state.scaleDenominator);
      world.object3d.position.set(relative.x, relative.y, relative.z).applyQuaternion(frameRotation).add(focusCentre);
      world.object3d.quaternion.copy(frameRotation).multiply(bodyFixedToRenderQuaternion(bodyRotation(body, at)));
      world.update(view(body));
      const sun = relativeJ2000MetresToRender({ x: -physical.x, y: -physical.y, z: -physical.z }, 1);
      world.setSunlightDirection(new THREE.Vector3(sun.x, sun.y, sun.z).applyQuaternion(frameRotation).normalize());
    }
    viewCamera.getWorldPosition(cameraPosition);
    const inverseOffset = cameraPosition.clone().sub(focusCentre).applyQuaternion(frameRotation.clone().invert());
    lastObserver = translatedObserverJ2000M(origin, inverseOffset, state.scaleDenominator);
    geant.presentation.observerJ2000M = lastObserver; geant.presentation.systemRotation.copy(frameRotation);
    for (const [body, pending] of replacements) {
      const active = runtimes.get(body)!;
      pending.world.object3d.position.copy(active.object3d.position); pending.world.object3d.quaternion.copy(active.object3d.quaternion);
      pending.world.update(view(body)); pending.world.object3d.updateMatrixWorld(true);
      pending.world.beforeRender(geant.renderer.xr?.isPresenting ? geant.renderer.xr.getCamera() : geant.camera);
      pending.world.processFrame();
      if (!pending.world.getReadiness().ready) continue;
      const old = runtimes.get(body)!;
      pending.world.object3d.position.copy(old.object3d.position); pending.world.object3d.quaternion.copy(old.object3d.quaternion);
      geant.scene.add(pending.world.object3d); retire(old);
      runtimes.set(body, pending.world);
      (geant.worlds as Map<SolarSystemBodyId, WorldRuntime>).set(body, pending.world);
      replacements.delete(body); pending.resolve();
    }
  }
  const plugin: SkykitPlugin & { setSurface: typeof setSurface } = { id: "geant:worlds", setSurface,
    async setup(context) {
      geant = getGeantContext(context);
      const worlds = geant.worlds as Map<SolarSystemBodyId, WorldRuntime>;
      async function dispose() {
        if (disposed) return; disposed = true;
        for (const controller of controllers.values()) controller.abort();
        for (const pending of replacements.values()) { retire(pending.world); pending.reject(new DOMException("Viewer was disposed.", "AbortError")); }
        replacements.clear(); for (const world of runtimes.values()) retire(world); runtimes.clear(); worlds.clear();
      }
      context.addDisposable(dispose);
      for (const body of geant.navigation.getSnapshot().bodies) {
        const controller = new AbortController(); controllers.set(body, controller);
        const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) controller.abort();
        try { const world = await construct(body, options.surfaces?.[body], controller.signal);
          runtimes.set(body, world); worlds.set(body, world); geant.scene.add(world.object3d);
        } finally { options.signal?.removeEventListener("abort", abort); }
      }
      const light = new THREE.AmbientLight(0x8793a8, 0.65); geant.scene.add(light); context.addDisposable(() => { light.removeFromParent(); });
      context.addPart({ id: "geant:world-presentation", priority: 0, update,
        beforeRender() { const camera = geant.renderer.xr?.isPresenting ? geant.renderer.xr.getCamera() : geant.camera;
          for (const world of runtimes.values()) world.beforeRender(camera); } });
    },
  };
  return plugin;
}
