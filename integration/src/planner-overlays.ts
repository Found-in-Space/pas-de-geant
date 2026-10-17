import { GEANT_ACTIONS } from "@found-in-space/pas-de-geant";
import { element, mountViewer, reportError, runCase } from "./case.js";
import { offerControlExtensions } from "./control-extensions.js";

runCase(async () => {
  const world = await mountViewer("world", { bodies: ["moon"], xr: true });
  offerControlExtensions(world);
  element<HTMLSelectElement>("mode").addEventListener("change", event => {
    void world.actions.invoke(GEANT_ACTIONS.setMode, { mode: (event.target as HTMLSelectElement).value }).then(results => {
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }).catch(reportError);
  });
  await mountViewer("reference", { bodies: ["moon"], controls: false });
});
