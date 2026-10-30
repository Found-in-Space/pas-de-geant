import { GEANT_ACTIONS } from "@found-in-space/pas-de-geant";
import { element, mountViewer, reportError, runCase } from "./case.js";
import { offerControlExtensions } from "./control-extensions.js";

runCase(async () => {
  const location = { latitudeDegrees: 46.58, longitudeDegrees: 7.99 };
  const world = await mountViewer("world", { bodies: ["earth"], location, xr: true });
  offerControlExtensions(world);
  element<HTMLSelectElement>("mode").addEventListener("change", event => {
    void world.actions.invoke(GEANT_ACTIONS.setMode, { mode: (event.target as HTMLSelectElement).value }).then(results => {
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }).catch(reportError);
  });
  await mountViewer("reference", { bodies: ["earth"], location, controls: false });
});
