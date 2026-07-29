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
  CELESTIAL_SPHERE_RADIUS_M,
  CELESTIAL_TIME_STEP_MS,
  CelestialSphere,
  celestialToWorldQuaternion,
  createCelestialStarField,
} from "../apps/pas-de-geant/src/celestial-sphere.js";
import {
  contactFrame,
  earthToWorldQuaternion,
  initialPlanetState,
  rollContactFrame,
} from "../apps/pas-de-geant/src/planet-state.js";

describe("Pas de Géant SkyKit celestial sphere", () => {
  it("feeds fixed-radius stars into SkyKit's WebGL core and halo shader", () => {
    const field = createCelestialStarField([
      {
        positionPc: { x: 0, y: 0, z: 0 },
        apparentMagnitude: -30,
        temperatureK: 5_772,
      },
      {
        positionPc: { x: 2, y: 0, z: 0 },
        apparentMagnitude: 1,
        temperatureK: 10_000,
      },
      {
        positionPc: { x: 0, y: 30, z: 40 },
        apparentMagnitude: 5,
        temperatureK: 4_000,
      },
      {
        positionPc: { x: 1, y: 1, z: 1 },
        apparentMagnitude: 7,
        temperatureK: 6_000,
      },
    ]);

    expect(field.count).toBe(2);
    const points = field.object3d.children as THREE.Points[];
    expect(points).toHaveLength(2);
    expect(points.map((point) => point.name)).toEqual([
      "skykit-star-cores",
      "skykit-star-halos",
    ]);
    for (const pointSet of points) {
      const positions = pointSet.geometry.getAttribute("position");
      for (let index = 0; index < positions.count; index += 1) {
        expect(
          new THREE.Vector3(
            positions.getX(index),
            positions.getY(index),
            positions.getZ(index),
          ).length(),
        ).toBeCloseTo(CELESTIAL_SPHERE_RADIUS_M, 5);
      }
      const material = pointSet.material as THREE.ShaderMaterial;
      expect(material).toBeInstanceOf(THREE.ShaderMaterial);
      expect(material.depthTest).toBe(true);
      expect(material.depthWrite).toBe(false);
      expect(material.uniforms.uScale?.value).toBe(
        CELESTIAL_SPHERE_RADIUS_M,
      );
      expect(material.uniforms.uMagLimit?.value).toBe(6.5);
    }

    const geometry = points[0]!.geometry;
    expect(points[1]!.geometry).toBe(geometry);
    const temperatures = geometry.getAttribute("teff_log8");
    const magnitudes = geometry.getAttribute("magAbs");
    expect(temperatures.normalized).toBe(true);
    expect((temperatures.array as Uint8Array)[0]).toBe(128);
    expect(magnitudes.getX(0)).toBeCloseTo(6);
    expect(magnitudes.getX(1)).toBeCloseTo(10);

    const coreMaterial = points[0]!.material as THREE.ShaderMaterial;
    const haloMaterial = points[1]!.material as THREE.ShaderMaterial;
    expect(
      ((coreMaterial.uniforms.map?.value as THREE.Texture).image as {
        width: number;
      }).width,
    ).toBe(64);
    expect(
      ((haloMaterial.uniforms.map?.value as THREE.Texture).image as {
        width: number;
      }).width,
    ).toBe(128);

    field.dispose();
  });

  it("agrees with Astronomy Engine's J2000-to-local-horizon transform", () => {
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

    const directions: Array<[number, number, number]> = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [-0.31, 0.72, 0.62],
    ];
    for (const [x, y, z] of directions) {
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

  it("applies the full rolling-Earth delta without inheriting planet scale", () => {
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

  it("advances alignment on the live clock at a bounded update cadence", () => {
    const sphere = new CelestialSphere(async () => []);
    const earthToWorld = earthToWorldQuaternion(
      contactFrame(-33.8688, 151.2093),
    );
    const cameraPosition = new THREE.Vector3();
    const startMs = new Date("2026-08-12T17:45:46.794Z").getTime();

    sphere.update(earthToWorld, cameraPosition, startMs);
    const initial = sphere.object3d.quaternion.clone();
    sphere.update(
      earthToWorld,
      cameraPosition,
      startMs + CELESTIAL_TIME_STEP_MS - 1,
    );
    expect(1 - Math.abs(initial.dot(sphere.object3d.quaternion))).toBeLessThan(
      1e-15,
    );
    sphere.update(
      earthToWorld,
      cameraPosition,
      startMs + CELESTIAL_TIME_STEP_MS,
    );
    expect(1 - Math.abs(initial.dot(sphere.object3d.quaternion))).toBeGreaterThan(
      0,
    );
    sphere.dispose();
  });

  it("keeps catalog failures non-fatal and does not create fallback stars", async () => {
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
