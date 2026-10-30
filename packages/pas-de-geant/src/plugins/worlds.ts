import * as THREE from "three";
import type { SkykitPlugin, SkykitThreeFrame } from "../skykit-runtime.js";
import { getGeantContext, type GeantContext } from "../viewer.js";
import type { GeantSurfaceFactory } from "../config.js";
import { bodyPositionJ2000M, bodyRotation, celestialBody, type SolarSystemBodyId } from "../worlds/solar-system.js";
import { bodyFixedToRenderQuaternion } from "../worlds/body-attitude.js";
import { displayRadiusForScale, relativeJ2000MetresToRender } from "../worlds/world-navigation.js";
import { createWorldRuntime, type WorldRuntime, type WorldSurfaceSource } from "../worlds/world-runtime.js";
import type { TerrainSurfaceView } from "../worlds/terrain-surface.js";

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
  const replacements = new Map<SolarSystemBodyId, { world: WorldRuntime; resolve(): void; reject(error: unknown): void }>();
  function initialView(body: SolarSystemBodyId): TerrainSurfaceView {
    const state = geant.navigation.getSnapshot(); const location = state.locations[body]!;
    // Construction needs a seed before placement exists. Every live update is measured by the runtime.
    return { ...location, terrainMultiplier: state.terrainMultiplier,
      displayRadiusM: displayRadiusForScale(body, state.scaleDenominator),
      observerHeightWorldM: Math.max(0.001, geant.camera.position.y), focalLengthPixels: 1 };
  }
  function retire(world: WorldRuntime) { world.object3d.removeFromParent(); world.dispose(); }
  function releaseSource(source: WorldSurfaceSource) {
    source.elevationProvider?.dispose();
    if (source.disposeBaseTexture) source.baseTexture.dispose();
    if (source.disposeNightTexture) source.nightTexture?.dispose();
  }
  async function construct(body: SolarSystemBodyId, factory: GeantSurfaceFactory | undefined, signal: AbortSignal): Promise<WorldRuntime> {
    const source = await factory?.({ body, renderer: geant.renderer, signal });
    if (signal.aborted || disposed) { if (source) releaseSource(source); throw new DOMException("World loading was cancelled.", "AbortError"); }
    try { return createWorldRuntime({ body: celestialBody(body), renderer: geant.renderer, initialView: initialView(body), ...(source ? { surface: { ...source, workers: source.workers ?? options.workers } } : {}) }); }
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
    const state = geant.navigation.getSnapshot();
    const at = new Date(geant.time.getSnapshot().atMs);
    const { originJ2000M: origin, systemRotation: frameRotation, translation: focusCentre } = geant.presentation;
    for (const [body, world] of runtimes) {
      const physical = bodyPositionJ2000M(body, at);
      const relative = relativeJ2000MetresToRender({ x: physical.x - origin.x, y: physical.y - origin.y, z: physical.z - origin.z }, state.scaleDenominator);
      const frame = { camera: geant.camera, terrainMultiplier: state.terrainMultiplier, pose: {
        position: new THREE.Vector3(relative.x, relative.y, relative.z).applyQuaternion(frameRotation).add(focusCentre),
        orientation: frameRotation.clone().multiply(bodyFixedToRenderQuaternion(bodyRotation(body, at))),
        displayRadiusM: displayRadiusForScale(body, state.scaleDenominator),
      } };
      world.updateFromCamera(frame);
      const sun = relativeJ2000MetresToRender({ x: -physical.x, y: -physical.y, z: -physical.z }, 1);
      const sunlight = new THREE.Vector3(sun.x, sun.y, sun.z).applyQuaternion(frameRotation).normalize();
      world.setSunlightDirection(sunlight);
      const pending = replacements.get(body);
      if (!pending) continue;
      pending.world.processFrame();
      // The candidate measures its own elevation, at the same complete pose as the active world.
      pending.world.updateFromCamera(frame);
      pending.world.setSunlightDirection(sunlight);
      pending.world.beforeRender(geant.renderer.xr?.isPresenting ? geant.renderer.xr.getCamera() : geant.camera);
      if (!pending.world.getReadiness().ready) continue;
      geant.scene.add(pending.world.object3d); retire(world);
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
      context.addPart({ id: "geant:world-publication", priority: -200, update() {
        for (const world of runtimes.values()) world.processFrame();
      } });
      context.addPart({ id: "geant:world-presentation", priority: 0, update,
        beforeRender() { const camera = geant.renderer.xr?.isPresenting ? geant.renderer.xr.getCamera() : geant.camera;
          for (const world of runtimes.values()) world.beforeRender(camera); } });
    },
  };
  return plugin;
}
