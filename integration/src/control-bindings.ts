import { defineGeantControlScheme, GEANT_TILE_DEBUG_ACTIONS, GEANT_TERRAIN_TOOL_ACTIONS } from "@found-in-space/pas-de-geant";

/** These shortcuts belong to the integration experience, not to the feature plugins. */
export const plannerDebugBindings = defineGeantControlScheme({ id: "integration:planner-bindings", bindings: [
  { id: "planner.keyboard.terrain", label: "Toggle terrain planner overlay", input: { kind: "key", code: "F8" },
    action: GEANT_TILE_DEBUG_ACTIONS.toggleTerrain, category: "feature" },
  { id: "planner.keyboard.imagery", label: "Toggle imagery planner overlay", input: { kind: "key", code: "F9" },
    action: GEANT_TILE_DEBUG_ACTIONS.toggleImagery, category: "feature" },
  { id: "planner.xr.terrain", label: "Toggle terrain planner overlay (X)", input: { kind: "xr-button", hand: "left", button: "primary" },
    action: GEANT_TILE_DEBUG_ACTIONS.toggleTerrain, category: "feature" },
  { id: "planner.xr.imagery", label: "Toggle imagery planner overlay (Y)", input: { kind: "xr-button", hand: "left", button: "secondary" },
    action: GEANT_TILE_DEBUG_ACTIONS.toggleImagery, category: "feature" },
] }).bindings;

export const terrainAdjustmentBindings = defineGeantControlScheme({ id: "integration:terrain-bindings", bindings: [
  ...([ ["KeyV", 1], ["KeyC", -1] ] as const).map(([code, multiplier]) => ({
    id: `terrain.keyboard.${code}`, label: "Adjust terrain exaggeration", input: { kind: "key" as const, code },
    action: GEANT_TERRAIN_TOOL_ACTIONS.adjust, multiplier, phase: "hold" as const,
    modes: ["surface", "free", "ship"] as const,
  })),
  { id: "terrain.xr.adjust", label: "Adjust terrain exaggeration with right grip held",
    input: { kind: "xr-axis", hand: "right", axis: "x" }, action: GEANT_TERRAIN_TOOL_ACTIONS.adjust,
    modifiers: [{ kind: "xr-button", hand: "right", button: "grip" }], modes: ["surface", "observation", "orbit"], exclusiveGroup: "surface-right-stick" },
] }).bindings;
