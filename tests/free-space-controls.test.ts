import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  applyLocalRotation,
} from "../apps/visualizer/src/free-space-controls.js";

describe("free-space quaternion navigation", () => {
  it("crosses both camera poles without an orientation singularity", () => {
    const camera = new PerspectiveCamera();
    applyLocalRotation(camera, 0, Math.PI / 2);
    applyLocalRotation(camera, 0, Math.PI / 2);

    const forward = new Vector3(0, 0, -1)
      .applyQuaternion(camera.quaternion);
    expect(forward.x).toBeCloseTo(0, 10);
    expect(forward.y).toBeCloseTo(0, 10);
    expect(forward.z).toBeCloseTo(1, 10);
    expect(camera.quaternion.length()).toBeCloseTo(1, 12);
  });

  it("remains normalized through arbitrary accumulated rotations", () => {
    const camera = new PerspectiveCamera();
    for (let index = 0; index < 10_000; index += 1) {
      applyLocalRotation(camera, 0.013, -0.009, 0.007);
    }

    expect(camera.quaternion.length()).toBeCloseTo(1, 12);
    expect(
      [
        camera.quaternion.x,
        camera.quaternion.y,
        camera.quaternion.z,
        camera.quaternion.w,
      ].every(Number.isFinite),
    ).toBe(true);
  });
});
