import { createGeantPanelPlugin } from "@found-in-space/pas-de-geant";
import type { GeantBrowser } from "@found-in-space/pas-de-geant/browser";
import type { JourneyTouchControls } from "@found-in-space/guided-journey/touch-os";
import { createSkykitInteractionInput } from "@found-in-space/skykit/interaction";

/** Host placement only: shared controls retain all chapter/playback behavior. */
export async function installJourneyPanel(browser: GeantBrowser, controls: JourneyTouchControls, subscribe: (refresh: () => void) => () => void) {
  const input = createSkykitInteractionInput({ renderer: browser.renderer, origin: browser.cameraRoot,
    include: source => source.handedness === "right" || source.targetRayMode !== "tracked-pointer" });
  try {
    const remove = await browser.install(createGeantPanelPlugin({ id: "integration:journey-panel",
      surface: { width: 480, height: 640 }, root: () => controls.render(), subscribe,
      action(output) { controls.handleOutput(output); return null; }, inputs: [input], anchor: true, mode: "overlay",
      placement: { panelWidth: 0.3, panelHeight: 0.4, tiltRadians: -Math.PI * 0.35,
        offset: { x: 0, y: 0.08, z: -0.03 },
        textureQuality: { anisotropy: Math.min(4, browser.renderer.capabilities.getMaxAnisotropy()) } },
      frame(_frame, context) { return { timestamp: performance.now(), scene: context.scene, camera: context.camera,
        anchorPose: input.getGripPose("left") }; },
    }));
    return async () => { try { await remove(); } finally { input.dispose(); } };
  } catch (error) { input.dispose(); throw error; }
}
