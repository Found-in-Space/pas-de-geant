import {
  createGeantSurfaceMovementModel, createGeantObservationMovementModel, createGeantShipMovementModel,
  createGeantDesktopMovementModel, GEANT_ACTIONS,
} from "@found-in-space/pas-de-geant";
import { element, mountViewer, reportError, runCase } from "./case.js";
import { offerControlExtensions } from "./control-extensions.js";

runCase(async () => {
  const surface = createGeantSurfaceMovementModel(), observation = createGeantObservationMovementModel();
  const ship = createGeantShipMovementModel(), desktop = createGeantDesktopMovementModel();
  // The host selects ordinary model objects. No library registry owns this list.
  const browser = await mountViewer("world", { bodies: ["moon"], xr: true, movement: frame => {
    if (!frame.xr) return desktop;
    if (frame.state.mode === "surface") return surface;
    if (frame.state.mode === "observation") return observation;
    return ship;
  } });
  offerControlExtensions(browser);
  element<HTMLSelectElement>("mode").addEventListener("change", event => {
    void browser.actions.invoke(GEANT_ACTIONS.setMode, { mode: (event.target as HTMLSelectElement).value }).then(results => {
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }).catch(reportError);
  });
});
