import type { SkykitPlugin } from "../skykit-runtime.js";
import { getGeantContext } from "../viewer.js";
import { GEANT_ACTIONS } from "../navigation/controller.js";
import { applyTerrainMultiplierRate } from "../navigation/policy.js";

export const GEANT_TERRAIN_TOOL_ACTIONS = Object.freeze({ adjust: "geant:terrain.adjustMultiplier" });
/** Exposes deliberate adjustment without changing an authored initial multiplier. */
export function createGeantTerrainToolsPlugin(options: { readonly panel?: boolean } = {}) {
  return { id: "geant:terrain-tools", setup(context) {
    const geant = getGeantContext(context);
    const removers: Array<() => void> = [];
    let disposed = false;
    const teardown = context.addDisposable(() => {
      if (disposed) return; disposed = true;
      for (const remove of removers.reverse()) remove();
    });
    removers.push(context.actions.registerAction(GEANT_TERRAIN_TOOL_ACTIONS.adjust, async ({ payload, metadata }) => {
      const value = payload as { value: number; deltaSeconds: number };
      if (!value || !Number.isFinite(value.value) || !Number.isFinite(value.deltaSeconds)) throw new TypeError("Terrain adjustment requires a finite value and deltaSeconds.");
      const results = await context.actions.invoke(GEANT_ACTIONS.setTerrainMultiplier, {
        multiplier: applyTerrainMultiplierRate(geant.navigation.terrainMultiplier, value.value, value.deltaSeconds),
      }, metadata);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      return results;
    }));
    if (options.panel === false || !geant.host) return teardown;
    const document = geant.host.ownerDocument;
    const panel = document.createElement("fieldset"), legend = document.createElement("legend");
    legend.textContent = "Terrain exaggeration"; panel.append(legend);
    panel.style.cssText = "position:absolute;top:5.5rem;left:1rem;z-index:2;background:#101820;color:white";
    const label = document.createElement("label"), input = document.createElement("input"), reset = document.createElement("button");
    input.type = "number"; input.min = "0"; input.step = "0.1"; input.style.width = "5rem";
    label.append("Multiplier × ", input); panel.append(label);
    reset.type = "button"; reset.textContent = "Restore 1×"; panel.append(reset);
    const set = (multiplier: number) => { void context.actions.invoke(GEANT_ACTIONS.setTerrainMultiplier, { multiplier }, { source: "panel" }); };
    input.addEventListener("change", () => { if (input.reportValidity()) set(input.valueAsNumber); });
    reset.addEventListener("click", () => set(1));
    input.value = String(geant.navigation.terrainMultiplier);
    removers.push(geant.navigation.subscribe(state => { input.value = String(state.terrainMultiplier); }));
    geant.host.append(panel); removers.push(() => panel.remove());
    return teardown;
  } } satisfies SkykitPlugin;
}
