import * as THREE from "three";
import type { GeantSurfaceFactory } from "./config.js";
import { createGeantViewer, type GeantViewer, type GeantViewerOptions } from "./viewer.js";
import { createGeantWorldsPlugin } from "./plugins/worlds.js";
import { createGeantControlsPlugin, type GeantControlsOptions } from "./plugins/controls.js";
import type { SolarSystemBodyId } from "./worlds/solar-system.js";
import type { WorldSurfaceSource } from "./worlds/world-runtime.js";
import { createBodySurfaceModel } from "./worlds/surface-model.js";
import { celestialBody } from "./worlds/solar-system.js";
import { createGeantMovementPlugin } from "./plugins/movement.js";
import { createGeantSurfaceMovementModel } from "./navigation/surface-movement.js";
import { createGeantObservationMovementModel } from "./navigation/observation-movement.js";
import { createGeantShipMovementModel } from "./navigation/ship-movement.js";
import { createGeantDesktopMovementModel } from "./navigation/desktop-movement.js";
import type { GeantMovementSelection } from "./navigation/movement-model.js";

export interface GeantComposition {
  /** Authored frame calculation/rendering, after plugin updates. Use viewer.render() for render hooks. */
  readonly frame?: (timeMs: number, xrFrame?: XRFrame) => void;
  readonly resize?: () => void;
  readonly dispose?: () => void | Promise<void>;
}
export interface GeantBrowserOptions extends Omit<GeantViewerOptions, "renderer"> {
  readonly host: HTMLElement;
  /** Borrow a renderer; its GPU resources remain owned by the caller. */
  readonly renderer?: THREE.WebGLRenderer;
  readonly datasets?: Readonly<Partial<Record<SolarSystemBodyId, import("./worlds/datasets.js").BodySurfaceDatasets>>>;
  readonly workers?: import("./worlds/workers.js").WorldWorkerFactory;
  readonly surfaces?: Readonly<Partial<Record<SolarSystemBodyId, GeantSurfaceFactory>>>;
  readonly xr?: boolean;
  readonly ai?: import("./config.js").GeantAiOptions;
  readonly controls?: false | GeantControlsOptions;
  /** Replace or omit the convenience navigation preset. The viewer has no default model. */
  readonly movement?: GeantMovementSelection | false;
  readonly autoStart?: boolean;
  readonly signal?: AbortSignal;
  /** Advanced application composition replaces the default worlds/controls plugins. */
  readonly compose?: (viewer: GeantViewer, signal: AbortSignal) => GeantComposition | Promise<GeantComposition>;
}
const hosts = new WeakSet<HTMLElement>();
const earthBase = new URL("./assets/bluemarble-2048.png", import.meta.url);
const moonBase = new URL("./assets/lroc-color-2k.jpg", import.meta.url);
export function createReferenceSurfaceFactory(): GeantSurfaceFactory {
  return async ({ body, signal }) => {
    const url = body === "earth" ? earthBase : body === "moon" ? moonBase : undefined;
    let texture: THREE.Texture;
    let baseFallback = false;
    if (url) {
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Base texture unavailable (HTTP ${response.status}).`);
        const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: "none" });
        texture = new THREE.Texture(bitmap); texture.needsUpdate = true;
        texture.addEventListener("dispose", () => bitmap.close());
      } catch (error) {
        signal.throwIfAborted(); texture = solidBase(body); baseFallback = true;
      }
    } else texture = solidBase(body);
    if (signal.aborted) { texture.dispose(); throw new DOMException("Surface loading was cancelled.", "AbortError"); }
    return { baseTexture: texture, disposeBaseTexture: true, baseFallback,
      surfaceModel: createBodySurfaceModel(celestialBody(body)) } satisfies WorldSurfaceSource;
  };
}
function solidBase(body: SolarSystemBodyId): THREE.Texture {
  const color = new THREE.Color(celestialBody(body).placeholderColor);
  const texture = new THREE.DataTexture(new Uint8Array([Math.round(color.r * 255), Math.round(color.g * 255), Math.round(color.b * 255), 255]), 1, 1);
  texture.needsUpdate = true; return texture;
}
/** Host-scoped renderer, state, plugins and deterministic teardown. Importing this module starts nothing. */
export async function createGeantBrowser(options: GeantBrowserOptions) {
  if (hosts.has(options.host)) throw new Error("This host already has a Geant browser.");
  hosts.add(options.host);
  const abort = new AbortController();
  let ready = false;
  const onAbort = () => { abort.abort(options.signal?.reason); if (ready) void dispose().catch(error => console.error(error)); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const document = options.host.ownerDocument;
  const window = document.defaultView!;
  let defaultHeight = options.host.clientHeight === 0;
  const root = document.createElement("div");
  root.className = "geant-browser";
  root.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;isolation:isolate";
  if (defaultHeight) root.style.height = "420px";
  root.tabIndex = 0; root.setAttribute("aria-label", "Pas de Géant world browser");
  options.host.append(root);
  let renderer: THREE.WebGLRenderer | undefined;
  let geant: GeantViewer | undefined;
  let composition: GeantComposition | undefined;
  let worldsPlugin: ReturnType<typeof createGeantWorldsPlugin> | undefined;
  let controlsPlugin: ReturnType<typeof createGeantControlsPlugin> | undefined;
  let movementPlugin: ReturnType<typeof createGeantMovementPlugin> | undefined;
  let observer: ResizeObserver | undefined;
  let lastTime: number | undefined;
  let running = false;
  let disposal: Promise<void> | undefined;
  async function dispose(): Promise<void> {
    disposal ??= (async () => {
      abort.abort(); running = false;
      const errors: unknown[] = [];
      const attempt = async (run: () => unknown) => { try { await run(); } catch (error) { errors.push(error); } };
      await attempt(() => renderer?.setAnimationLoop(null)); observer?.disconnect();
      await attempt(() => composition?.dispose?.());
      await attempt(() => geant?.dispose());
      if (!options.renderer) {
        await attempt(() => renderer?.xr.getSession()?.end());
        await attempt(() => renderer?.dispose());
      }
      options.signal?.removeEventListener("abort", onAbort); root.remove(); hosts.delete(options.host);
      if (errors.length) throw new AggregateError(errors, "Geant browser cleanup failed.");
    })();
    return disposal;
  }
  function resize() {
    if (!renderer || !geant || disposal) return;
    if (defaultHeight) {
      const style = window.getComputedStyle(options.host);
      const contentHeight = options.host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (contentHeight > 0 && Math.abs(contentHeight - root.clientHeight) > 1) { defaultHeight = false; root.style.height = "100%"; }
    }
    const width = root.clientWidth || options.host.clientWidth || 1, height = root.clientHeight || options.host.clientHeight || 1;
    geant.viewer.resize({ width, height, devicePixelRatio: Math.min(window.devicePixelRatio || 1, 1.5) });
    composition?.resize?.();
  }
  function frame(timeMs: number, xrFrame?: XRFrame) {
    if (!geant || !running) return;
    const delta = lastTime === undefined ? 0 : (timeMs - lastTime) / 1000; lastTime = timeMs;
    if (composition?.frame) { geant.viewer.update(delta); composition.frame(timeMs, xrFrame); }
    else {
      renderer!.clear(true, true, true); geant.viewer.frame(delta);
    }
  }
  function start() { if (disposal) throw new Error("Geant browser is disposed."); running = true; lastTime = undefined; renderer!.setAnimationLoop(frame); }
  function stop() { running = false; renderer!.setAnimationLoop(null); lastTime = undefined; }
  try {
    abort.signal.throwIfAborted();
    renderer = options.renderer ?? new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance", logarithmicDepthBuffer: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35; renderer.autoClear = false; renderer.setClearColor(0x01040a, 1);
    renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType("local-floor");
    renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
    root.append(renderer.domElement);
    geant = await createGeantViewer({ ...options, host: root, renderer, plugins: [] });
    geant.camera.position.set(0, 1.65, 0); geant.camera.rotation.order = "YXZ"; geant.camera.rotation.x = -0.55;
    resize();
    if (options.compose) composition = await options.compose(geant, abort.signal);
    else {
      const reference = createReferenceSurfaceFactory();
      const surfaces = Object.fromEntries(geant.configuration.bodies.filter(body => celestialBody(body).surface || options.surfaces?.[body] || options.datasets?.[body]).map(body => [body, options.surfaces?.[body] ?? (async (context) => {
        const base = await reference(context);
        if (!options.datasets?.[body]) return { ...base, workers: options.workers };
        try {
          const { resolveBodySurfaceDatasets } = await import("./worlds/datasets.js");
          return await resolveBodySurfaceDatasets({ body, datasets: options.datasets[body]!, baseTexture: base.baseTexture,
            disposeBaseTexture: true, signal: context.signal, workers: options.workers });
        } catch (error) { base.baseTexture.dispose(); throw error; }
      }) satisfies GeantSurfaceFactory]));
      worldsPlugin = createGeantWorldsPlugin({ surfaces, signal: abort.signal, workers: options.workers });
      await geant.install(worldsPlugin);
      if (options.movement !== false) {
        const surface = createGeantSurfaceMovementModel(), observation = createGeantObservationMovementModel();
        const ship = createGeantShipMovementModel(), desktop = createGeantDesktopMovementModel();
        const model: GeantMovementSelection = options.movement ?? (frame => {
          if (!frame.xr) return desktop;
          switch (frame.state.mode) {
            case "surface": return surface;
            case "observation": case "orbit": return observation;
            case "ship": case "free": return ship;
            default: throw new RangeError("Supply a movement selection for the host's navigation label.");
          }
        });
        movementPlugin = createGeantMovementPlugin({ model });
        await geant.install(movementPlugin);
      }
      if (options.controls !== false) {
        controlsPlugin = createGeantControlsPlugin(options.controls);
        await geant.install(controlsPlugin);
      }
    }
    if (options.xr) { const { createGeantXrPlugin } = await import("./plugins/xr.js"); await geant.install(createGeantXrPlugin()); }
    if (options.ai) { const { createGeantAiPlugin } = await import("./ai.js"); await geant.install(createGeantAiPlugin(options.ai)); }
    for (const plugin of options.plugins ?? []) await geant.install(plugin);
    abort.signal.throwIfAborted();
    observer = new ResizeObserver(resize); observer.observe(options.host);
    resize();
    ready = true;
    if (options.autoStart !== false) start();
    return { ...geant, host: options.host, element: root, controls: controlsPlugin ?? null, movement: movementPlugin ?? null, start, stop, resize, dispose,
      async setSurface(body: SolarSystemBodyId, factory: GeantSurfaceFactory) {
        if (!worldsPlugin) throw new Error("The authored composition owns surface replacement.");
        await worldsPlugin.setSurface(body, factory);
      },
      get running() { return running; } };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Geant startup and cleanup failed."); }
    throw error;
  }
}
export type GeantBrowser = Awaited<ReturnType<typeof createGeantBrowser>>;
