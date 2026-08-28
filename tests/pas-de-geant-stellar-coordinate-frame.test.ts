import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  j2000ToWorldQuaternion,
  j2000VectorToRenderAxes,
  trackingRoomOffsetWorld,
} from "../apps/pas-de-geant/src/stellar-coordinate-frame.js";

describe("stellar J2000 coordinate frame", () => {
  it("uses the same x,z,-y mapping as Solar System body placement", () => {
    expect(j2000VectorToRenderAxes(new THREE.Vector3(1, 0, 0)).toArray())
      .toEqual([1, 0, 0]);
    const y = j2000VectorToRenderAxes(new THREE.Vector3(0, 1, 0));
    const z = j2000VectorToRenderAxes(new THREE.Vector3(0, 0, 1));
    expect(y.x).toBeCloseTo(0, 12);
    expect(y.y).toBeCloseTo(0, 12);
    expect(y.z).toBeCloseTo(-1, 12);
    expect(z.x).toBeCloseTo(0, 12);
    expect(z.y).toBeCloseTo(1, 12);
    expect(z.z).toBeCloseTo(0, 12);
  });

  it("combines the fixed axes with the authored world orientation and inverts", () => {
    const systemToWorld = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 3,
    );
    const j2000ToWorld = j2000ToWorldQuaternion(systemToWorld);
    const raw = new THREE.Vector3(0.3, -0.4, 0.5);
    const expected = j2000VectorToRenderAxes(raw).applyQuaternion(systemToWorld);
    const world = raw.clone().applyQuaternion(j2000ToWorld);
    expect(world.distanceTo(expected)).toBeLessThan(1e-12);
    expect(world.clone().applyQuaternion(j2000ToWorld.clone().invert())
      .distanceTo(raw)).toBeLessThan(1e-12);
  });

  it("extracts only local room motion and rotates it with the observer rig", () => {
    const rigRotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    const offset = trackingRoomOffsetWorld(
      new THREE.Vector3(1.2, 1.6, -0.4),
      new THREE.Vector3(1, 1.6, -0.1),
      rigRotation,
    );
    const expected = new THREE.Vector3(0.2, 0, -0.3)
      .applyQuaternion(rigRotation);
    expect(offset.distanceTo(expected)).toBeLessThan(1e-12);
  });

  it("places the heliocentric Sun on the captured world gaze at the endpoint", () => {
    const systemToWorld = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.2, -0.7, 0.1),
    );
    const frame = j2000ToWorldQuaternion(systemToWorld);
    const capturedGazeWorld = new THREE.Vector3(0.2, 0.1, -1).normalize();
    const capturedGazeJ2000 = capturedGazeWorld.clone()
      .applyQuaternion(frame.clone().invert());
    const finalObserverJ2000 = capturedGazeJ2000.clone().multiplyScalar(-10);
    const sunDirectionWorld = finalObserverJ2000.clone().negate().normalize()
      .applyQuaternion(frame);
    expect(sunDirectionWorld.distanceTo(capturedGazeWorld)).toBeLessThan(1e-12);
  });
});
