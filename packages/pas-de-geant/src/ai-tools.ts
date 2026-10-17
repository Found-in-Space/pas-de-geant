import type { SolarSystemBodyId } from "./worlds/solar-system.js";
import { GEANT_ACTIONS } from "./navigation/controller.js";
/** Shared capability descriptions for browser bindings and host-owned token profiles. */
export function geantAiCapabilities(bodies: readonly SolarSystemBodyId[]) {
  const actions: { name: string; action: string | null; properties: Record<string, unknown>; required: string[] }[] = [
    { name: "get_state", action: null, properties: {}, required: [] },
    { name: "set_location", action: GEANT_ACTIONS.setLocation, properties: { body: { type: "string", enum: [...bodies] }, latitudeDegrees: { type: "number" }, longitudeDegrees: { type: "number" } }, required: ["latitudeDegrees", "longitudeDegrees"] },
    { name: "set_scale", action: GEANT_ACTIONS.setScale, properties: { scaleDenominator: { type: "number" } }, required: ["scaleDenominator"] },
    { name: "focus_body", action: GEANT_ACTIONS.focusBody, properties: { body: { type: "string", enum: [...bodies] } }, required: ["body"] },
    { name: "set_mode", action: GEANT_ACTIONS.setMode, properties: { mode: { type: "string" } }, required: ["mode"] },
    { name: "set_terrain_multiplier", action: GEANT_ACTIONS.setTerrainMultiplier, properties: { multiplier: { type: "number" } }, required: ["multiplier"] },
  ];
  return actions.map(tool => ({ action: tool.action, contract: { name: tool.name,
    description: tool.action ? `Invoke ${tool.action}. Coordinates are degrees, scale is 1:N, and heights are metres.` : "Read the selected worlds, focused body, coordinates, scale, terrain and clock.",
    parameters: { type: "object", properties: tool.properties, required: tool.required, additionalProperties: false } } }));
}
