import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createGuidedJourneyController } from "@found-in-space/guided-journey";
import { exerciseJourneyDriver, exerciseJourneyInterruption } from "@found-in-space/guided-journey/testing";
import { createGeantViewer, createGeantWorldsPlugin, createGeantMovementPlugin, createGeantSurfaceMovementModel, createGeantDesktopMovementModel, GEANT_ACTIONS, GEANT_MOTION_ACTIONS } from "@found-in-space/pas-de-geant";
import { createGeantJourneyDriver, type GeantJourneyHost, type GeantJourneyScene } from "@found-in-space/pas-de-geant/journey";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); } finally { vi.useRealTimers(); } });
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const camera = (latitudeDegrees: number, longitudeDegrees: number): GeantJourneyScene => ({
  camera: { kind: "surface", body: "earth", latitudeDegrees, longitudeDegrees, altitudeM: 2_000_000,
    altitudeReference: "reference", scaleDenominator: 3_000_000 }, readiness: "none",
});

async function fixture(xr: boolean) {
  const head = new THREE.ArrayCamera(); head.position.set(.2, 1.7, -.1); head.rotation.set(.1, .3, .05);
  const reference = new EventTarget(), session = {};
  const manager = { isPresenting: xr, getCamera: () => head, getSession: () => session, getReferenceSpace: () => reference,
    getFrame: () => ({ getViewerPose: () => ({ transform: { position: head.position, orientation: head.quaternion } }) }),
    updateCamera(camera: THREE.Camera) {
      head.matrix.compose(head.position, head.quaternion, new THREE.Vector3(1, 1, 1));
      head.matrixWorld.multiplyMatrices(camera.parent!.matrixWorld, head.matrix);
      head.matrixWorldInverse.copy(head.matrixWorld).invert();
    },
  };
  const renderer = { xr: manager, render() {}, getDrawingBufferSize: (v: THREE.Vector2) => v.set(800, 600) } as unknown as THREE.WebGLRenderer;
  const host = await createGeantViewer({ renderer, bodies: ["earth"], mode: "surface", time: "2026-10-30T12:00:00Z", timeRate: 0,
    scaleDenominator: 5_000_000, location: { latitudeDegrees: 35, longitudeDegrees: -20, altitudeM: 0 } });
  host.camera.position.copy(head.position); host.camera.quaternion.copy(head.quaternion);
  await host.install(createGeantWorldsPlugin());
  const surface = createGeantSurfaceMovementModel(), desktop = createGeantDesktopMovementModel();
  const movement = createGeantMovementPlugin({ model: frame => frame.xr ? surface : desktop });
  await host.install(movement);
  const browser: GeantJourneyHost = { ...host, movement };
  host.frame(0);
  const driver = createGeantJourneyDriver({ browser });
  const journey = createGuidedJourneyController({ driver, definition: { id: "earth", transition: { durationSecs: 1 }, chapters: [
    { id: "a", scene: camera(28, 86) }, { id: "b", scene: camera(-24, -69) },
  ] } });
  cleanups.push(async () => { await journey.dispose(); driver.dispose(); await host.dispose(); });
  const viewMatrix = () => {
    host.camera.updateWorldMatrix(true, false);
    const eye = xr ? head : host.camera;
    return new THREE.Matrix4().multiplyMatrices(eye.matrixWorld.clone().invert(), host.worlds.get("earth")!.object3d.matrixWorld);
  };
  return { host, driver, journey, head, viewMatrix };
}
function expectMatrix(actual: THREE.Matrix4, expected: THREE.Matrix4, tolerance = 1e-7) {
  expect(Math.max(...actual.elements.map((value, index) => Math.abs(value - expected.elements[index]!)))).toBeLessThan(tolerance);
}
async function arrive(f: Awaited<ReturnType<typeof fixture>>) {
  await flush(); f.host.frame(0); f.host.frame(1); f.host.frame(0); await flush();
}

describe.each([false, true])("shared Earth journey, XR=%s", xr => {
  it.each(["motion", "navigation"])("%s input cancels preparation and an arrived chapter", async input => {
    const f = await fixture(xr);
    await exerciseJourneyInterruption({ driver: f.driver, scene: camera(28, 86),
      async interrupt() {
        if (input === "motion") await f.host.viewer.actions.invoke(GEANT_MOTION_ACTIONS.look, { yawRadians: .1 });
        else f.host.navigation.dispatch(GEANT_ACTIONS.setScale, { scaleDenominator: 4_000_000 });
      },
      async advance() { await flush(); f.host.frame(0); f.host.frame(.2); f.host.frame(0); await flush(); },
    });
  });
  it("passes the same conformance fixture as the stellar viewer", async () => {
    const f = await fixture(xr);
    await exerciseJourneyDriver({ driver: f.driver, scenes: [camera(28, 86), camera(-24, -69), camera(46, 10)],
      async advance() { await flush(); f.host.frame(0); f.host.frame(.2); f.host.frame(0); await flush(); },
    });
  });
  it("enters from the rendered pose, reaches the geographic destination, and settles after placement", async () => {
    const f = await fixture(xr), before = f.viewMatrix(), head = f.head.quaternion.clone();
    const operation = f.journey.start(); await flush(); f.host.frame(0);
    expectMatrix(f.viewMatrix(), before);
    f.host.frame(1e-7); expectMatrix(f.viewMatrix(), before, 1e-6);
    f.host.frame(.5); f.host.frame(.5); await flush();
    expect(f.journey.getSnapshot().arrivedChapterId).toBeNull();
    f.host.frame(0); await flush();
    expect((await operation.finished).status).toBe("completed");
    const observed = f.host.worlds.get("earth")!.getView();
    expect(observed.latitudeDegrees).toBeCloseTo(28, 6);
    expect(observed.longitudeDegrees).toBeCloseTo(86, 6);
    expect(f.head.quaternion.equals(head)).toBe(true);
  });

  it("cancels without a visual reset and supersedes interrupted movement", async () => {
    const f = await fixture(xr);
    const first = f.journey.start(); await flush(); f.host.frame(0); f.host.frame(.4); f.host.frame(0);
    const before = f.viewMatrix();
    f.journey.cancel(); f.host.frame(0); await flush();
    expect((await first.finished).status).toBe("cancelled");
    expectMatrix(f.viewMatrix(), before);
    const second = f.journey.goTo("b"); await flush(); f.host.frame(0); f.host.frame(.25); f.host.frame(0);
    const interrupted = f.viewMatrix();
    const third = f.journey.goTo("a"); await flush(); f.host.frame(0);
    expect((await second.finished).status).toBe("superseded");
    expectMatrix(f.viewMatrix(), interrupted);
    await arrive(f); expect((await third.finished).status).toBe("completed");
  });

  it("uses the same invalid-ID, order, revisit and cleanup outcomes as the stellar controller", async () => {
    const f = await fixture(xr);
    expect((await f.journey.goTo("missing").finished).status).toBe("failed");
    f.journey.start(); await arrive(f);
    expect((await f.journey.previous().finished).status).toBe("completed");
    f.journey.next(); await arrive(f);
    f.journey.goTo("a"); await arrive(f);
    expect(f.journey.getSnapshot().history).toEqual(["a", "b", "a"]);
  });

  it("hands manual input the live pose and rejoins from the resulting view", async () => {
    const f = await fixture(xr);
    const first = f.journey.start(); await flush(); f.host.frame(0); f.host.frame(.4); f.host.frame(0);
    const before = f.viewMatrix();
    await f.host.context.movement!.command(GEANT_MOTION_ACTIONS.look, { yawRadians: .2, pitchRadians: 0 });
    f.host.frame(0); await flush();
    expect((await first.finished).status).toBe("cancelled");
    const manual = f.viewMatrix();
    expect(manual.equals(before)).toBe(false);
    f.journey.goTo("b"); await flush(); f.host.frame(0);
    expectMatrix(f.viewMatrix(), manual);
    await arrive(f);
    expect(f.journey.getSnapshot().arrivedChapterId).toBe("b");
  });

  it("releases the chapter clock rate without rewinding time or overwriting a subsequent edit", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = await fixture(xr);
    const timed = createGuidedJourneyController({ driver: f.driver, definition: { id: "time", transition: { durationSecs: 1 },
      chapters: [{ id: "night", scene: { ...camera(10, 95), time: { atMs: 20_000, rate: 600 } } }],
    } });
    cleanups.push(() => timed.dispose());
    timed.start(); await arrive(f);
    expect(f.host.navigation.getSnapshot().time).toBe(20_000);
    vi.advanceTimersByTime(2_000);
    const instant = f.host.navigation.getSnapshot().time;
    timed.cancel(); await flush();
    expect(f.host.navigation.getSnapshot()).toMatchObject({ time: instant, timeRate: 0 });
    timed.start(); await arrive(f);
    f.host.navigation.dispatch(GEANT_ACTIONS.setTime, { atMs: 55_000, rate: 2 });
    timed.cancel(); await flush();
    expect(f.host.navigation.getSnapshot()).toMatchObject({ time: 55_000, timeRate: 2 });
  });
});
