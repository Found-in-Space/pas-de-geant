export { createGeantViewer, getGeantContext, type GeantViewer, type GeantViewerOptions, type GeantContext } from "./viewer.js";
export { resolveGeantConfiguration, type GeantConfiguration, type ResolvedGeantConfiguration, type GeantSurfaceFactory, type SurfaceFactoryContext } from "./config.js";
export { createGeantNavigation, GEANT_ACTIONS, type GeantNavigation, type GeantSnapshot } from "./navigation/controller.js";
export { createGeantWorldsPlugin, type GeantWorldsOptions } from "./plugins/worlds.js";
export { createGeantControlsPlugin, type GeantControlsOptions, type GeantControlsPlugin } from "./plugins/controls.js";
export { defineGeantControlScheme, extendGeantControlScheme, describeGeantControlScheme, standardGeantControlScheme,
  type GeantControlScheme, type GeantControlSchemeExtension, type GeantControlBinding, type GeantControlInput,
  type GeantButtonInput, type GeantPointerMode, type GeantXrButton } from "./navigation/control-scheme.js";
export { GEANT_MOTION_ACTIONS } from "./navigation/motion.js";
export { createGeantPanelPlugin, type GeantPanelOptions } from "./plugins/panels.js";
export { createGeantXrPlugin } from "./plugins/xr.js";
export { createGeantTileDebugPlugin, GEANT_TILE_DEBUG_ACTIONS } from "./plugins/tile-debug.js";
export { createGeantTerrainToolsPlugin, GEANT_TERRAIN_TOOL_ACTIONS } from "./plugins/terrain-tools.js";
export * from "./navigation/policy.js";
export * from "./navigation/simulation-clock.js";
export * from "./navigation/controller-input.js";
export * from "./navigation/transitions.js";
export { geantAiCapabilities } from "./ai-tools.js";

export { createGeantMovementPlugin, type GeantMovementOptions } from "./plugins/movement.js";
export type { GeantMovementModel, GeantMovementFrame, GeantMovementSelection, GeantMovementSurface, GeantPlacement, GeantRigPose } from "./navigation/movement-model.js";
export type { GeantHeightReference } from "./navigation/model-geometry.js";
export { createGeantSurfaceMovementModel, type GeantSurfaceMovementOptions } from "./navigation/surface-movement.js";
export { createGeantObservationMovementModel, type GeantObservationMovementOptions } from "./navigation/observation-movement.js";
export { createGeantShipMovementModel, type GeantShipMovementOptions } from "./navigation/ship-movement.js";
export { createGeantDesktopMovementModel } from "./navigation/desktop-movement.js";
