import { createDefaultSurfaceFactory, EARTH_BLUE_MARBLE_DATASET, EARTH_BLACK_MARBLE_DATASET } from "@found-in-space/pas-de-geant/browser";
import { createGeantJourneyDriver } from "@found-in-space/pas-de-geant/journey";
import { createGuidedJourneyController } from "@found-in-space/guided-journey";
import { mountJourneyControls } from "@found-in-space/guided-journey/dom";
import { createJourneyTouchControls } from "@found-in-space/guided-journey/touch-os";
import { installJourneyPanel } from "./journey-panel.js";
import { earthJourney as definition } from "./earth-journey-chapters.js";
import { element, mountViewer, runCase } from "./case.js";
import { loadDatasetConfiguration, localConfigurationUrl } from "./configuration.js";

runCase(async () => {
  const configured = new URLSearchParams(window.location.search).get("datasets") === "configured"
    ? await loadDatasetConfiguration(localConfigurationUrl()) : undefined;
  if (configured && (configured.body !== "earth" || !configured.sources.elevation)) {
    throw new Error("The Earth journey requires datasets.body = earth and datasets.sources.elevation.");
  }
  if (configured) element("terrain-source").textContent = configured.sources.elevation!.attribution;
  const browser = await mountViewer("world", { bodies: ["earth"], mode: "surface", xr: true,
    scaleDenominator: 7_000_000, time: "2026-10-30T12:00:00Z", timeRate: 0,
    ...(configured ? { datasets: { earth: { imagery: EARTH_BLUE_MARBLE_DATASET,
      nightImagery: EARTH_BLACK_MARBLE_DATASET, ...configured.sources } } }
      : { surfaces: { earth: createDefaultSurfaceFactory({ night: true }) } }) });
  const driver = createGeantJourneyDriver({ browser });
  const journey = createGuidedJourneyController({ definition, driver });
  const controls = mountJourneyControls({ root: element("journey"), definition, journey });
  const removePanel = await installJourneyPanel(browser,
    createJourneyTouchControls({ id: "earth-chapters", definition, journey }), journey.subscribe);
  const labels = { absent: "no detail source", loading: "loading detail", ready: "requested detail ready",
    degraded: "some source data unavailable", suspended: "detail loading suspended" };
  const removeReadout = await browser.install({ id: "earth:surface-readiness", setup(context) {
    let previous = "";
    return context.addPart({ id: "earth:surface-readiness", priority: 3, update() {
      const state = browser.worlds.get("earth")!.getSurfaceReadiness();
      const text = `Day imagery: ${labels[state.layers.imagery.status]}. Terrain: ${labels[state.layers.terrain.status]}. `
        + `Night imagery: ${labels[state.layers.nightImagery.status]}.`;
      if (text !== previous) { previous = text; element("detail").textContent = text; }
    } });
  } });
  browser.addDisposable(async () => { controls.destroy(); await removePanel(); await removeReadout(); await journey.dispose(); driver.dispose(); });
  // Continuous travel in VR is opt-in: select a chapter after entering the session.
  // The same controls and controller handle desktop, XR interruption and rejoin.
});
