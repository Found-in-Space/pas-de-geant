import { afterEach, describe, expect, it, vi } from "vitest";
import { ArrayCamera, Camera, Matrix4, Object3D, Quaternion, Vector2, Vector3, type WebGLRenderer } from "three";
import { createJourneySequencePlayer } from "@found-in-space/guided-journey/sequence";
import { createSequenceTouchControls } from "@found-in-space/guided-journey/touch-os";
import { createThreeUIEnvironment, type CanvasContextLike } from "@found-in-space/touch-os/hosts/three";
import type { DisplayRuntime, InteractionSource } from "@found-in-space/touch-os";
import { createGeantViewer, createGeantWorldsPlugin, createGeantMovementPlugin, createGeantSurfaceMovementModel,
  createGeantDesktopMovementModel, createGeantPanelPlugin, GEANT_ACTIONS, GEANT_MOTION_ACTIONS } from "@found-in-space/pas-de-geant";
import { createGeantJourneyNavigation, createGeantSequenceParticipant, createGeantTrackingSequence,
  createGeantSequencePlugin, evaluateGeantTrackingShot, geantBodyFixedSpace, type GeantTrackingShot, type GeantTrackingTarget } from "@found-in-space/pas-de-geant/journey";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } finally { vi.useRealTimers(); } });
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const radius = 1737400, epoch = Date.parse("2026-10-30T12:00:00Z");
const shot: GeantTrackingShot = { up: "radial", heading: { kind: "velocity", referenceForward: { x: 0, y: 0, z: -1 }, blendSpeedMPerSec: 10 },
  offset: { rightM: 200, upM: 300, behindM: 600 }, lookAheadSecs: .2, scaleDenominator: 100_000 };
const target = (t: number): GeantTrackingTarget => ({ body: "moon", space: geantBodyFixedSpace("moon"),
  position: { x: radius + 10000, y: 100 * t, z: -1000 * t }, velocityMPerSec: { x: 0, y: 100, z: -1000 } });
const sequence = createGeantTrackingSequence({ sequence: { durationSecs: 10, evaluate: target }, shot, worldTime: t => epoch + t * 60000 });

async function fixture(xr: boolean) {
  const head = new ArrayCamera(); head.position.set(.2, 1.7, -.1); head.rotation.set(.1, .3, .05);
  const reference = new EventTarget(), session = {};
  const manager = { isPresenting: xr, getCamera: () => head, getSession: () => session, getReferenceSpace: () => reference,
    getFrame: () => ({ getViewerPose: () => ({ transform: { position: head.position, orientation: head.quaternion } }) }),
    updateCamera(camera: Camera) {
      head.matrix.compose(head.position, head.quaternion, new Vector3(1, 1, 1));
      head.matrixWorld.multiplyMatrices(camera.parent!.matrixWorld, head.matrix); head.matrixWorldInverse.copy(head.matrixWorld).invert();
    } };
  const renderer = { xr: manager, render() {}, getDrawingBufferSize: (v: Vector2) => v.set(800, 600) } as unknown as WebGLRenderer;
  const host = await createGeantViewer({ renderer, bodies: ["moon"], mode: "surface", time: new Date(epoch).toISOString(), timeRate: 0,
    scaleDenominator: 1_000_000, location: { latitudeDegrees: 35, longitudeDegrees: -20, altitudeM: 0 } });
  host.camera.position.copy(head.position); host.camera.quaternion.copy(head.quaternion);
  await host.install(createGeantWorldsPlugin());
  const surface = createGeantSurfaceMovementModel(), desktop = createGeantDesktopMovementModel();
  const movement = createGeantMovementPlugin({ model: frame => frame.xr ? surface : desktop }); await host.install(movement);
  const browser = { ...host, movement }; host.frame(0);
  const navigation = createGeantJourneyNavigation(browser);
  const participant = createGeantSequenceParticipant({ browser, navigation, durationSecs: 1 });
  const player = createJourneySequencePlayer({ sequence, participant });
  const marker = new Object3D(); host.worlds.get("moon")!.object3d.add(marker);
  let presented = player.getSnapshot().frame;
  const remove = await host.install(createGeantSequencePlugin({ player, onFrame(frame) {
    presented = frame; marker.position.copy(frame.value.target.position).divideScalar(radius);
  } }));
  cleanups.push(async () => { await remove(); player.dispose(); participant.dispose(); navigation.dispose(); await host.dispose(); });
  function viewMatrix() {
    host.camera.updateWorldMatrix(true, false);
    return new Matrix4().multiplyMatrices((xr ? head : host.camera).matrixWorld.clone().invert(), host.worlds.get("moon")!.object3d.matrixWorld);
  }
  function expectSample() {
    const value = player.getSnapshot().frame.value, body = host.worlds.get("moon")!.object3d;
    const eye = xr ? head : host.camera;
    const position = new Vector3().setFromMatrixPosition(eye.matrixWorld).applyMatrix4(body.matrixWorld.clone().invert()).multiplyScalar(radius);
    expect(position.distanceTo(new Vector3().copy(value.camera.pose.position))).toBeLessThan(.002);
    const bodyRotation = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(body.matrixWorld));
    const orientation = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(eye.matrixWorld)).premultiply(bodyRotation.invert());
    expect(orientation.angleTo(new Quaternion().copy(value.camera.pose.orientation))).toBeLessThan(1e-6);
    expect(host.time.getSnapshot().atMs).toBe(value.atMs);
    const measured = host.worlds.get("moon")!.getView().observerHeightWorldM * value.camera.scaleDenominator;
    expect(Math.abs(measured - (position.length() - radius))).toBeLessThan(.002);
    expect(presented).toBe(player.getSnapshot().frame);
    marker.updateWorldMatrix(true, false);
    const actualMarkerInEye = new Vector3().setFromMatrixPosition(marker.matrixWorld).applyMatrix4(eye.matrixWorld.clone().invert());
    const expectedMarkerInEye = new Vector3().copy(value.target.position).sub(position)
      .applyQuaternion(orientation.clone().invert()).divideScalar(value.camera.scaleDenominator);
    expect(actualMarkerInEye.distanceTo(expectedMarkerInEye)).toBeLessThan(1e-7);
  }
  async function arrive() { host.frame(0); host.frame(1); host.frame(0); await flush(); host.frame(0); await flush(); }
  return { host, movement, navigation, participant, player, head, viewMatrix, expectSample, arrive, removeSequence: remove };
}
function sameView(actual: Matrix4, expected: Matrix4, tolerance = 1e-7) {
  expect(Math.max(...actual.elements.map((v, i) => Math.abs(v - expected.elements[i]!)))).toBeLessThan(tolerance);
}

describe.each([false, true])("planetary shared sequence, XR=%s", xr => {
  it("routes shared panel input into the actual participant and refreshes independent playback state until removal", async () => {
    const f = await fixture(xr), before = f.viewMatrix(), head = f.head.quaternion.clone();
    const controls = createSequenceTouchControls({ id: "shared", player: f.player });
    const ui = createThreeUIEnvironment({ parent: f.host.scene });
    let runtime: DisplayRuntime | undefined, subscriptions = 0;
    const context = new Proxy({ measureText: (text: string) => ({ width: text.length * 8 }) }, {
      get(object, key) { return key === "measureText" ? object.measureText : () => {}; }
    }) as unknown as CanvasContextLike;
    const remove = await f.host.install(createGeantPanelPlugin({ id: "shared", environment: ui,
      root: controls.render, surface: { width: 480, height: 640 }, initialize(value) { runtime = value; },
      action(output) { controls.handleOutput(output); return null; },
      subscribe(refresh) { subscriptions++; const unsubscribe = f.player.subscribe(refresh);
        return () => { subscriptions--; unsubscribe(); }; },
      placement: { createCanvas: metrics => ({ width: metrics.width, height: metrics.height, getContext: () => context }) },
    }));
    cleanups.push(async () => { await remove(); ui.dispose(); });
    let time = 0;
    function click(control: string) {
      runtime!.render(); const bounds = runtime!.getBounds(`shared:${control}`)!;
      const source: InteractionSource = { id: "right", space: "world-metres", tracked: true, pointerType: "controller",
        surface: { targetId: "shared", x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } };
      ui.update({ timestamp: ++time, sources: [source], edges: [{ phase: "begin", timestamp: time, source }] });
      ui.update({ timestamp: ++time, sources: [source], edges: [{ phase: "complete", timestamp: time, source }] });
    }
    ui.update({ timestamp: time });
    click("play"); f.host.frame(1); await flush();
    expect(f.player.getSnapshot()).toMatchObject({ ownership: "detached", frame: { timeSecs: 1 } });
    sameView(f.viewMatrix(), before);
    expect(runtime!.render().commands).toContainEqual(expect.objectContaining({ text: "1.0 / 10.0 seconds" }));
    click("play"); click("join"); f.host.frame(0); sameView(f.viewMatrix(), before);
    await f.arrive(); f.expectSample(); expect(f.head.quaternion.equals(head)).toBe(true);
    click("play"); f.host.frame(2); await flush(); f.expectSample();
    click("play"); expect(f.player.getSnapshot().ownership).toBe("attached");
    click("cancel"); expect(f.player.getSnapshot().ownership).toBe("detached");
    const held = f.viewMatrix(); f.host.frame(0); sameView(f.viewMatrix(), held);
    expect(subscriptions).toBe(1); await remove(); expect(subscriptions).toBe(0);
    f.player.seek(4); expect(f.player.getSnapshot().disposed).toBe(false);
  });

  it("joins from the rendered pose and applies body-fixed position/orientation without editing the tracked head", async () => {
    const f = await fixture(xr), before = f.viewMatrix(), head = f.head.quaternion.clone();
    const join = f.player.join(); f.host.frame(0); sameView(f.viewMatrix(), before);
    f.host.frame(1e-7); sameView(f.viewMatrix(), before, 1e-6);
    await f.arrive(); expect((await join.finished).status).toBe("completed");
    f.expectSample(); expect(f.head.quaternion.equals(head)).toBe(true);
    expect(f.player.getSnapshot()).toMatchObject({ status: "paused", ownership: "attached" });
  });

  it("separates arrival from playback end and measures camera/world at one seeked epoch", async () => {
    const f = await fixture(xr); const end = f.player.play(), join = f.player.join();
    let ended = false; void end.finished.then(() => { ended = true; });
    await f.arrive(); expect((await join.finished).status).toBe("completed"); expect(ended).toBe(false);
    f.host.frame(3); await flush(); expect(f.player.getSnapshot().frame.timeSecs).toBe(3); f.expectSample();
    f.player.pause(); f.host.frame(100); expect(f.player.getSnapshot().frame.timeSecs).toBe(3);
    f.player.seek(9); f.host.frame(0); await flush(); f.expectSample();
    expect(f.player.play()).toBe(end); f.host.frame(1); f.expectSample(); await flush();
    expect((await end.finished).status).toBe("completed");
    f.player.seek(3); f.host.frame(0); await flush(); f.expectSample();
  });

  it("gives manual movement the live view and explicitly rejoins the paused sample", async () => {
    const f = await fixture(xr); f.player.join(); await f.arrive();
    const end = f.player.play(); f.host.frame(2); await flush(); const before = f.viewMatrix();
    await f.host.context.movement!.command(GEANT_MOTION_ACTIONS.look, { yawRadians: .2, pitchRadians: 0 });
    f.host.frame(0); await flush(); expect((await end.finished).status).toBe("cancelled");
    expect(f.player.getSnapshot()).toMatchObject({ status: "paused", ownership: "detached", frame: { timeSecs: 2 } });
    const manual = f.viewMatrix(); expect(manual.equals(before)).toBe(false);
    f.player.seek(5); f.host.frame(0); sameView(f.viewMatrix(), manual);
    f.player.join(); f.host.frame(0); sameView(f.viewMatrix(), manual);
    await f.arrive(); f.expectSample();
  });

  it("preserves a newer navigation owner and explicit world-clock/mode edits", async () => {
    const f = await fixture(xr); f.player.join(); await f.arrive();
    expect(() => f.host.navigation.dispatch(GEANT_ACTIONS.setScale, { scaleDenominator: -1 })).toThrow();
    expect(f.player.getSnapshot().ownership).toBe("attached");
    const newer = f.navigation.transitionTo({ kind: "surface", body: "moon", latitudeDegrees: 20, longitudeDegrees: 30,
      altitudeM: 100000, altitudeReference: "reference", scaleDenominator: 1_000_000, durationSecs: 0 });
    f.host.frame(0); await flush(); expect((await newer.finished).status).toBe("completed");
    expect(f.player.getSnapshot().ownership).toBe("detached"); expect(f.navigation.getSnapshot().operation).toBe(newer);
    f.player.join(); await f.arrive();
    f.host.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs: epoch + 5000, rate: 2 });
    expect(f.player.getSnapshot().ownership).toBe("detached");
    expect(f.host.navigation.getClock().scale).toBe(2);
    f.player.join(); await f.arrive();
    await f.host.actions.invoke(GEANT_ACTIONS.setMode, { mode: "surface" });
    expect(f.host.navigation.mode).toBe("surface"); expect(f.player.getSnapshot().ownership).toBe("detached");
  });

  it("supersedes seek-during-join and releases a held shot on host disposal", async () => {
    const f = await fixture(xr); const old = f.player.join(); f.host.frame(0); f.host.frame(.4); f.host.frame(0);
    const before = f.viewMatrix(); f.player.seek(5); f.host.frame(0); await flush();
    expect((await old.finished).status).toBe("superseded"); sameView(f.viewMatrix(), before);
    f.player.join(); await f.arrive(); const end = f.player.play();
    await f.host.dispose(); expect((await end.finished).status).toBe("cancelled");
    expect(f.player.getSnapshot().ownership).toBe("detached");
  });

  it("releases on an external movement-model replacement without undoing the new owner", async () => {
    const f = await fixture(xr); f.player.join(); await f.arrive();
    const replacement = createGeantDesktopMovementModel();
    f.movement.setModel(replacement);
    expect(f.player.getSnapshot().ownership).toBe("detached");
    f.participant.dispose(); f.navigation.dispose();
    expect(f.movement.getModel()).toBe(replacement);
  });

  it("runs the same seeked samples backwards and restores clock rate without rewinding", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const f = await fixture(xr);
    f.host.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs: epoch, rate: 2 });
    f.player.seek(8); f.player.join(); await f.arrive();
    expect(f.host.navigation.getClock().scale).toBe(0);
    f.player.setRate(-2); f.player.play(); f.host.frame(2); await flush();
    expect(f.player.getSnapshot().frame.timeSecs).toBe(4); f.expectSample();
    const instant = f.host.time.getSnapshot().atMs;
    f.player.cancel(); expect(f.host.navigation.getSnapshot()).toMatchObject({ time: instant, timeRate: 2 });
  });
});

it("retains independent XR head rotation and room translation while holding the authored shot", async () => {
  const f = await fixture(true); f.player.join(); await f.arrive();
  const before = f.viewMatrix(), physicalEye = new Vector3().copy(f.host.context.presentation.observerJ2000M!);
  f.head.rotateY(.25); f.head.position.x += .1;
  const orientation = f.head.quaternion.clone(), position = f.head.position.clone();
  f.host.frame(0);
  expect(f.head.quaternion.equals(orientation)).toBe(true); expect(f.head.position.equals(position)).toBe(true);
  expect(f.viewMatrix().equals(before)).toBe(false);
  expect(new Vector3().copy(f.host.context.presentation.observerJ2000M!).distanceTo(physicalEye)).toBeCloseTo(.1 * shot.scaleDenominator, 2);
});

it("removes scheduling without disposing the borrowed player or leaving a stale frame callback", async () => {
  const f = await fixture(false); f.player.join(); await f.arrive(); f.player.play();
  await f.removeSequence(); f.host.frame(3);
  expect(f.player.getSnapshot()).toMatchObject({ disposed: false, frame: { timeSecs: 0 } });
  f.player.dispose(); expect(() => f.host.frame(0)).not.toThrow();
});

it("evaluates the same camera after arbitrary seeks and approaches the authored tangent at zero speed", () => {
  const sample = target(5), original = JSON.stringify(sample), camera = evaluateGeantTrackingShot(sample, shot);
  sequence.evaluate(10); sequence.evaluate(0); expect(sequence.evaluate(5).camera).toEqual(camera);
  const stationary = evaluateGeantTrackingShot({ ...sample, velocityMPerSec: { x: 0, y: 0, z: 0 } }, shot);
  const slow = evaluateGeantTrackingShot({ ...sample, velocityMPerSec: { x: 0, y: 1e-8, z: 1e-8 } }, shot);
  expect(new Vector3().copy(stationary.pose.position).distanceTo(new Vector3().copy(slow.pose.position))).toBeLessThan(1e-8);
  expect(new Quaternion().copy(stationary.pose.orientation).angleTo(new Quaternion().copy(slow.pose.orientation))).toBeLessThan(1e-6);
  expect(JSON.stringify(sample)).toBe(original);
  expect(() => evaluateGeantTrackingShot({ ...sample, space: { frameId: "icrs", metersPerUnit: 1 } }, shot)).toThrow(/spaces differ/);
  expect(() => evaluateGeantTrackingShot(sample, { ...shot, up: { x: 0, y: 0, z: -1 } })).toThrow(/tangent/);
});
