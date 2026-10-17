import type { SkykitPlugin } from "@found-in-space/skykit";
import { getGeantContext } from "../viewer.js";
import type { TerrainSurface } from "../worlds/terrain-surface.js";

export const GEANT_TILE_DEBUG_ACTIONS = Object.freeze({
  setOverlays: "geant:debug.setTileOverlays",
  toggleTerrain: "geant:debug.toggleTerrainOverlay", toggleImagery: "geant:debug.toggleImageryOverlay",
});
/** Diagnostic presentation is optional; surface production and planning stay in worlds. */
export function createGeantTileDebugPlugin(options: { readonly panel?: boolean } = {}) {
  let terrain = false, imagery = false;
  return {
    id: "geant:tile-debug",
    getSnapshot() { return { terrain, imagery }; },
    setup(context) {
      const geant = getGeantContext(context);
      const seen = new Set<TerrainSurface>();
      const removers: Array<() => void> = [];
      let disposed = false;
      let terrainInput: HTMLInputElement | undefined, imageryInput: HTMLInputElement | undefined;
      function sync() {
        const active = new Set([...geant.worlds.values()].flatMap(world => world.surface ? [world.surface] : []));
        for (const previous of seen) if (!active.has(previous)) {
          previous.setTileOverlayVisible(false); previous.setTextureTileOverlayVisible(false); seen.delete(previous);
        }
        for (const surface of active) {
          seen.add(surface);
          surface.setTileOverlayVisible(terrain); surface.setTextureTileOverlayVisible(imagery);
        }
        if (terrainInput) terrainInput.checked = terrain;
        if (imageryInput) imageryInput.checked = imagery;
      }
      const teardown = context.addDisposable(() => {
        if (disposed) return; disposed = true;
        for (const remove of removers.reverse()) remove();
        for (const surface of seen) { surface.setTileOverlayVisible(false); surface.setTextureTileOverlayVisible(false); }
        seen.clear(); terrain = imagery = false;
      });
      removers.push(context.actions.registerAction(GEANT_TILE_DEBUG_ACTIONS.setOverlays, ({ payload }) => {
        const value = payload as { terrain?: boolean; imagery?: boolean } | undefined;
        if (!value || (value.terrain !== undefined && typeof value.terrain !== "boolean") ||
            (value.imagery !== undefined && typeof value.imagery !== "boolean")) throw new TypeError("Overlay visibility must be boolean.");
        terrain = value.terrain ?? terrain; imagery = value.imagery ?? imagery; sync();
      }));
      removers.push(context.actions.registerAction(GEANT_TILE_DEBUG_ACTIONS.toggleTerrain, () => { terrain = !terrain; sync(); }));
      removers.push(context.actions.registerAction(GEANT_TILE_DEBUG_ACTIONS.toggleImagery, () => { imagery = !imagery; sync(); }));
      removers.push(context.addPart({ id: "geant:tile-debug", priority: 50, update: sync }));
      if (options.panel !== false && geant.host) {
        const document = geant.host.ownerDocument;
        const panel = document.createElement("fieldset"), legend = document.createElement("legend");
        legend.textContent = "Planner diagnostics"; panel.append(legend);
        panel.style.cssText = "position:absolute;top:1rem;left:1rem;z-index:2;background:#101820;color:white";
        const input = (text: string, action: string) => {
          const label = document.createElement("label"), checkbox = document.createElement("input");
          checkbox.type = "checkbox"; label.append(checkbox, text); panel.append(label);
          checkbox.addEventListener("change", () => { void context.actions.invoke(action, {}, { source: "panel" }); });
          return checkbox;
        };
        terrainInput = input(" Terrain tiles ", GEANT_TILE_DEBUG_ACTIONS.toggleTerrain);
        imageryInput = input(" Imagery tiles ", GEANT_TILE_DEBUG_ACTIONS.toggleImagery);
        geant.host.append(panel); removers.push(() => panel.remove());
      }
      sync();
      return teardown;
    },
  } satisfies SkykitPlugin & { getSnapshot(): { terrain: boolean; imagery: boolean } };
}
