// The build bundles these public, pinned SkyKit exports and their reachable
// declarations. Consumers need neither SkyKit's aggregate entry nor its stars.
export { createSkykitViewer } from "@found-in-space/skykit";
export { createSkykitXrControlBindings, createSkykitXrSessionPlugin } from "@found-in-space/skykit/xr";
export type {
  SkykitActionMetadata, SkykitActionRegistry, SkykitPlugin, SkykitPluginContext,
  SkykitPluginInput, SkykitThreeFrame, SkykitThreePart, SkykitThreePluginContext,
  SkykitViewer, SkykitViewerOptions,
} from "@found-in-space/skykit";
