import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  createGeantViewer, createGeantWorldsPlugin, createGeantMovementPlugin,
  createGeantSurfaceMovementModel, createGeantObservationMovementModel, createGeantShipMovementModel,
  GEANT_ACTIONS, GEANT_MOTION_ACTIONS, type GeantMovementModel, type GeantViewer,
} from "@found-in-space/pas-de-geant";
import { celestialBody, createBodySurfaceModel, type SolarSystemBodyId } from "@found-in-space/pas-de-geant/worlds";

const viewers: GeantViewer[] = [];
afterEach(async () => { for (const viewer of viewers.splice(0)) await viewer.dispose(); });
async function fixture(model: GeantMovementModel, options: { body?: SolarSystemBodyId; elevation?: number; scale?: number; altitude?: number; tracked?: boolean } = {}) {
  const head = new THREE.ArrayCamera(); head.position.set(0.3, 1.7, -0.2);
  const reference = new EventTarget(), session = {};
  let tracked = options.tracked ?? true;
  const xr = {
    isPresenting: true, getCamera: () => head, getSession: () => session, getReferenceSpace: () => reference,
    getFrame: () => ({ getViewerPose: () => tracked ? { transform: { position: head.position, orientation: head.quaternion } } : null }),
    updateCamera(camera: THREE.Camera) {
      head.matrix.compose(head.position, head.quaternion, new THREE.Vector3(1, 1, 1));
      head.matrixWorld.multiplyMatrices(camera.parent!.matrixWorld, head.matrix);
      head.matrixWorldInverse.copy(head.matrixWorld).invert();
    },
  };
  const viewer = await createGeantViewer({
    renderer: { xr, render() {}, getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600) } as unknown as THREE.WebGLRenderer,
    bodies: [options.body ?? "moon"], mode: "host:custom-label", time: "2026-10-17T12:00:00Z", timeRate: 0,
    location: { latitudeDegrees: 42, longitudeDegrees: 27, altitudeM: options.altitude ?? 0 }, scaleDenominator: options.scale ?? 50,
  });
  viewers.push(viewer);
  await viewer.install(createGeantWorldsPlugin());
  const movement = createGeantMovementPlugin({ model, surface: id => ({ body: celestialBody(id), geometry: createBodySurfaceModel(celestialBody(id)),
    sampleElevationMetres: () => options.elevation ?? 0 }) });
  const uninstall = await viewer.install(movement);
  const tick = () => viewer.update(0.1);
  tick();
  const command = async (action: string, payload: Record<string, unknown>) => {
    const result = await viewer.actions.invoke(action, payload);
    for (const item of result) if (item.status === "rejected") throw item.reason;
    tick();
  };
  function contact(elevation = 0) {
    const body = celestialBody(viewer.navigation.focusBody), geometry = createBodySurfaceModel(body);
    const location = viewer.getSnapshot().locations[body.id]!;
    const { position, normal } = geometry.positionAndNormal(location.latitudeDegrees, location.longitudeDegrees);
    const point = position.addScaledVector(normal, elevation / body.referenceRadiusM);
    const root = viewer.worlds.get(body.id)!.object3d; root.updateMatrixWorld(true);
    return { point: point.applyMatrix4(root.matrixWorld), normal: normal.applyQuaternion(root.quaternion) };
  }
  return { viewer, head, reference, xr, tick, command, contact, movement, uninstall, setTracked: (value: boolean) => { tracked = value; } };
}

describe("replaceable movement and world presentation", () => {
  it("uses a host model and label without a built-in mode", async () => {
    const enter = vi.fn(), leave = vi.fn(), command = vi.fn();
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
    const model: GeantMovementModel = { id: "lesson:conveyor", enter, leave, command,
      update: () => ({ originJ2000M: { x: 10, y: 20, z: 30 }, systemRotation: rotation, translation: new THREE.Vector3(2, 3, 4) }) };
    const f = await fixture(model);
    await f.command(GEANT_MOTION_ACTIONS.move, { right: 1, deltaSeconds: 1 });
    expect(command).toHaveBeenCalledOnce(); expect(enter).toHaveBeenCalledOnce();
    expect(f.viewer.context.presentation.translation.toArray()).toEqual([2, 3, 4]);
    expect(f.viewer.getSnapshot().mode).toBe("host:custom-label");
    await f.uninstall(); expect(leave).toHaveBeenCalledOnce(); expect(f.viewer.context.movement).toBeNull();
    const result = await f.viewer.actions.invoke(GEANT_MOTION_ACTIONS.move, {});
    expect(result[0]?.status).toBe("rejected");
  });
  it("can apply the same kind of model in two viewers and change one independently", async () => {
    const a = await fixture(createGeantObservationMovementModel()), b = await fixture(createGeantSurfaceMovementModel());
    const location = b.viewer.getSnapshot().locations;
    a.movement.setModel(createGeantShipMovementModel()); a.tick();
    expect(b.viewer.getSnapshot().locations).toEqual(location);
    expect(a.viewer.context.presentation.observerJ2000M).not.toBeNull();
    await expect(a.viewer.install(createGeantMovementPlugin({ model: createGeantSurfaceMovementModel() }))).rejects.toThrow(/already has/);
  });
  it("keeps world rendering independent when the host supplies no movement adapter", async () => {
    const viewer = await createGeantViewer({ renderer: { render() {}, xr: { isPresenting: false }, getDrawingBufferSize: (v: THREE.Vector2) => v.set(800, 600) } as unknown as THREE.WebGLRenderer });
    viewers.push(viewer); await viewer.install(createGeantWorldsPlugin());
    const camera = viewer.camera.quaternion.clone();
    viewer.navigation.dispatch(GEANT_ACTIONS.setMode, { mode: "my-own-metaphor" }); viewer.update(0);
    expect(viewer.camera.quaternion.equals(camera)).toBe(true); expect(viewer.context.movement).toBeNull();
  });
});

describe("surface movement", () => {
  it.each(["earth", "moon", "mars"] as const)("anchors the reference surface and physical altitude on %s", async body => {
    const f = await fixture(createGeantSurfaceMovementModel({ heightReference: "reference" }), { body, altitude: 100, elevation: 800 });
    const { point, normal } = f.contact();
    expect(point.x).toBeCloseTo(f.head.position.x, 8); expect(point.z).toBeCloseTo(f.head.position.z, 8);
    expect(point.y).toBeCloseTo(-2, 8); expect(normal.distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-10);
    await f.command(GEANT_MOTION_ACTIONS.altitude, { value: 1, deltaSeconds: 2 });
    expect(f.viewer.getSnapshot().locations[body]!.altitudeM).toBe(150);
    expect(f.viewer.getSnapshot().scaleDenominator).toBe(50);
    expect(f.contact().point.y).toBeCloseTo(-3, 8);
  });
  it("uses measured height and exaggeration separately from physical altitude", async () => {
    const f = await fixture(createGeantSurfaceMovementModel(), { elevation: 500, altitude: 100 });
    f.viewer.navigation.dispatch(GEANT_ACTIONS.setTerrainMultiplier, { multiplier: 3 }); f.tick();
    expect(f.contact(1500).point.y).toBeCloseTo(-2, 8);
    f.head.position.y = 1.1; f.tick();
    expect(f.contact(1500).point.y).toBeCloseTo(-2, 8);
  });
  it("transports a contact through walking but does not turn a snap rotation into walking", async () => {
    const f = await fixture(createGeantSurfaceMovementModel());
    const initial = f.viewer.getSnapshot().locations;
    f.head.position.x += 0.4; f.tick();
    expect(f.viewer.getSnapshot().locations).not.toEqual(initial);
    const walked = f.viewer.getSnapshot().locations, eye = f.head.position.clone();
    await f.command(GEANT_MOTION_ACTIONS.look, { yawRadians: Math.PI / 2 });
    expect(f.viewer.getSnapshot().locations).toEqual(walked);
    const transformedEye = f.head.position.clone().applyQuaternion(f.viewer.cameraRoot.quaternion).add(f.viewer.cameraRoot.position);
    expect(transformedEye.distanceTo(eye)).toBeLessThan(1e-10);
  });
  it("does not interpret reference-space resets or tracking recovery as travel", async () => {
    const f = await fixture(createGeantSurfaceMovementModel()); const initial = f.viewer.getSnapshot().locations;
    f.head.position.x += 2; f.reference.dispatchEvent(new Event("reset")); f.tick();
    expect(f.viewer.getSnapshot().locations).toEqual(initial);
    f.setTracked(false); f.tick(); f.head.position.x += 3; f.setTracked(true); f.tick();
    expect(f.viewer.getSnapshot().locations).toEqual(initial);
  });
});

describe("observation movement", () => {
  it("faces the initial eye with an upright tangent plane, then leaves the presentation fixed", async () => {
    const model = createGeantObservationMovementModel({ distanceRoomM: 2 });
    const f = await fixture(model);
    const anchor = model.getAnchor()!, location = f.viewer.getSnapshot().locations;
    const root = f.viewer.worlds.get("moon")!.object3d, position = root.position.clone(), orientation = root.quaternion.clone();
    expect(f.contact().point.distanceTo(anchor.position)).toBeLessThan(1e-8);
    expect(f.contact().normal.distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-10);
    expect(anchor.position.y).toBeCloseTo(1.7); expect(f.head.position.distanceTo(anchor.position)).toBeCloseTo(2);
    f.head.position.add(new THREE.Vector3(0.6, -0.4, -0.3)); f.head.rotation.set(0.4, 0.7, 0.2); f.tick();
    expect(root.position.distanceTo(position)).toBeLessThan(1e-10); expect(root.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    expect(f.viewer.getSnapshot().locations).toEqual(location);
    await f.command(GEANT_MOTION_ACTIONS.move, { right: 1, forward: 0.5, deltaSeconds: 0.4 });
    expect(f.viewer.getSnapshot().locations).not.toEqual(location);
    expect(f.contact().point.distanceTo(anchor.position)).toBeLessThan(1e-8);
  });
  it("adjusts observation height in room metres without changing physical altitude, scale or the camera", async () => {
    const model = createGeantObservationMovementModel(), f = await fixture(model, { altitude: 100 });
    const anchor = model.getAnchor()!, head = f.head.position.clone(), orientation = f.head.quaternion.clone(), state = f.viewer.getSnapshot();
    await f.command(GEANT_MOTION_ACTIONS.altitude, { value: 1, deltaSeconds: 2 });
    expect(model.getAnchor()!.position.y - anchor.position.y).toBeCloseTo(1);
    expect(f.viewer.getSnapshot()).toEqual(state); expect(f.head.position.equals(head)).toBe(true); expect(f.head.quaternion.equals(orientation)).toBe(true);
  });
  it("waits for a tracked eye pose before retaining the initial observation height", async () => {
    const model = createGeantObservationMovementModel(), f = await fixture(model, { tracked: false });
    f.head.position.y = 1.2; f.setTracked(true); f.tick();
    expect(model.getAnchor()!.position.y).toBeCloseTo(1.2);
    f.head.position.y = 1.8; f.tick();
    expect(model.getAnchor()!.position.y).toBeCloseTo(1.2);
  });
  it("accepts a host-defined plane pose and recentres only on an explicit command", async () => {
    const model = createGeantObservationMovementModel(), f = await fixture(model);
    const anchor = { position: new THREE.Vector3(1, 2, -3), orientation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3) };
    model.setAnchor(anchor); f.tick();
    expect(f.contact().point.distanceTo(anchor.position)).toBeLessThan(1e-8);
    expect(f.contact().normal.distanceTo(new THREE.Vector3(0, 0, 1).applyQuaternion(anchor.orientation))).toBeLessThan(1e-10);
    f.head.position.x += 1; await f.command(GEANT_MOTION_ACTIONS.recenter, {});
    expect(model.getAnchor()!.position.x).toBeCloseTo(f.head.position.x);
  });
});

describe("ship movement", () => {
  it("retains the physical eye position and viewing direction when leaving observation", async () => {
    const f = await fixture(createGeantObservationMovementModel());
    const physicalEye = new THREE.Vector3().copy(f.viewer.context.presentation.observerJ2000M!);
    const viewDirection = () => {
      const root = f.viewer.worlds.get("moon")!.object3d;
      const eye = new THREE.Vector3().setFromMatrixPosition(f.head.matrixWorld);
      const orientation = new THREE.Quaternion().setFromRotationMatrix(f.head.matrixWorld);
      return root.position.clone().sub(eye).applyQuaternion(orientation.invert()).normalize();
    };
    const before = viewDirection();
    f.movement.setModel(createGeantShipMovementModel()); f.tick();
    expect(new THREE.Vector3().copy(f.viewer.context.presentation.observerJ2000M!).distanceTo(physicalEye)).toBeLessThan(0.001);
    expect(viewDirection().distanceTo(before)).toBeLessThan(1e-6);
  });
  it("moves in the ship frame while looking and leaning remain independent", async () => {
    const f = await fixture(createGeantShipMovementModel({ speedRoomMPerSecond: 2 }));
    const start = new THREE.Vector3().copy(f.viewer.getSnapshot().observerJ2000M!);
    f.head.rotation.set(0.3, 1.2, 0.2); f.head.position.x += 0.5; f.tick();
    expect(f.viewer.getSnapshot().observerJ2000M).toEqual({ ...start });
    await f.command(GEANT_MOTION_ACTIONS.move, { forward: 1, deltaSeconds: 1 });
    const travelled = new THREE.Vector3().copy(f.viewer.getSnapshot().observerJ2000M!).sub(start);
    // Render forward -Z maps to physical J2000 +Y.
    expect(travelled.x).toBeCloseTo(0); expect(travelled.y).toBeCloseTo(100); expect(travelled.z).toBeCloseTo(0);
    const head = f.head.quaternion.clone();
    await f.command(GEANT_MOTION_ACTIONS.attitude, { yaw: 1, deltaSeconds: 1 });
    expect(f.head.quaternion.equals(head)).toBe(true); expect(f.viewer.cameraRoot.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.5);
  });
});
