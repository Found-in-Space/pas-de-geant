import { Mesh, MeshBasicMaterial, SphereGeometry } from "three";
import { createDefaultSurfaceFactory } from "@found-in-space/pas-de-geant/browser";
import { createGeantJourneyNavigation, createGeantSequenceParticipant, createGeantSequencePlugin } from "@found-in-space/pas-de-geant/journey";
import { createJourneySequencePlayer } from "@found-in-space/guided-journey/sequence";
import { mountSequenceControls } from "@found-in-space/guided-journey/dom";
import { earthTrackingSequence as sequence } from "./earth-tracking-sequence.js";
import { element, mountViewer, runCase } from "./case.js";

runCase(async () => {
  const browser = await mountViewer("world", { bodies: ["earth"], mode: "surface", xr: true,
    scaleDenominator: 7_000_000, time: "2026-10-30T12:00:00Z", timeRate: 0,
    surfaces: { earth: createDefaultSurfaceFactory({ night: true }) } });
  const navigation = createGeantJourneyNavigation(browser);
  const participant = createGeantSequenceParticipant({ browser, navigation });
  const player = createJourneySequencePlayer({ sequence, participant });
  const controls = mountSequenceControls({ root: element("sequence"), player });
  const world = browser.worlds.get("earth")!;
  const marker = new Mesh(new SphereGeometry(.012, 16, 8), new MeshBasicMaterial({ color: 0xffa64d }));
  world.object3d.add(marker);
  const remove = await browser.install(createGeantSequencePlugin({ player, onFrame(frame) {
    marker.position.copy(frame.value.target.position).divideScalar(world.body.referenceRadiusM);
    element("caption").textContent = `${frame.timeSecs.toFixed(1)} / ${frame.durationSecs} presentation seconds. `
      + (frame.timeSecs < 15 ? "Follow the authored marker over the equator." : "Pause to inspect, or explore freely and rejoin from your new view.");
  } }));
  const visibility = () => { if (document.hidden) player.pause(); };
  document.addEventListener("visibilitychange", visibility);
  browser.addDisposable(async () => {
    document.removeEventListener("visibilitychange", visibility); controls.destroy(); await remove();
    player.dispose(); participant.dispose(); navigation.dispose(); marker.removeFromParent(); marker.geometry.dispose(); marker.material.dispose();
  });
});
