import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createGeantMovementPlugin, createGeantDesktopMovementModel, createGeantNavigation, createGeantViewer, createGeantWorldsPlugin, GEANT_ACTIONS, resolveGeantConfiguration } from "@found-in-space/pas-de-geant";
import { createWorldRuntime, celestialBody } from "@found-in-space/pas-de-geant/worlds";
import { createWorldSkykitPlugin } from "@found-in-space/pas-de-geant/worlds/skykit";
import { parseGeantAttributes } from "@found-in-space/pas-de-geant/embed";

function renderer() {
  return { getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600), xr: { isPresenting: false }, render: vi.fn() } as unknown as THREE.WebGLRenderer;
}
function attributes(values: Record<string, string>) {
  return { getAttribute: (key: string) => values[key] ?? null, ownerDocument: { baseURI: "https://example.test/article/" } } as unknown as HTMLElement;
}
describe("Geant domain composition", () => {
  it("keeps selected bodies independent of focus, and preserves each transported contact", () => {
    const nav = createGeantNavigation(resolveGeantConfiguration({ bodies: ["moon", "earth"], location: { latitudeDegrees: 18, longitudeDegrees: -24 } }));
    nav.dispatch(GEANT_ACTIONS.travel, { eastM: 1000, northM: -500 });
    const before = nav.getContact();
    nav.dispatch(GEANT_ACTIONS.focusBody, { body: "earth" });
    nav.dispatch(GEANT_ACTIONS.setLocation, { latitudeDegrees: 50, longitudeDegrees: 4 });
    nav.dispatch(GEANT_ACTIONS.focusBody, { body: "moon" });
    expect(nav.getContact().eastEcef.distanceTo(before.eastEcef)).toBeLessThan(1e-12);
    expect(nav.getSnapshot().locations.earth?.latitudeDegrees).toBe(50);
    expect(nav.getSnapshot().bodies).toEqual(["moon", "earth"]);
    const snapshot = nav.getSnapshot(); (snapshot.locations.moon as { latitudeDegrees: number }).latitudeDegrees = 80;
    expect(nav.getSnapshot().locations.moon?.latitudeDegrees).not.toBe(80);
    nav.dispose(); expect(() => nav.dispatch(GEANT_ACTIONS.setScale, { scaleDenominator: 100 })).toThrow(/disposed/);
  });
  it("rejects invalid commands before publishing a mutation", () => {
    const nav = createGeantNavigation(resolveGeantConfiguration());
    const listener = vi.fn(); nav.subscribe(listener);
    expect(() => nav.dispatch(GEANT_ACTIONS.setLocation, { latitudeDegrees: 91, longitudeDegrees: 0 })).toThrow();
    expect(() => nav.dispatch(GEANT_ACTIONS.focusBody, { body: "moon" })).toThrow();
    expect(() => nav.dispatch(GEANT_ACTIONS.setScale, { scaleDenominator: NaN })).toThrow();
    expect(listener).not.toHaveBeenCalled(); expect(nav.getSnapshot().revision).toBe(0);
  });
  it("uses the real SkyKit action and plugin lifecycle, with independent Moon and Earth worlds", async () => {
    const borrowedRenderer = renderer(); const earth = await createGeantViewer({ bodies: ["earth"], renderer: borrowedRenderer });
    const moon = await createGeantViewer({ bodies: ["moon"], renderer: renderer() });
    await earth.install(createGeantWorldsPlugin()); await moon.install(createGeantWorldsPlugin());
    earth.viewer.frame(0); moon.viewer.frame(0);
    const result = await moon.actions.invoke(GEANT_ACTIONS.setScale, { scaleDenominator: 50 });
    expect(result[0]?.status).toBe("fulfilled"); expect(moon.getSnapshot().scaleDenominator).toBe(50);
    expect(earth.getSnapshot().scaleDenominator).toBe(60_000);
    expect([...moon.worlds.keys()]).toEqual(["moon"]);
    const root = moon.worlds.get("moon")!.object3d;
    await moon.dispose(); expect(root.parent).toBeNull(); expect(moon.worlds.size).toBe(0);
    earth.viewer.frame(0); expect(borrowedRenderer.render).toHaveBeenCalledTimes(2); await earth.dispose();
  });
  it("rolls back a failed plugin and runs instance disposers in reverse order", async () => {
    const cleanup = vi.fn();
    await expect(createGeantViewer({ renderer: renderer(), plugins: [{ setup(context) { context.addDisposable(cleanup); throw new Error("setup failed"); } }] })).rejects.toThrow("setup failed");
    expect(cleanup).toHaveBeenCalledOnce();
    const viewer = await createGeantViewer({ renderer: renderer() }); const order: number[] = [];
    viewer.addDisposable(() => { order.push(1); }); viewer.addDisposable(() => { order.push(2); });
    await viewer.dispose(); await viewer.dispose(); expect(order).toEqual([2, 1]);
  });
  it("preserves physical observer position and scale through surface, orbit and free transitions", async () => {
    const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 1.65, 0);
    const viewer = await createGeantViewer({ bodies: ["moon"], renderer: renderer(), camera, time: "2026-10-16T12:00:00Z", timeRate: 0,
      location: { latitudeDegrees: 18, longitudeDegrees: -24 }, scaleDenominator: 50 });
    await viewer.install(createGeantWorldsPlugin()); await viewer.install(createGeantMovementPlugin({ model: createGeantDesktopMovementModel() })); viewer.viewer.frame(0);
    const initial = new THREE.Vector3().copy(viewer.context.presentation.observerJ2000M!);
    viewer.navigation.dispatch(GEANT_ACTIONS.setMode, { mode: "orbit" }); viewer.viewer.frame(0);
    expect(new THREE.Vector3().copy(viewer.context.presentation.observerJ2000M!).distanceTo(initial)).toBeLessThan(0.001);
    viewer.navigation.dispatch(GEANT_ACTIONS.setMode, { mode: "free" }); viewer.viewer.frame(0);
    const moved = initial.clone().add(new THREE.Vector3(100000, 20000, -30000));
    viewer.navigation.dispatch(GEANT_ACTIONS.setObserver, moved); viewer.viewer.frame(0);
    viewer.navigation.dispatch(GEANT_ACTIONS.setMode, { mode: "surface" }); viewer.viewer.frame(0);
    expect(new THREE.Vector3().copy(viewer.context.presentation.observerJ2000M!).distanceTo(moved)).toBeLessThan(0.001);
    expect(viewer.getSnapshot().scaleDenominator).toBe(50); await viewer.dispose();
  });
  it("uses the worlds SkyKit adapter through a real lifecycle and restores borrowed camera roots", async () => {
    const scene = new THREE.Scene(), parent = new THREE.Group(), root = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(); parent.add(camera); scene.add(parent, root);
    const viewer = await createGeantViewer({ renderer: renderer(), camera, scene, cameraRoot: root });
    const view = { latitudeDegrees: 18, longitudeDegrees: -24, displayRadiusM: 2, terrainMultiplier: 1, observerHeightWorldM: 4, focalLengthPixels: 600 };
    const world = createWorldRuntime({ body: celestialBody("moon"), renderer: renderer(), initialView: view });
    const dispose = vi.spyOn(world, "dispose");
    const unregister = await viewer.install(createWorldSkykitPlugin({ world, getView: () => view, disposeWorld: true }));
    viewer.viewer.frame(0); expect(world.object3d.parent).toBe(viewer.viewer.roots.originContentRoot);
    await unregister(); expect(dispose).toHaveBeenCalledOnce(); expect(world.object3d.parent).toBeNull();
    await viewer.dispose(); expect(camera.parent).toBe(parent); expect(root.parent).toBe(scene);
  });
  it("rejects incompatible selected-source construction without retiring another viewer", async () => {
    const viewer = await createGeantViewer({ renderer: renderer(), bodies: ["moon"] });
    await expect(viewer.install(createGeantWorldsPlugin({ surfaces: { moon: async () => { throw new Error("source failed"); } } }))).rejects.toThrow("source failed");
    expect(viewer.worlds.size).toBe(0); await viewer.dispose();
  });
});
describe("declarative configuration", () => {
  it("passes the same normalized body, time, location and physical scale as JavaScript", () => {
    const parsed = parseGeantAttributes(attributes({ "data-geant-bodies": "moon", "data-geant-location": "18,-24", "data-geant-scale": "50", "data-geant-time": "2026-10-16T12:00:00Z", "data-geant-time-rate": "0", "data-geant-stars": "false", "data-geant-controls": "grab" }));
    expect(resolveGeantConfiguration(parsed)).toEqual(resolveGeantConfiguration({ bodies: ["moon"], location: { latitudeDegrees: 18, longitudeDegrees: -24 }, scaleDenominator: 50, time: "2026-10-16T12:00:00Z", timeRate: 0 }));
    expect(parsed.controls).toMatchObject({ pointer: "grab" });
    expect(() => parseGeantAttributes(attributes({ "data-geant-scale": "" }))).toThrow();
    expect(() => parseGeantAttributes(attributes({ "data-geant-bodies": "moon", "data-geant-focus-body": "earth" }))).toThrow();
  });
});
