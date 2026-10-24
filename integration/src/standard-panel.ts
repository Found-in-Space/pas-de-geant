import {
  createButton, createColumn, createNode, createSlider, createTextLabel,
  type BitmapAllocation, type BitmapHandle, type DisplayComponent, type RuntimeOutput,
} from "@found-in-space/touch-os";
import { createGeantPanelPlugin, formatScaleRatio, GEANT_ACTIONS, type GeantSnapshot } from "@found-in-space/pas-de-geant";
import type { GeantBrowser } from "@found-in-space/pas-de-geant/browser";
import { createSkykitInteractionInput } from "@found-in-space/skykit/interaction";

interface MapProps {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly bitmap?: BitmapHandle;
}

const EarthMap: DisplayComponent<MapProps> = {
  kind: "integration:earth-map",
  measure: context => ({ width: context.constraints.maxWidth, height: context.constraints.maxWidth / 2 }),
  render({ id, bounds, props }) {
    const cx = bounds.x + (props.longitudeDegrees + 180) / 360 * bounds.width;
    const cy = bounds.y + (90 - props.latitudeDegrees) / 180 * bounds.height;
    return [
      { type: "rect", componentId: id, rect: bounds, fill: "#0a2230" },
      ...(props.bitmap ? [{ type: "bitmap" as const, componentId: id, rect: bounds, handle: props.bitmap, fit: "stretch" as const }] : []),
      { type: "circle", componentId: id, cx, cy, radius: 7, fill: "#03101a", stroke: "#ffffff", strokeWidth: 2 },
      { type: "circle", componentId: id, cx, cy, radius: 3, fill: "#76ddf1" },
    ];
  },
  hitTest: ({ id }) => ({ targetId: id }),
  handleEvent({ id, bounds, event, emit }) {
    if (event.type !== "press") return;
    emit({ type: "action", componentId: id, actionId: GEANT_ACTIONS.setLocation, payload: {
      body: "earth", latitudeDegrees: 90 - event.localY / bounds.height * 180,
      longitudeDegrees: event.localX / bounds.width * 360 - 180, altitudeM: 0,
    } });
  },
};

/** The TouchOS slider uses log10(denominator). */
export function scaleAction(logarithm: number) {
  return { id: GEANT_ACTIONS.setScale, payload: { scaleDenominator: 10 ** logarithm } };
}

export function panelAction(output: RuntimeOutput) {
  if (output.type === "change-request" && (output.phase === undefined || output.phase === "update") && output.field === "scale" && typeof output.value === "number") {
    return scaleAction(output.value);
  }
  if (output.type === "action") return { id: output.actionId, payload: output.payload };
  return null;
}

export function standardPanelRoot(snapshot: GeantSnapshot, bitmap?: BitmapHandle) {
  const location = snapshot.locations.earth!;
  // Widen the displayed slider range when keyboard/XR controls go beyond its initial range.
  const value = Math.log10(snapshot.scaleDenominator);
  return createColumn("standard-panel", { padding: 12, gap: 10, backgroundColor: "#03101a", children: [
    createTextLabel("panel-title", { text: "EARTH · BLUE MARBLE" }),
    createNode("earth-map", EarthMap, { ...location, bitmap }),
    createTextLabel("coordinates", { text: `${location.latitudeDegrees.toFixed(3)}°, ${location.longitudeDegrees.toFixed(3)}°` }),
    createSlider("panel-scale", { label: "Scale", field: "scale", min: Math.min(0, Math.floor(value)),
      max: Math.max(9, Math.ceil(value)), step: 0.01, value, valueText: formatScaleRatio(snapshot.scaleDenominator) }),
    createButton("panel-mode", { label: `Mode · ${snapshot.mode}`, actionId: GEANT_ACTIONS.setMode,
      payload: { mode: snapshot.mode === "surface" ? "observation" : snapshot.mode === "observation" ? "ship" : "surface" } }),
    createTextLabel("map-help", { text: "Select a place on the map", tone: "muted" }),
  ] });
}

/** Desktop and XR share applied state; TouchOS owns their separate input and presentation. */
export async function installStandardPanel(browser: GeantBrowser, host: HTMLElement, map?: BitmapAllocation) {
  const bitmaps = new WeakMap<object, BitmapHandle>();
  const input = createSkykitInteractionInput({ renderer: browser.renderer, origin: browser.cameraRoot,
    include: source => source.handedness === "right" || source.targetRayMode !== "tracked-pointer" });
  browser.addDisposable(() => input.dispose());
  await browser.install(createGeantPanelPlugin({
    id: "integration:standard-panel", surface: { width: 480, height: 480, pixelDensity: 1 },
    theme: { backgroundColor: "#03101a", accentColor: "#76ddf1", textColor: "#eef8fb" },
    root: (snapshot, runtime) => standardPanelRoot(snapshot, runtime ? bitmaps.get(runtime) : undefined), action: panelAction,
    inputs: [input], desktop: host, anchor: true, mode: "overlay",
    initialize(runtime) {
      if (map) { bitmaps.set(runtime, runtime.getServices().bitmaps.allocate("earth-map", map)); }
    },
    placement: { panelWidth: 0.3, panelHeight: 0.3, tiltRadians: -Math.PI * 0.35,
      offset: { x: 0, y: 0.08, z: -0.03 },
      textureQuality: { anisotropy: Math.min(4, browser.renderer.capabilities.getMaxAnisotropy()) } },
    frame(_frame, context) {
      return { timestamp: performance.now(), scene: context.scene, camera: context.camera,
        anchorPose: input.getGripPose("left") };
    }
  }));
}
