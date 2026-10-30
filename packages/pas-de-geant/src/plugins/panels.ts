import type { DisplayNode, RuntimeOutput, SurfaceMetrics, ThemeTokens, DisplayRuntime } from "@found-in-space/touch-os";
import type { ThreeUIEnvironment, ThreePanelHostFrame, ThreePanelViewOptions, InteractionInputAdapter } from "@found-in-space/touch-os/hosts/three";
import type { SkykitPlugin, SkykitThreeFrame } from "../skykit-runtime.js";
import { getGeantContext, type GeantContext } from "../viewer.js";
import type { GeantSnapshot } from "../navigation/controller.js";
export interface GeantPanelOptions {
  readonly id: string;
  readonly root: (snapshot: GeantSnapshot, runtime?: DisplayRuntime) => DisplayNode;
  readonly surface?: Partial<SurfaceMetrics>;
  readonly theme?: Partial<ThemeTokens>;
  readonly placement?: ThreePanelViewOptions["placement"];
  readonly anchor?: boolean;
  readonly mode?: "spatial" | "overlay";
  /** A separate desktop view shares application state while retaining its own input/layout. */
  readonly desktop?: HTMLElement;
  readonly inputs?: readonly InteractionInputAdapter[];
  readonly initialize?: (runtime: DisplayRuntime) => void;
  /** Refresh independent application state (for example journey progress) in every mounted view. */
  readonly subscribe?: (refresh: () => void) => () => void;
  readonly frame?: (frame: SkykitThreeFrame, context: GeantContext) => ThreePanelHostFrame;
  readonly action?: (output: RuntimeOutput) => { readonly id: string; readonly payload?: unknown } | null;
  /** Borrow an existing context to arbitrate with scene targets and other panels. */
  readonly environment?: ThreeUIEnvironment;
}
/** Content, state bindings and placement over TouchOS's shared input/feedback/lifecycle path. */
export function createGeantPanelPlugin(options: GeantPanelOptions): SkykitPlugin {
  return { id: options.id, async setup(context) {
    const { createThreeUIEnvironment } = await import("@found-in-space/touch-os/hosts/three");
    const geant = getGeantContext(context);
    const environment = options.environment ?? createThreeUIEnvironment({ parent: geant.scene, inputs: options.inputs,
      ...(options.mode ? { mode: options.mode } : {}) });
    const cleanups: Array<() => void | Promise<void>> = [];
    const teardown = async () => {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.splice(0).reverse()) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Panel cleanup failed.");
    };
    if (!options.environment) cleanups.push(() => environment.dispose());
    const create = (id: string, desktop?: HTMLElement) => {
      let mountedRuntime: DisplayRuntime | undefined;
      const view = environment.mountPanel({ id,
        content: () => options.root(geant.navigation.getSnapshot(), mountedRuntime), surface: options.surface, theme: options.theme,
        ...(desktop ? { canvas: desktop } : { placement: options.placement, anchor: options.anchor }),
        ...(options.mode ? { mode: options.mode } : {}),
        bind(output) { const action = options.action?.(output); if (action) void context.actions.invoke(action.id, action.payload, { source: "panel" }); } });
      cleanups.push(() => view.dispose());
      mountedRuntime = view.runtime;
      options.initialize?.(view.runtime);
      view.setContent(options.root(geant.navigation.getSnapshot(), view.runtime));
      cleanups.push(geant.navigation.subscribe(snapshot => view.setContent(options.root(snapshot, view.runtime))));
      if (options.subscribe) cleanups.push(options.subscribe(() => view.setContent(options.root(geant.navigation.getSnapshot(), view.runtime))));
      return view;
    };
    try {
      create(options.id);
      if (options.desktop) create(`${options.id}:desktop`, options.desktop);
      if (!options.environment) cleanups.push(context.addPart({ id: options.id, priority: 200, update(frame) {
        environment.update(options.frame?.(frame, geant) ?? { timestamp: performance.now(), scene: geant.scene, camera: geant.camera });
      } }));
      return teardown;
    } catch (error) { await teardown(); throw error; }
  } };
}
