import type { SkykitPlugin } from "../skykit-runtime.js";
import { getGeantContext } from "../viewer.js";
/** Session, entry button and tracked eye height. Manual input belongs to controls. */
export function createGeantXrPlugin(): SkykitPlugin {
  return { id: "geant:xr", async setup(context) {
    const { createSkykitXrSessionPlugin } = await import("../skykit-runtime.js");
    const geant = getGeantContext(context);
    const session = createSkykitXrSessionPlugin({ renderer: geant.renderer, referenceSpaceType: "local-floor" });
    const uninstall = await context.viewer.addPlugin(session); context.addDisposable(uninstall);
    if (geant.host) {
      const button = geant.host.ownerDocument.createElement("button"); button.type = "button"; button.textContent = "Enter VR";
      button.style.cssText = "position:absolute;left:1rem;bottom:1rem;z-index:1";
      const enter = () => { void session.enter().catch(error => { button.textContent = error instanceof Error ? error.message : "XR unavailable"; }); };
      button.addEventListener("click", enter); geant.host.append(button);
      context.addDisposable(() => { button.removeEventListener("click", enter); button.remove(); });
    }
    // Tracked head motion continues independently of manual locomotion.
    const start = () => { geant.camera.position.set(0, 0, 0); };
    const end = () => { geant.camera.position.set(0, 1.65, 0); };
    geant.renderer.xr.addEventListener("sessionstart", start); geant.renderer.xr.addEventListener("sessionend", end);
    context.addDisposable(() => { geant.renderer.xr.removeEventListener("sessionstart", start); geant.renderer.xr.removeEventListener("sessionend", end); });
  } };
}
