import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  createGeantMovementPlugin, createGeantSurfaceMovementModel, createGeantObservationMovementModel, createGeantShipMovementModel, createGeantDesktopMovementModel,
  createGeantControlsPlugin, createGeantTerrainToolsPlugin, createGeantTileDebugPlugin, createGeantViewer, createGeantXrPlugin,
  defineGeantControlScheme, extendGeantControlScheme, standardGeantControlScheme,
  GEANT_ACTIONS, GEANT_MOTION_ACTIONS, GEANT_TILE_DEBUG_ACTIONS, GEANT_TERRAIN_TOOL_ACTIONS,
  type GeantControlsOptions, type GeantControlBinding, type GeantViewer,
} from "@found-in-space/pas-de-geant";
import { bodyPositionJ2000M, type WorldRuntime } from "@found-in-space/pas-de-geant/worlds";

// Exercise the real plugins/actions and Three cameras without a browser or WebGL.
class InputTarget extends EventTarget {
  tagName = "DIV";
  isContentEditable = false;
  clientHeight = 600;
  ownerDocument = Object.assign(new EventTarget(), { defaultView: new EventTarget() });
  captures = new Set<number>();
  focus() {}
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
}
function event(target: EventTarget, type: string, fields: Record<string, unknown> = {}) {
  const value = new Event(type, { cancelable: true }); Object.assign(value, fields); target.dispatchEvent(value); return value;
}
const viewers: GeantViewer[] = [];
afterEach(async () => { for (const viewer of viewers.splice(0)) await viewer.dispose(); });
async function fixture(options: GeantControlsOptions = {}, mode: "surface" | "orbit" | "free" = "surface") {
  const host = new InputTarget(), canvas = new InputTarget();
  const left = { handedness: "left", gamepad: { axes: [0, 0, 0, 0], buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })) } };
  const right = { handedness: "right", gamepad: { axes: [0, 0, 0, 0], buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })) } };
  const session = { inputSources: [left, right] };
  const head = new THREE.PerspectiveCamera();
  const xr = { isPresenting: false, getSession: () => session, getCamera: () => head };
  const renderer = { domElement: canvas, xr, render: vi.fn() } as unknown as THREE.WebGLRenderer;
  const viewer = await createGeantViewer({ renderer, host: host as unknown as HTMLElement, bodies: ["moon"], mode,
    time: "2026-10-17T12:00:00Z", timeRate: 0, scaleDenominator: 50 });
  viewers.push(viewer);
  const surface = createGeantSurfaceMovementModel(), observation = createGeantObservationMovementModel(), ship = createGeantShipMovementModel(), desktop = createGeantDesktopMovementModel();
  const movement = createGeantMovementPlugin({ model: frame => !frame.xr ? desktop : frame.state.mode === "surface" ? surface : frame.state.mode === "orbit" ? observation : ship });
  await viewer.install(movement); viewer.update(0);
  const controls = createGeantControlsPlugin(options), uninstall = await viewer.install(controls);
  const tick = (delta = 1) => viewer.update(delta);
  const button = (hand: typeof left, index: number, pressed: boolean) => Object.assign(hand.gamepad.buttons[index]!, { pressed, value: Number(pressed) });
  const key = (code: string, down = true, repeat = false) => event(host, down ? "keydown" : "keyup", { code, repeat });
  const drag = (dx: number, dy: number) => {
    event(canvas, "pointerdown", { pointerId: 1, clientX: 0, clientY: 0 });
    event(canvas, "pointermove", { pointerId: 1, clientX: dx, clientY: dy });
  };
  return { viewer, controls, uninstall, observation, movement, host, canvas, xr, session, left, right, head, tick, key, drag, button };
}
const extra: GeantControlBinding = { id: "custom", label: "Custom feature", input: { kind: "key", code: "KeyP" }, action: "test:custom", category: "feature" };
// Test-authored mappings deliberately differ from the integration app's choices.
const plannerTestBindings = defineGeantControlScheme({ id: "test:planner", bindings: [
  { id: "test.planner.terrain", label: "Toggle terrain overlay", input: { kind: "xr-button", hand: "right", button: "secondary" },
    action: GEANT_TILE_DEBUG_ACTIONS.toggleTerrain, category: "feature" },
  { id: "test.planner.imagery", label: "Toggle imagery overlay", input: { kind: "key", code: "KeyP" },
    action: GEANT_TILE_DEBUG_ACTIONS.toggleImagery, category: "feature" },
] }).bindings;
const terrainTurn = { ...standardGeantControlScheme.bindings.find(binding => binding.id === "xr.turn")!, unless: [{ kind: "xr-button" as const, hand: "right" as const, button: "trigger" as const }] };
const terrainTestBindings = defineGeantControlScheme({ id: "test:terrain", bindings: [
  { id: "test.terrain.keyboard", label: "Adjust terrain", input: { kind: "key", code: "KeyT" },
    action: GEANT_TERRAIN_TOOL_ACTIONS.adjust, phase: "hold", modes: ["surface", "free"] },
  { id: "test.terrain.xr", label: "Adjust terrain with modifier", input: { kind: "xr-axis", hand: "right", axis: "x" },
    action: GEANT_TERRAIN_TOOL_ACTIONS.adjust, modifiers: [{ kind: "xr-button", hand: "right", button: "trigger" }],
    modes: ["surface"], exclusiveGroup: "surface-right-stick" },
] }).bindings;

describe("control scheme composition", () => {
  it("adds, replaces and removes bindings without mutating the source or nested payloads", () => {
    const source = { ...extra, payload: { nested: { value: 1 } } };
    const base = defineGeantControlScheme({ id: "base", bindings: [source] });
    (source.payload.nested.value) = 2;
    const replaced = extendGeantControlScheme(base, { id: "replacement", replace: [{ ...extra, input: { kind: "key", code: "KeyQ" } }] });
    expect(base.bindings[0]?.payload).toEqual({ nested: { value: 1 } });
    expect(base.bindings[0]?.input).toEqual({ kind: "key", code: "KeyP" });
    expect(replaced.bindings[0]?.input).toEqual({ kind: "key", code: "KeyQ" });
    expect(extendGeantControlScheme(replaced, { id: "empty", remove: ["custom"] }).bindings).toHaveLength(0);
    expect(Object.isFrozen(base.bindings[0]?.payload)).toBe(true);
  });
  it("rejects ambiguous inputs and unknown replacements while permitting mode and modifier alternatives", () => {
    expect(() => extendGeantControlScheme(standardGeantControlScheme, { id: "collision", add: [{ ...extra, input: { kind: "key", code: "KeyW" } }] })).toThrow(/Conflicting/);
    expect(() => extendGeantControlScheme(standardGeantControlScheme, { id: "unknown", replace: [extra] })).toThrow(/unknown/);
    expect(() => extendGeantControlScheme(standardGeantControlScheme, { id: "unknown", remove: [extra.id] })).toThrow(/unknown/);
    const modifier = { kind: "key" as const, code: "ControlLeft" };
    expect(defineGeantControlScheme({ id: "chord", bindings: [
      { ...extra, modifiers: [modifier] }, { ...extra, id: "plain", unless: [modifier] },
    ] }).bindings).toHaveLength(2);
    expect(extendGeantControlScheme(standardGeantControlScheme, { id: "tools", replace: [terrainTurn], add: [...plannerTestBindings, ...terrainTestBindings] }).bindings.length)
      .toBeGreaterThan(standardGeantControlScheme.bindings.length);
  });
});

describe("standard controls", () => {
  it("keeps XR sessions and tracked eye height available without installing manual controls", async () => {
    const session = { inputSources: [{ handedness: "right", gamepad: { axes: [0, 0, 1, -1], buttons: [] } }], end: vi.fn(async () => {}) };
    const head = new THREE.PerspectiveCamera();
    const xr = Object.assign(new EventTarget(), { isPresenting: true, getSession: () => session, getCamera: () => head });
    const viewer = await createGeantViewer({ renderer: { xr, render() {} } as unknown as THREE.WebGLRenderer,
      bodies: ["moon"], scaleDenominator: 50, time: "2026-10-17T12:00:00Z", timeRate: 0 });
    viewers.push(viewer); await viewer.install(createGeantXrPlugin());
    const before = viewer.getSnapshot(); event(xr, "sessionstart"); viewer.update(1);
    expect(viewer.getSnapshot()).toEqual(before);
    expect(viewer.camera.position.y).toBe(0);
    event(xr, "sessionend"); expect(viewer.camera.position.y).toBe(1.65);
  });
  it("uses the same public motion command and canonical adapter for keyboard, XR and authored input", async () => {
    const a = await fixture(), b = await fixture(), c = await fixture();
    const adapter = vi.fn((payload) => a.viewer.navigation.dispatch(GEANT_ACTIONS.travel, payload));
    a.viewer.navigation.adaptAction(GEANT_ACTIONS.travel, adapter);
    a.key("KeyW"); a.tick(0.25);
    b.xr.isPresenting = true; b.tick(0); b.left.gamepad.axes[3] = -1; b.tick(0.25);
    await c.viewer.actions.invoke(GEANT_MOTION_ACTIONS.move, { forward: 1, deltaSeconds: 0.25 });
    expect(adapter).toHaveBeenCalledOnce();
    expect(a.viewer.getSnapshot().locations).toEqual(b.viewer.getSnapshot().locations);
    expect(a.viewer.getSnapshot().locations).toEqual(c.viewer.getSnapshot().locations);
    expect(a.viewer.getSnapshot().locations.moon?.latitudeDegrees).toBeGreaterThan(0);
  });
  it("preserves analog magnitude and projects surface travel onto the floor", async () => {
    const a = await fixture(), b = await fixture();
    a.xr.isPresenting = b.xr.isPresenting = true; a.tick(0); b.tick(0);
    a.left.gamepad.axes[3] = -0.5; b.left.gamepad.axes[3] = -1;
    a.head.rotation.x = -0.6; a.tick(0.1); b.tick(0.1);
    expect(a.viewer.getSnapshot().locations.moon!.latitudeDegrees / b.viewer.getSnapshot().locations.moon!.latitudeDegrees).toBeCloseTo(0.5, 5);
  });
  it("shares configurable speed and adapter failures across devices and authored commands", async () => {
    const a = await fixture({ speedHeadsetMPerSecond: 2 }), b = await fixture();
    a.key("KeyW"); a.tick(0.25);
    await b.viewer.actions.invoke(GEANT_MOTION_ACTIONS.move, { forward: 1, deltaSeconds: 0.25, speedHeadsetMPerSecond: 2 });
    expect(a.viewer.getSnapshot().locations).toEqual(b.viewer.getSnapshot().locations);
    b.viewer.navigation.adaptAction(GEANT_ACTIONS.setScale, () => { throw new Error("scale rejected"); });
    const result = await b.viewer.actions.invoke(GEANT_MOTION_ACTIONS.scale, { value: 1, deltaSeconds: 0.5 });
    expect(result[0]?.status).toBe("rejected");
    expect(b.viewer.getSnapshot().scaleDenominator).toBe(50);
  });
  it("keeps planner shortcuts optional and uses the vertical stick for altitude", async () => {
    const f = await fixture();
    const debug = createGeantTileDebugPlugin({ panel: false }); await f.viewer.install(debug);
    f.xr.isPresenting = true; f.tick(0);
    f.button(f.left, 4, true); f.button(f.left, 5, true);
    f.right.gamepad.axes[2] = 0.2; f.right.gamepad.axes[3] = -0.6; f.tick(0.5);
    expect(debug.getSnapshot()).toEqual({ terrain: false, imagery: false });
    expect(f.viewer.getSnapshot().terrainMultiplier).toBe(1);
    expect(f.viewer.getSnapshot().scaleDenominator).toBe(50);
    expect(f.viewer.getSnapshot().locations.moon!.altitudeM).toBeGreaterThan(0);
  });
  it("gates orbit dragging, wheel and travel with movement false while allowing surface look", async () => {
    const f = await fixture({ movement: false }, "orbit");
    const before = f.viewer.getSnapshot();
    f.drag(40, 20); f.key("KeyW"); event(f.canvas, "wheel", { deltaY: 600 }); f.tick();
    expect(f.viewer.getSnapshot()).toEqual(before);
    f.viewer.navigation.dispatch(GEANT_ACTIONS.setMode, { mode: "surface" });
    f.tick(0); const surfaceLocation = f.viewer.getSnapshot().locations;
    f.drag(40, 20); f.tick();
    expect(f.viewer.camera.rotation.y).not.toBe(0);
    expect(f.viewer.getSnapshot().locations).toEqual(surfaceLocation);
  });
  it("rotates an orbit without changing distance or surface location, and changes orbital distance separately", async () => {
    const f = await fixture({}, "orbit");
    const focus = bodyPositionJ2000M("moon", new Date(f.viewer.getSnapshot().time));
    const origin = new THREE.Vector3(focus.x + 10_000_000, focus.y, focus.z);
    f.viewer.navigation.dispatch(GEANT_ACTIONS.setObserver, origin);
    const location = f.viewer.getSnapshot().locations;
    f.key("KeyD"); f.tick(0.2); f.key("KeyD", false);
    const after = new THREE.Vector3().copy(f.viewer.getSnapshot().observerJ2000M!);
    expect(after.distanceTo(new THREE.Vector3().copy(focus))).toBeCloseTo(10_000_000, 3);
    expect(after.distanceTo(origin)).toBeGreaterThan(1);
    expect(f.viewer.getSnapshot().locations).toEqual(location);
    event(f.canvas, "wheel", { deltaY: 600 }); f.tick();
    expect(new THREE.Vector3().copy(f.viewer.getSnapshot().observerJ2000M!).distanceTo(new THREE.Vector3().copy(focus))).toBeCloseTo(20_000_000, 3);
    expect(f.viewer.getSnapshot().scaleDenominator).toBe(50);
  });
  it("latches observation turning and ground-altitude adjustment until neutral", async () => {
    const f = await fixture({}, "orbit"); f.xr.isPresenting = true; f.tick(0);
    f.right.gamepad.axes[2] = 0.9; f.right.gamepad.axes[3] = -0.6; f.tick(0.5);
    expect(f.viewer.getSnapshot().scaleDenominator).toBe(50);
    const anchor = f.observation.getAnchor()!, yaw = f.viewer.cameraRoot.rotation.y;
    const altitude = f.viewer.getSnapshot().locations.moon!.altitudeM;
    f.right.gamepad.axes[2] = 0; f.right.gamepad.axes[3] = -0.9; f.tick(0.5);
    expect(f.observation.getAnchor()!.position.equals(anchor.position)).toBe(true);
    expect(f.viewer.cameraRoot.rotation.y).toBe(yaw);
    expect(f.viewer.getSnapshot().locations.moon!.altitudeM).toBe(altitude);
    f.right.gamepad.axes[3] = 0; f.tick(0);
    f.right.gamepad.axes[3] = -0.9; f.tick(0.5);
    expect(f.viewer.getSnapshot().locations.moon!.altitudeM).toBeGreaterThan(altitude);
    expect(f.observation.getAnchor()).toEqual(anchor);
    expect(f.viewer.getSnapshot().scaleDenominator).toBe(50);
  });
  it("isolates viewers, editable targets and disabled keyboard/pointer input", async () => {
    const a = await fixture(), b = await fixture({ keyboard: false, pointer: "none" });
    a.key("KeyW"); a.tick(0.1); b.tick(0.1);
    expect(a.viewer.getSnapshot().locations).not.toEqual(b.viewer.getSnapshot().locations);
    const before = b.viewer.getSnapshot(); b.key("KeyW"); b.drag(50, 40); event(b.canvas, "wheel", { deltaY: 600 }); b.tick();
    expect(b.viewer.getSnapshot()).toEqual(before);
    a.key("KeyW", false); const after = a.viewer.getSnapshot(); a.host.tagName = "INPUT"; a.key("KeyW"); a.tick();
    expect(a.viewer.getSnapshot()).toEqual(after);
  });
});

describe("optional control extensions and input lifetime", () => {
  it("lets X/Y invoke unrelated actions while planner actions use host-chosen keyboard and XR inputs", async () => {
    const scheme = extendGeantControlScheme(standardGeantControlScheme, { id: "authored", add: [
      ...plannerTestBindings,
      { id: "test.x", label: "Custom X action", input: { kind: "xr-button", hand: "left", button: "primary" }, action: "test:x", category: "feature" },
      { id: "test.y", label: "Custom Y action", input: { kind: "xr-button", hand: "left", button: "secondary" }, action: "test:y", category: "feature" },
    ] });
    const f = await fixture({ scheme }), x = vi.fn(), y = vi.fn();
    f.viewer.actions.registerAction("test:x", x); f.viewer.actions.registerAction("test:y", y);
    const debug = createGeantTileDebugPlugin({ panel: false }); await f.viewer.install(debug);
    f.xr.isPresenting = true; f.tick(0);
    f.button(f.left, 4, true); f.button(f.left, 5, true); f.tick(); f.tick();
    expect(x).toHaveBeenCalledOnce(); expect(y).toHaveBeenCalledOnce();
    expect(debug.getSnapshot()).toEqual({ terrain: false, imagery: false });
    f.button(f.right, 5, true); f.tick();
    expect(debug.getSnapshot()).toEqual({ terrain: true, imagery: false });
    f.xr.isPresenting = false; f.tick(0); f.key("KeyP"); f.tick();
    expect(debug.getSnapshot()).toEqual({ terrain: true, imagery: true });
  });
  it("adds planner edge actions and removes the plugin's parts, actions and visible overlays", async () => {
    const f = await fixture({ scheme: extendGeantControlScheme(standardGeantControlScheme, { id: "debug", add: plannerTestBindings }) });
    const surface = { setTileOverlayVisible: vi.fn(), setTextureTileOverlayVisible: vi.fn() };
    (f.viewer.worlds as Map<string, WorldRuntime>).set("moon", { surface } as unknown as WorldRuntime);
    const debug = createGeantTileDebugPlugin({ panel: false }), remove = await f.viewer.install(debug);
    f.xr.isPresenting = true; f.tick(0); f.button(f.right, 5, true); f.tick(); f.tick();
    expect(debug.getSnapshot().terrain).toBe(true);
    expect(surface.setTileOverlayVisible).toHaveBeenLastCalledWith(true);
    f.button(f.right, 5, false); f.tick(); f.button(f.right, 5, true); f.tick();
    expect(debug.getSnapshot().terrain).toBe(false);
    f.controls.setScheme(standardGeantControlScheme); await remove(); f.tick();
    expect(f.viewer.actions.listActions().some(action => action.id === GEANT_TILE_DEBUG_ACTIONS.toggleTerrain)).toBe(false);
    expect(surface.setTileOverlayVisible).toHaveBeenLastCalledWith(false);
    expect(f.viewer.viewer.getSnapshot().parts.some(part => part.id === "geant:tile-debug")).toBe(false);
  });
  it("requires the terrain modifier, preserves authored exaggeration, and leaves orbit altitude available", async () => {
    const f = await fixture({ scheme: extendGeantControlScheme(standardGeantControlScheme, { id: "terrain", replace: [terrainTurn], add: terrainTestBindings }) });
    await f.viewer.actions.invoke(GEANT_ACTIONS.setTerrainMultiplier, { multiplier: 2 });
    const remove = await f.viewer.install(createGeantTerrainToolsPlugin({ panel: false }));
    f.xr.isPresenting = true; f.tick(0); f.right.gamepad.axes[2] = 0.8; f.tick(0.5);
    expect(f.viewer.getSnapshot().terrainMultiplier).toBe(2);
    f.button(f.right, 0, true); f.tick(0.5);
    expect(f.viewer.getSnapshot().terrainMultiplier).toBeGreaterThan(2);
    const multiplier = f.viewer.getSnapshot().terrainMultiplier;
    f.viewer.navigation.dispatch(GEANT_ACTIONS.setMode, { mode: "orbit" });
    f.right.gamepad.axes[2] = 0; f.button(f.right, 0, false); f.tick(0);
    f.right.gamepad.axes[2] = 0.8; f.tick(0.5);
    expect(f.viewer.cameraRoot.rotation.y).not.toBe(0);
    expect(f.viewer.getSnapshot().terrainMultiplier).toBe(multiplier);
    f.controls.setScheme(standardGeantControlScheme); await remove();
    expect(f.viewer.getSnapshot().terrainMultiplier).toBe(multiplier);
    expect(f.viewer.actions.listActions().some(action => action.id === GEANT_TERRAIN_TOOL_ACTIONS.adjust)).toBe(false);
  });
  it("keeps the stick latched when a terrain modifier is released mid-gesture", async () => {
    const f = await fixture({ scheme: extendGeantControlScheme(standardGeantControlScheme, { id: "terrain", replace: [terrainTurn], add: terrainTestBindings }) });
    await f.viewer.install(createGeantTerrainToolsPlugin({ panel: false }));
    f.xr.isPresenting = true; f.tick(0);
    f.button(f.right, 0, true); f.right.gamepad.axes[2] = 0.9; f.right.gamepad.axes[3] = -0.5; f.tick(0.1);
    const multiplier = f.viewer.getSnapshot().terrainMultiplier;
    expect(multiplier).toBeGreaterThan(1);
    f.button(f.right, 0, false); f.tick(0.1);
    f.right.gamepad.axes[3] = -0.9; f.tick(0.1);
    expect(f.viewer.getSnapshot().scaleDenominator).toBe(50);
    expect(f.viewer.getSnapshot().terrainMultiplier).toBe(multiplier);
    f.right.gamepad.axes[2] = f.right.gamepad.axes[3] = 0; f.tick(0);
    f.right.gamepad.axes[3] = -0.9; f.tick(0.1);
    expect(f.viewer.getSnapshot().scaleDenominator).toBe(50);
    expect(f.viewer.getSnapshot().locations.moon!.altitudeM).toBeGreaterThan(0);
  });
  it("follows replacement surfaces and clears diagnostics when they are retired", async () => {
    const f = await fixture();
    const surface = () => ({ setTileOverlayVisible: vi.fn(), setTextureTileOverlayVisible: vi.fn() });
    const old = surface(), next = surface();
    const worlds = f.viewer.worlds as Map<string, WorldRuntime>;
    worlds.set("moon", { surface: old } as unknown as WorldRuntime);
    const remove = await f.viewer.install(createGeantTileDebugPlugin({ panel: false }));
    await f.viewer.actions.invoke(GEANT_TILE_DEBUG_ACTIONS.setOverlays, { terrain: true, imagery: true });
    worlds.set("moon", { surface: next } as unknown as WorldRuntime); f.tick(0);
    expect(old.setTileOverlayVisible).toHaveBeenLastCalledWith(false);
    expect(next.setTileOverlayVisible).toHaveBeenLastCalledWith(true);
    await remove(); expect(next.setTextureTileOverlayVisible).toHaveBeenLastCalledWith(false);
  });
  it("clears held keys on scheme and mode changes, blur and disposal", async () => {
    const f = await fixture(); f.key("KeyW"); f.tick(0.1);
    f.controls.setScheme(standardGeantControlScheme); const before = f.viewer.getSnapshot();
    f.key("KeyW", true, true); f.tick(); expect(f.viewer.getSnapshot()).toEqual(before);
    f.key("KeyW", false); f.key("KeyW"); f.tick(0.1); expect(f.viewer.getSnapshot()).not.toEqual(before);
    f.viewer.navigation.dispatch(GEANT_ACTIONS.setMode, { mode: "orbit" }); f.tick(0); const orbit = f.viewer.getSnapshot();
    f.tick(); expect(f.viewer.getSnapshot()).toEqual(orbit);
    f.key("KeyW", false); f.key("KeyW"); event(f.host, "blur"); f.tick(); expect(f.viewer.getSnapshot()).toEqual(orbit);
    f.drag(20, 20); expect(f.canvas.captures.size).toBe(1);
    await f.uninstall(); expect(f.canvas.captures.size).toBe(0);
    f.key("KeyX"); f.tick(); expect(f.viewer.getSnapshot()).toEqual(orbit);
    expect(() => f.controls.setScheme(standardGeantControlScheme)).toThrow(/disposed/);
    await f.viewer.install(createGeantControlsPlugin());
  });
  it("requires neutral XR input after scheme/session/source changes and never rotates the tracked camera", async () => {
    const f = await fixture(); f.xr.isPresenting = true; f.left.gamepad.axes[3] = -1; const before = f.viewer.getSnapshot();
    f.tick(); expect(f.viewer.getSnapshot()).toEqual(before);
    f.left.gamepad.axes[3] = 0; f.tick(0); f.left.gamepad.axes[3] = -1; f.tick(0.1);
    const moved = f.viewer.getSnapshot(); expect(moved.locations).not.toEqual(before.locations);
    f.controls.setScheme(standardGeantControlScheme); f.tick(); expect(f.viewer.getSnapshot()).toEqual(moved);
    f.left.gamepad.axes[3] = 0; f.tick(0); f.right.gamepad.axes[2] = 0.8;
    const orientation = f.head.quaternion.clone(); f.tick(0.1);
    expect(f.viewer.cameraRoot.rotation.y).not.toBe(0); expect(f.head.quaternion.equals(orientation)).toBe(true);
    f.session.inputSources = [f.right]; f.tick();
    f.session.inputSources = [f.left, f.right]; f.tick(); expect(f.viewer.getSnapshot()).toEqual(moved);
  });
  it("clears held input when a model object changes under the same navigation label", async () => {
    const f = await fixture(); f.key("KeyW"); f.tick(0.1);
    const before = f.viewer.getSnapshot().locations;
    f.movement.setModel(createGeantSurfaceMovementModel({ id: "host:other-surface" })); f.tick(0.1);
    expect(f.viewer.getSnapshot().locations).toEqual(before);
    f.key("KeyW", true, true); f.tick(0.1); expect(f.viewer.getSnapshot().locations).toEqual(before);
    f.key("KeyW", false); f.key("KeyW"); f.tick(0.1);
    expect(f.viewer.getSnapshot().locations).not.toEqual(before);
  });
  it("snaps by a fixed angle once per deflection and repeats after neutral", async () => {
    const f = await fixture(); f.xr.isPresenting = true; f.tick(0);
    f.right.gamepad.axes[2] = 0.5; f.tick(0.1);
    expect(f.viewer.cameraRoot.rotation.y).toBeCloseTo(-Math.PI / 6);
    f.tick(0.1); expect(f.viewer.cameraRoot.rotation.y).toBeCloseTo(-Math.PI / 6);
    f.right.gamepad.axes[2] = 0; f.tick(0);
    f.right.gamepad.axes[2] = 0.9; f.tick(0.1);
    expect(f.viewer.cameraRoot.rotation.y).toBeCloseTo(-Math.PI / 3);
  });
  it("tracks custom chord modifiers and refuses a second input owner", async () => {
    const scheme = defineGeantControlScheme({ id: "chord", bindings: [{ ...extra, modifiers: [{ kind: "key", code: "ControlLeft" }] }] });
    const f = await fixture({ scheme }), action = vi.fn(); f.viewer.actions.registerAction(extra.action, action);
    f.key("KeyP"); f.tick(); expect(action).not.toHaveBeenCalled(); f.key("KeyP", false);
    f.key("ControlLeft"); f.key("KeyP"); f.tick(); expect(action).toHaveBeenCalledOnce();
    await expect(f.viewer.install(createGeantControlsPlugin())).rejects.toThrow(/already has controls/);
  });
});
