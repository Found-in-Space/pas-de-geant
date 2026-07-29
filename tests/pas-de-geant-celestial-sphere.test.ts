import {
  MakeTime,
  Observer,
  RotateVector,
  Rotation_EQJ_HOR,
  Vector,
} from "astronomy-engine";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  CelestialSphere,
  celestialToWorldQuaternion,
} from "../apps/pas-de-geant/src/celestial-sphere.js";
import {
  contactFrame,
  earthToWorldQuaternion,
  initialPlanetState,
  rollContactFrame,
} from "../apps/pas-de-geant/src/planet-state.js";

describe("Pas de Géant celestial-sphere regressions", () => {
  it("agrees with Astronomy Engine's J2000-to-horizon transform", () => {
    const at = new Date("2026-08-12T17:45:46.794Z");
    const latitude = 40;
    const longitude = -4;
    const earthToWorld = earthToWorldQuaternion(
      contactFrame(latitude, longitude),
    );
    const celestialToWorld = celestialToWorldQuaternion(earthToWorld, at);
    const expectedRotation = Rotation_EQJ_HOR(
      at,
      new Observer(latitude, longitude, 0),
    );

    for (const [x, y, z] of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [-0.31, 0.72, 0.62],
    ] satisfies Array<[number, number, number]>) {
      const actual = new THREE.Vector3(x, y, z)
        .normalize()
        .applyQuaternion(celestialToWorld);
      const expectedHorizontal = RotateVector(
        expectedRotation,
        new Vector(x, y, z, MakeTime(at)),
      );
      const expectedWorld = new THREE.Vector3(
        -expectedHorizontal.y,
        expectedHorizontal.z,
        -expectedHorizontal.x,
      ).normalize();
      expect(actual.distanceTo(expectedWorld)).toBeLessThan(1e-10);
    }
  });

  it("follows the full rolling-Earth rotation without inheriting planet scale", () => {
    const at = new Date("2026-08-12T17:45:46.794Z");
    const state = initialPlanetState();
    const beforeEarth = earthToWorldQuaternion(state.contact);
    const beforeSky = celestialToWorldQuaternion(beforeEarth, at);
    state.contact = rollContactFrame(
      state.contact,
      new THREE.Vector2(9.5, -4.2),
      state.displayRadiusM,
    );
    state.contact = rollContactFrame(
      state.contact,
      new THREE.Vector2(-3.1, -7.8),
      state.displayRadiusM,
    );
    const afterEarth = earthToWorldQuaternion(state.contact);
    const afterSky = celestialToWorldQuaternion(afterEarth, at);

    const beforeRelative = beforeEarth.clone().invert().multiply(beforeSky);
    const afterRelative = afterEarth.clone().invert().multiply(afterSky);
    expect(1 - Math.abs(beforeRelative.dot(afterRelative))).toBeLessThan(1e-12);

    const sphere = new CelestialSphere(async () => []);
    const cameraPosition = new THREE.Vector3(2.5, 1.7, -4.1);
    sphere.object3d.scale.setScalar(37);
    sphere.update(afterEarth, cameraPosition, at.getTime());
    expect(sphere.object3d.position.distanceTo(cameraPosition)).toBe(0);
    expect(sphere.object3d.scale.toArray()).toEqual([1, 1, 1]);
    expect(
      1 - Math.abs(sphere.object3d.quaternion.dot(afterSky)),
    ).toBeLessThan(1e-12);
    sphere.dispose();
  });

  it("keeps the Earth operational when the star catalogue is unavailable", async () => {
    const failure = new Error("catalog offline");
    const sphere = new CelestialSphere(async () => {
      throw failure;
    });

    await expect(sphere.load()).resolves.toEqual({
      status: "unavailable",
      count: 0,
      error: failure,
    });
    expect(sphere.object3d.children).toHaveLength(0);
    sphere.dispose();
  });
});
