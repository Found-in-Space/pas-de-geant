import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeantBodyAppearancePlugin, createGeantViewer, getGeantContext, GEANT_ACTIONS,
  type BodyAppearance, type BodyAppearanceContext, type GeantSimulationTimeSnapshot } from "@found-in-space/pas-de-geant";
import { createSunAppearance } from "@found-in-space/pas-de-geant/appearances";
import { celestialBody } from "@found-in-space/pas-de-geant/worlds";

const atMs = Date.parse("2026-10-17T12:00:00Z");
function renderer() { return { render: vi.fn(), xr: { isPresenting: false } } as unknown as THREE.WebGLRenderer; }
function model(): BodyAppearance & { update: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } {
  return { object3d: new THREE.Group(), update: vi.fn(), dispose: vi.fn() };
}
afterEach(() => vi.useRealTimers());

describe("simulation time available to plugins", () => {
  it("samples once before frame parts, advances backwards, and publishes seeks while paused", async () => {
    vi.useFakeTimers(); vi.setSystemTime(atMs);
    const viewer = await createGeantViewer({ renderer: renderer(), time: new Date(atMs).toISOString(), timeRate: -2 });
    const notifications: { atMs: number; reason: string; revision: number }[] = [];
    const abort = new AbortController();
    viewer.time.subscribe((time, reason) => notifications.push({ atMs: time.atMs, reason, revision: time.revision }), { signal: abort.signal });
    const samples: GeantSimulationTimeSnapshot[] = [];
    await viewer.install({ setup(context) {
      const time = getGeantContext(context).time;
      context.addPart({ id: "first-reader", update() { samples.push(time.getSnapshot()); vi.setSystemTime(Date.now() + 50); } });
      context.addPart({ id: "second-reader", update() { samples.push(time.getSnapshot()); } });
    } });
    vi.setSystemTime(atMs + 1000); viewer.frame(1);
    expect(samples[0]).toBe(samples[1]); expect(Object.isFrozen(samples[0])).toBe(true);
    expect(samples[0]).toMatchObject({ atMs: atMs - 2000, deltaMs: -2000, rate: -2, revision: 0 });
    viewer.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs: atMs + 10_000, rate: 0 });
    expect(viewer.time.getSnapshot()).toMatchObject({ atMs: atMs + 10_000, rate: 0, revision: 1, discontinuity: true });
    const count = notifications.length;
    vi.setSystemTime(atMs + 50_000); viewer.frame(1);
    expect(notifications).toHaveLength(count);
    expect(viewer.time.getSnapshot()).toMatchObject({ deltaMs: 12_000, discontinuity: true });
    viewer.frame(0); expect(viewer.time.getSnapshot()).toMatchObject({ deltaMs: 0, discontinuity: false });
    viewer.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs: atMs + 10_000, rate: 3 });
    expect(viewer.time.getSnapshot()).toMatchObject({ rate: 3, revision: 2, discontinuity: false });
    expect(notifications.map(event => event.reason)).toEqual(["initial", "advance", "clock", "clock"]);
    abort.abort(); viewer.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs, rate: 0 });
    expect(notifications).toHaveLength(4);
    const reused = vi.fn(), removeFirst = viewer.time.subscribe(reused), removeSecond = viewer.time.subscribe(reused);
    expect(reused).toHaveBeenCalledTimes(2); removeFirst();
    viewer.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs: atMs + 1, rate: 0 }); expect(reused).toHaveBeenCalledTimes(3);
    removeSecond(); await viewer.dispose();
    expect(() => viewer.time.subscribe(() => {})).toThrow(/disposed/);
  });
});

describe("replaceable body appearances", () => {
  it("preserves host placement and the active appearance during failed or pending replacements", async () => {
    const viewer = await createGeantViewer({ renderer: renderer(), bodies: ["sun"], timeRate: 0 });
    const first = model(), next = model();
    let firstContext!: BodyAppearanceContext;
    const notified = vi.fn();
    const plugin = createGeantBodyAppearancePlugin({ body: celestialBody("sun"), appearance(context) {
      firstContext = context; context.time.subscribe(notified, { signal: context.signal }); return first;
    } });
    plugin.object3d.position.set(11, 1.45, -0.85); plugin.object3d.scale.setScalar(10);
    const uninstall = await viewer.install(plugin); viewer.frame(0);
    expect(first.update.mock.calls.at(-1)?.[0].time).toBe(viewer.time.getSnapshot());
    await expect(plugin.setAppearance(() => { throw new Error("source failed"); })).rejects.toThrow("source failed");
    expect(first.object3d.parent).toBe(plugin.object3d); expect(first.dispose).not.toHaveBeenCalled();
    let finish!: (appearance: BodyAppearance) => void;
    const replacement = plugin.setAppearance(() => new Promise(resolve => { finish = resolve; }));
    expect(first.object3d.parent).toBe(plugin.object3d); finish(next); await replacement;
    expect(firstContext.signal.aborted).toBe(true); expect(first.dispose).toHaveBeenCalledOnce();
    expect(next.object3d.parent).toBe(plugin.object3d);
    expect(plugin.object3d.position.toArray()).toEqual([11, 1.45, -0.85]); expect(plugin.object3d.scale.x).toBe(10);
    const count = notified.mock.calls.length;
    viewer.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs, rate: 0 }); expect(notified).toHaveBeenCalledTimes(count);
    await uninstall(); expect(next.dispose).toHaveBeenCalledOnce(); expect(plugin.object3d.parent).toBeNull();
    await viewer.dispose(); expect(next.dispose).toHaveBeenCalledOnce();
  });

  it("discards superseded and post-disposal asynchronous results", async () => {
    const viewer = await createGeantViewer({ renderer: renderer(), bodies: ["sun"] });
    const initial = model(), late = model(), replacement = model(), disposedLate = model();
    const plugin = createGeantBodyAppearancePlugin({ body: celestialBody("sun"), appearance: () => initial });
    await viewer.install(plugin);
    let finish!: (appearance: BodyAppearance) => void, signal!: AbortSignal;
    const pending = plugin.setAppearance(context => { signal = context.signal; return new Promise(resolve => { finish = resolve; }); });
    const superseded = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await plugin.setAppearance(() => replacement); expect(signal.aborted).toBe(true);
    finish(late); await superseded; expect(late.dispose).toHaveBeenCalledOnce();
    expect(plugin.object3d.children).toEqual([replacement.object3d]);
    const disposedPending = plugin.setAppearance(context => { signal = context.signal; return new Promise(resolve => { finish = resolve; }); });
    const rejected = expect(disposedPending).rejects.toMatchObject({ name: "AbortError" });
    await viewer.dispose(); expect(signal.aborted).toBe(true); finish(disposedLate); await rejected;
    expect(disposedLate.dispose).toHaveBeenCalledOnce(); expect(disposedLate.object3d.parent).toBeNull();
  });

  it("removes a failed initial factory without leaving frame parts or roots", async () => {
    const viewer = await createGeantViewer({ renderer: renderer() });
    const plugin = createGeantBodyAppearancePlugin({ body: celestialBody("sun"), appearance() { throw new Error("initial source failed"); } });
    await expect(viewer.install(plugin)).rejects.toThrow("initial source failed");
    expect(viewer.viewer.getSnapshot().parts).toHaveLength(0); expect(plugin.object3d.parent).toBeNull();
    viewer.frame(0); await viewer.dispose();
  });

  it("cancels before attachment when the host aborts during the initial model update", async () => {
    const viewer = await createGeantViewer({ renderer: renderer() }), abort = new AbortController();
    const initial = model(), cancelled = model();
    const plugin = createGeantBodyAppearancePlugin({ body: celestialBody("sun"), signal: abort.signal, appearance: () => initial });
    await viewer.install(plugin);
    cancelled.update.mockImplementation(() => { abort.abort(); });
    await expect(plugin.setAppearance(() => cancelled)).rejects.toMatchObject({ name: "AbortError" });
    expect(initial.dispose).toHaveBeenCalledOnce(); expect(cancelled.dispose).toHaveBeenCalledOnce();
    expect(plugin.object3d.children).toHaveLength(0); expect(plugin.object3d.parent).toBeNull();
    await viewer.dispose(); expect(cancelled.dispose).toHaveBeenCalledOnce();
  });
});

describe("public procedural Sun", () => {
  function phases(root: THREE.Object3D) {
    const mesh = root.getObjectByName("solar-photosphere") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const uniforms = mesh.material.uniforms;
    return [...(uniforms.warpPhase!.value as THREE.Vector2).toArray(), ...(uniforms.drift!.value as THREE.Vector2).toArray(),
      uniforms.boilPhase!.value as number, uniforms.activityPhase!.value as number];
  }
  it("reproduces an absolute timestamp after seeking, pauses, reverses, and retains sub-second phase precision", async () => {
    vi.useFakeTimers(); vi.setSystemTime(atMs);
    const viewer = await createGeantViewer({ renderer: renderer(), bodies: ["sun"], time: new Date(atMs).toISOString(), timeRate: 0 });
    const sun = createGeantBodyAppearancePlugin({ body: celestialBody("sun"), appearance: createSunAppearance });
    await viewer.install(sun); viewer.frame(0); const original = phases(sun.object3d);
    vi.setSystemTime(atMs + 5000); viewer.frame(5); expect(phases(sun.object3d)).toEqual(original);
    viewer.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs: atMs + 16, rate: 0 }); viewer.frame(0);
    expect(phases(sun.object3d)).not.toEqual(original);
    viewer.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs, rate: 0 }); viewer.frame(0); expect(phases(sun.object3d)).toEqual(original);
    viewer.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs: atMs + 1000, rate: -1 });
    vi.setSystemTime(Date.now() + 1000); viewer.frame(1); expect(phases(sun.object3d)).toEqual(original);
    const mesh = sun.object3d.getObjectByName("solar-photosphere") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const geometry = vi.spyOn(mesh.geometry, "dispose"), material = vi.spyOn(mesh.material, "dispose");
    const texture = vi.spyOn(mesh.material.uniforms.granules!.value as THREE.Texture, "dispose");
    await viewer.dispose(); expect(geometry).toHaveBeenCalledOnce(); expect(material).toHaveBeenCalledOnce(); expect(texture).toHaveBeenCalledOnce();
  });

  it("permits explicit display-time motion while simulation is paused, with independent instance resources", async () => {
    const first = await createGeantViewer({ renderer: renderer(), timeRate: 0 }), second = await createGeantViewer({ renderer: renderer(), timeRate: 0 });
    const a = createGeantBodyAppearancePlugin({ body: celestialBody("sun"), appearance: context => createSunAppearance(context, { animationTime: "presentation" }) });
    const b = createGeantBodyAppearancePlugin({ body: celestialBody("sun"), appearance: createSunAppearance });
    await first.install(a); await second.install(b); const initial = phases(a.object3d), stationary = phases(b.object3d);
    first.frame(2); second.frame(2); expect(phases(a.object3d)).not.toEqual(initial); expect(phases(b.object3d)).toEqual(stationary);
    const texture = (root: THREE.Object3D) => (root.getObjectByName("solar-photosphere") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>).material.uniforms.granules!.value;
    expect(texture(a.object3d)).not.toBe(texture(b.object3d)); await first.dispose(); second.frame(1); await second.dispose();
  });
});
