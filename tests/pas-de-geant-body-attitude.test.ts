import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { bodyFixedToIcrsQuaternion, bodyFixedToRenderQuaternion } from
  "@found-in-space/worlds/body-attitude";
import {
  bodyRotation,
  SOLAR_SYSTEM_BODIES,
} from "@found-in-space/worlds/solar-system";

describe("rendered body attitude", () => {
  it("maps body-fixed north onto raw ICRS axes for Skykit", () => {
    const at = new Date("2026-08-23T12:00:00Z");
    for (const body of SOLAR_SYSTEM_BODIES) {
      const rotation = bodyRotation(body.id, at);
      const alpha = THREE.MathUtils.degToRad(rotation.poleRightAscensionDegrees);
      const delta = THREE.MathUtils.degToRad(rotation.poleDeclinationDegrees);
      const expectedPole = new THREE.Vector3(
        Math.cos(alpha) * Math.cos(delta),
        Math.sin(alpha) * Math.cos(delta),
        Math.sin(delta),
      );
      const north = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(bodyFixedToIcrsQuaternion(rotation));
      expect(north.distanceTo(expectedPole)).toBeLessThan(1e-10);
    }
  });

  it("maps body-fixed north onto the J2000 pole in render axes", () => {
    const rotation = bodyRotation("earth", new Date("2026-08-23T12:00:00Z"));
    const alpha = THREE.MathUtils.degToRad(rotation.poleRightAscensionDegrees);
    const delta = THREE.MathUtils.degToRad(rotation.poleDeclinationDegrees);
    const expectedPole = new THREE.Vector3(
      Math.cos(alpha) * Math.cos(delta),
      Math.sin(delta),
      -Math.sin(alpha) * Math.cos(delta),
    ).normalize();
    const renderedNorth = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(bodyFixedToRenderQuaternion(rotation));

    expect(renderedNorth.distanceTo(expectedPole)).toBeLessThan(1e-10);
  });

  it("produces a rigid right-handed body frame", () => {
    const attitude = bodyFixedToRenderQuaternion(
      bodyRotation("moon", new Date("2026-08-23T12:00:00Z")),
    );
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(attitude);
    const y = new THREE.Vector3(0, 1, 0).applyQuaternion(attitude);
    const z = new THREE.Vector3(0, 0, 1).applyQuaternion(attitude);

    expect(x.length()).toBeCloseTo(1, 12);
    expect(y.length()).toBeCloseTo(1, 12);
    expect(z.length()).toBeCloseTo(1, 12);
    expect(x.dot(y)).toBeCloseTo(0, 12);
    expect(x.clone().cross(y).distanceTo(z)).toBeLessThan(1e-10);
  });

  it("resolves a finite render attitude for every selectable body", () => {
    const at = new Date("2026-08-23T12:00:00Z");
    for (const body of SOLAR_SYSTEM_BODIES) {
      const attitude = bodyFixedToRenderQuaternion(bodyRotation(body.id, at));
      expect(attitude.toArray().every(Number.isFinite)).toBe(true);
      expect(attitude.length()).toBeCloseTo(1, 12);
    }
  });
});
