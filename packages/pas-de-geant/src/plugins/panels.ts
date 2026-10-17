import type { DisplayNode, RuntimeOutput, SurfaceMetrics, ThemeTokens, DisplayRuntime } from "@found-in-space/touch-os";
import type { ThreePanelDriver, ThreePanelHostFrame } from "@found-in-space/touch-os/hosts/three";
import type { SkykitPlugin, SkykitThreeFrame } from "../skykit-runtime.js";
import { getGeantContext, type GeantContext } from "../viewer.js";
import type { GeantSnapshot } from "../navigation/controller.js";
export interface GeantPanelOptions {
  readonly id: string;
  readonly root: (snapshot: GeantSnapshot) => DisplayNode;
  readonly surface?: Partial<SurfaceMetrics>;
  readonly theme?: Partial<ThemeTokens>;
  readonly createDriver: (runtime: DisplayRuntime, context: GeantContext) => ThreePanelDriver;
  readonly frame: (frame: SkykitThreeFrame, context: GeantContext) => ThreePanelHostFrame;
  readonly action?: (output: RuntimeOutput) => { readonly id: string; readonly payload?: unknown } | null;
}
/** Ordinary plugin owning a Touch OS runtime, Three host driver, subscription and session. */
export function createGeantPanelPlugin(options: GeantPanelOptions): SkykitPlugin {
  return { id: options.id, async setup(context) {
    const [{ createRuntime }, { createThreePanelSession }] = await Promise.all([import("@found-in-space/touch-os"), import("@found-in-space/touch-os/hosts/three")]);
    const geant = getGeantContext(context);
    const runtime = createRuntime({ root: options.root(geant.navigation.getSnapshot()), surface: options.surface, theme: options.theme });
    context.addDisposable(() => runtime.dispose());
    const driver = options.createDriver(runtime, geant);
    const panel = createThreePanelSession({ key: options.id, runtime, driver,
      outputHandler(output) { const action = options.action?.(output); if (action) void context.actions.invoke(action.id, action.payload, { source: "panel" }); } });
    context.addDisposable(() => panel.dispose());
    panel.attach();
    context.addDisposable(geant.navigation.subscribe(snapshot => runtime.setRoot(options.root(snapshot))));
    context.addPart({ id: options.id, priority: 200, update(frame) { panel.update(options.frame(frame, geant)); panel.render(); } });
  } };
}
