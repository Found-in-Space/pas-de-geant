import * as THREE from "three";
import type { SkykitPlugin } from "@found-in-space/skykit";
import { getGeantContext } from "../viewer.js";
import { GEANT_ACTIONS } from "../navigation/controller.js";
import { translatedObserverJ2000M } from "../worlds/world-navigation.js";
export interface GeantXrOptions { readonly movement?: boolean; readonly speedHeadsetMPerSecond?: number }
export function createGeantXrPlugin(options: GeantXrOptions = {}): SkykitPlugin {
  return { id: "geant:xr", async setup(context) {
    const { createSkykitXrSessionPlugin, createSkykitXrControlBindings } = await import("@found-in-space/skykit/xr");
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
    const controls = createSkykitXrControlBindings({ axes: { travel: { hand: "left", stick: "primary" }, scale: { hand: "right", stick: "primary" } },
      buttons: { boost: { hand: "left", button: "grip" } } });
    context.addDisposable(() => controls.dispose());
    const direction = new THREE.Vector3(); const quaternion = new THREE.Quaternion();
    context.addPart({ id: "geant:xr-controls", priority: -100, update(frame) {
      if (!geant.renderer.xr.isPresenting || options.movement === false) return;
      controls.update({ session: geant.renderer.xr.getSession()! });
      const travel = controls.getAxis("travel"), scale = controls.getAxis("scale"); const state = geant.navigation.getSnapshot();
      if (travel.active) {
        geant.renderer.xr.getCamera().getWorldQuaternion(quaternion);
        direction.set(travel.x, 0, travel.y).applyQuaternion(quaternion); direction.y = 0;
        if (direction.lengthSq()) direction.normalize();
        const step = (options.speedHeadsetMPerSecond ?? 1.35) * frame.deltaSeconds * state.scaleDenominator * (controls.isPressed("boost") ? 4 : 1);
        if (state.mode === "surface") void context.actions.invoke(GEANT_ACTIONS.travel, { eastM: direction.x * step, northM: -direction.z * step }, { source: "xr" });
        else if (state.observerJ2000M) void context.actions.invoke(GEANT_ACTIONS.setObserver,
          translatedObserverJ2000M(state.observerJ2000M, direction.multiplyScalar(step / state.scaleDenominator), state.scaleDenominator), { source: "xr" });
      }
      if (scale.active) void context.actions.invoke(GEANT_ACTIONS.setScale,
        { scaleDenominator: state.scaleDenominator * 2 ** (scale.y * frame.deltaSeconds * 0.72) }, { source: "xr" });
    } });
    // Tracked head motion continues independently of manual locomotion.
    const start = () => { controls.reset(); geant.camera.position.set(0, 0, 0); };
    const end = () => { controls.reset(); geant.camera.position.set(0, 1.65, 0); };
    geant.renderer.xr.addEventListener("sessionstart", start); geant.renderer.xr.addEventListener("sessionend", end);
    context.addDisposable(() => { geant.renderer.xr.removeEventListener("sessionstart", start); geant.renderer.xr.removeEventListener("sessionend", end); });
  } };
}
