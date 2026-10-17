import * as THREE from "three";
import type { GeantSimulationTime, GeantSimulationTimeSnapshot } from "./simulation-time.js";
import { getGeantContext, type GeantContext } from "./viewer.js";
import type { SkykitPlugin, SkykitThreeFrame } from "./skykit-runtime.js";
import type { CelestialBodyDefinition } from "./worlds/solar-system.js";

export interface BodyAppearanceFrame {
  readonly time: GeantSimulationTimeSnapshot;
  /** Presentation time is optional artistic input, independent of simulation playback. */
  readonly elapsedSeconds: number;
  readonly deltaSeconds: number;
}
export interface BodyAppearance {
  /** Body-fixed X/ north Y/ minus-east Z; lengths are physical metres / referenceRadiusM. */
  readonly object3d: THREE.Object3D;
  update?(frame: BodyAppearanceFrame): void;
  beforeRender?(camera: THREE.Camera): void;
  /** Releases resources owned by this instance. Borrowed resources remain caller-owned. */
  dispose(): void;
}
export interface BodyAppearanceContext {
  readonly body: CelestialBodyDefinition;
  readonly renderer: THREE.WebGLRenderer;
  readonly time: GeantSimulationTime;
  /** Aborted on replacement/removal, including factories still loading. */
  readonly signal: AbortSignal;
}
/** Resolves when the first usable appearance is ready. Each call creates a fresh instance. */
export type BodyAppearanceFactory = (context: BodyAppearanceContext) => BodyAppearance | Promise<BodyAppearance>;
export interface GeantBodyAppearanceOptions {
  readonly body: CelestialBodyDefinition;
  readonly appearance: BodyAppearanceFactory;
  readonly id?: string;
  readonly signal?: AbortSignal;
}

/** An ordinary SkyKit plugin. The host owns this stable root's pose and scale. */
export function createGeantBodyAppearancePlugin(options: GeantBodyAppearanceOptions) {
  const object3d = new THREE.Group(); object3d.name = `${options.body.id}-root`;
  let geant: GeantContext | undefined;
  let active: { appearance: BodyAppearance; abort: AbortController } | undefined;
  let pending: AbortController | undefined;
  let removePart: (() => void) | undefined;
  let disposed = false, installed = false, elapsedSeconds = 0;
  function dispose() {
    if (disposed) return;
    disposed = true; pending?.abort(); pending = undefined;
    removePart?.(); object3d.removeFromParent();
    options.signal?.removeEventListener("abort", dispose);
    if (active) { const previous = active; active = undefined; previous.abort.abort(); previous.appearance.object3d.removeFromParent(); previous.appearance.dispose(); }
  }
  async function setAppearance(factory: BodyAppearanceFactory): Promise<void> {
    if (!geant || disposed) throw new Error("Install the appearance plugin before replacing its model.");
    pending?.abort();
    const abort = new AbortController(); pending = abort;
    let appearance: BodyAppearance | undefined;
    try {
      appearance = await factory({ body: options.body, renderer: geant.renderer, time: geant.time, signal: abort.signal });
      if (disposed || abort.signal.aborted || pending !== abort) throw new DOMException("Appearance loading was cancelled.", "AbortError");
      appearance.update?.({ time: geant.time.getSnapshot(), elapsedSeconds, deltaSeconds: 0 });
      abort.signal.throwIfAborted();
    } catch (error) {
      abort.abort(); appearance?.dispose();
      if (pending === abort) pending = undefined;
      throw error;
    }
    const previous = active;
    object3d.add(appearance.object3d);
    active = { appearance, abort }; pending = undefined;
    if (previous) { previous.abort.abort(); previous.appearance.object3d.removeFromParent(); previous.appearance.dispose(); }
  }
  const plugin: SkykitPlugin & { readonly object3d: THREE.Group; setAppearance: typeof setAppearance } = {
    id: options.id ?? `geant:appearance:${options.body.id}`, object3d, setAppearance,
    async setup(context) {
      if (installed || disposed) throw new Error("Create a fresh appearance plugin for each installation.");
      installed = true; geant = getGeantContext(context);
      context.addDisposable(dispose);
      options.signal?.addEventListener("abort", dispose, { once: true });
      if (options.signal?.aborted) { dispose(); options.signal.throwIfAborted(); }
      removePart = context.addPart({ id: options.id ?? `geant:appearance:${options.body.id}`, object3d,
        attach(ctx) { ctx.roots.originContentRoot.add(object3d); },
        update(frame: SkykitThreeFrame) {
          elapsedSeconds = frame.elapsedSeconds;
          active?.appearance.update?.({ time: geant!.time.getSnapshot(), elapsedSeconds, deltaSeconds: frame.deltaSeconds });
        },
        beforeRender() { active?.appearance.beforeRender?.(geant!.renderer.xr?.isPresenting ? geant!.renderer.xr.getCamera() : geant!.camera); },
        detach() { object3d.removeFromParent(); },
        getSnapshot: () => ({ bodyId: options.body.id, ready: Boolean(active), loading: Boolean(pending) }),
      });
      try { await setAppearance(options.appearance); return dispose; }
      catch (error) { dispose(); throw error; }
    },
  };
  return plugin;
}
