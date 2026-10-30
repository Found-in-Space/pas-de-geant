import { createDefaultSurfaceFactory } from "@found-in-space/pas-de-geant/browser";
import { createGeantJourneyDriver } from "@found-in-space/pas-de-geant/journey";
import { createGuidedJourneyController } from "@found-in-space/guided-journey";
import { mountJourneyControls } from "@found-in-space/guided-journey/dom";
import { earthJourney as definition } from "./earth-journey-chapters.js";
import { element, mountViewer, runCase } from "./case.js";

runCase(async () => {
  const browser = await mountViewer("world", { bodies: ["earth"], mode: "surface", xr: true,
    scaleDenominator: 7_000_000, time: "2026-10-30T12:00:00Z", timeRate: 0,
    surfaces: { earth: createDefaultSurfaceFactory({ night: true }) } });
  const driver = createGeantJourneyDriver({ browser });
  const journey = createGuidedJourneyController({ definition, driver });
  const controls = mountJourneyControls({ root: element("journey"), definition, journey });
  browser.addDisposable(async () => { controls.destroy(); await journey.dispose(); driver.dispose(); });
  // Continuous travel in VR is opt-in: select a chapter after entering the session.
  // The same controls and controller handle desktop, XR interruption and rejoin.
});
