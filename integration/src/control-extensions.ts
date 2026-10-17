import {
  createGeantTerrainToolsPlugin, createGeantTileDebugPlugin, describeGeantControlScheme,
  extendGeantControlScheme, standardGeantControlScheme,
} from "@found-in-space/pas-de-geant";
import type { GeantBrowser } from "@found-in-space/pas-de-geant/browser";
import { element, reportError } from "./case.js";
import { plannerDebugBindings, terrainAdjustmentBindings } from "./control-bindings.js";

/** Case composition only: input and feature behavior remain in the public package. */
export function offerControlExtensions(browser: GeantBrowser) {
  const controls = browser.controls;
  if (!controls) throw new Error("This case requires standard controls.");
  const planner = element<HTMLInputElement>("planner-tools"), terrain = element<HTMLInputElement>("terrain-tools");
  planner.checked = terrain.checked = false;
  const help = element("control-help"), abort = new AbortController();
  let removePlanner: (() => void) | undefined, removeTerrain: (() => void) | undefined;
  let pending = Promise.resolve(), disposed = false;
  browser.addDisposable(() => { disposed = true; abort.abort(); });
  function showHelp() {
    help.replaceChildren(...describeGeantControlScheme(controls!.getSnapshot().scheme).map(text => {
      const item = document.createElement("li"); item.textContent = text; return item;
    }));
  }
  async function update() {
    if (disposed) return;
    // Remove bindings before uninstalling the actions that they invoke.
    controls!.setScheme(standardGeantControlScheme);
    if (planner.checked && !removePlanner) removePlanner = await browser.install(createGeantTileDebugPlugin());
    if (!planner.checked && removePlanner) { removePlanner(); removePlanner = undefined; }
    if (terrain.checked && !removeTerrain) removeTerrain = await browser.install(createGeantTerrainToolsPlugin());
    if (!terrain.checked && removeTerrain) { removeTerrain(); removeTerrain = undefined; }
    if (disposed) return;
    controls!.setScheme(extendGeantControlScheme(standardGeantControlScheme, {
      id: "integration:controls", add: [...(removePlanner ? plannerDebugBindings : []), ...(removeTerrain ? terrainAdjustmentBindings : [])],
    }));
    showHelp();
  }
  const changed = () => { pending = pending.then(update).catch(reportError); };
  planner.addEventListener("change", changed, { signal: abort.signal });
  terrain.addEventListener("change", changed, { signal: abort.signal });
  showHelp();
}
