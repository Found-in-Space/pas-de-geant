import * as THREE from "three";
import { EARTH_MEAN_RADIUS_KM } from "@found-in-space/shadowline";
import { describe, expect, it } from "vitest";
import { ecefKmToDisplay } from "../apps/pas-de-geant/src/eclipse-rendering.js";
import {
  applyStageTransform,
  beginOneGrip,
  beginTwoGrip,
  presetFocus,
  presetStageTransform,
  updateOneGrip,
  updateTwoGrip,
  type EclipseStageFrame,
  type EclipseStageTransform,
  type GripPose,
} from "../apps/pas-de-geant/src/eclipse-stage.js";
import type { EclipseViewPreset } from "../apps/pas-de-geant/src/eclipse-types.js";

const frame: EclipseStageFrame = {
  moonPosition: new THREE.Vector3(59.8, 4, -2),
  shadowAxis: new THREE.Vector3(-1, 0, 0),
};

const expectedPresets: Record<
  EclipseViewPreset,
  { scale: number; anchor: THREE.Vector3; focusFraction: number }
> = {
  system: {
    scale: 0.09,
    anchor: new THREE.Vector3(0, 1.35, -5.8),
    focusFraction: 0.5,
  },
  earth: {
    scale: 0.75,
    anchor: new THREE.Vector3(0, 1.35, -3),
    focusFraction: 0,
  },
  moon: {
    scale: 2.4,
    anchor: new THREE.Vector3(0, 1.35, -3),
    focusFraction: 1,
  },
  shadow: {
    scale: 0.2,
    anchor: new THREE.Vector3(0, 1.35, -3.5),
    focusFraction: 0.58,
  },
};

function matrixFor(transform: EclipseStageTransform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    transform.position,
    transform.quaternion,
    new THREE.Vector3().setScalar(transform.metresPerEarthRadius),
  );
}

function grip(
  position: THREE.Vector3,
  quaternion = new THREE.Quaternion(),
): GripPose {
  return { position, quaternion };
}

describe("Eclipse observatory stage transforms", () => {
  it("uses Earth-radius coordinates and puts every preset focus at its room anchor", () => {
    expect(
      ecefKmToDisplay({ x: EARTH_MEAN_RADIUS_KM, y: 0, z: 0 }).length(),
    ).toBeCloseTo(1, 12);

    for (const preset of Object.keys(expectedPresets) as EclipseViewPreset[]) {
      const expected = expectedPresets[preset];
      const focus = presetFocus(preset, frame);
      expect(focus.distanceTo(
        frame.moonPosition.clone().multiplyScalar(expected.focusFraction),
      )).toBeLessThan(1e-12);
      const transform = presetStageTransform(preset, frame);
      expect(transform.metresPerEarthRadius).toBe(expected.scale);
      expect(focus.applyMatrix4(matrixFor(transform)).distanceTo(expected.anchor))
        .toBeLessThan(1e-12);
    }
  });

  it("applies a one-grip rigid delta to the complete stage", () => {
    const start: EclipseStageTransform = {
      position: new THREE.Vector3(1, 1.2, -3),
      quaternion: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        0.25,
      ),
      metresPerEarthRadius: 0.4,
    };
    const controllerStart = grip(new THREE.Vector3(0.3, 1.1, -0.4));
    const controllerEnd = grip(
      new THREE.Vector3(-0.2, 1.5, -0.7),
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        -0.5,
      ),
    );
    const localPoint = new THREE.Vector3(2, -1, 0.5);
    const gesture = beginOneGrip(controllerStart, start);
    const result = updateOneGrip(gesture, controllerEnd);
    const controllerDelta = new THREE.Matrix4()
      .compose(
        controllerEnd.position,
        controllerEnd.quaternion,
        new THREE.Vector3(1, 1, 1),
      )
      .multiply(
        new THREE.Matrix4().compose(
          controllerStart.position,
          controllerStart.quaternion,
          new THREE.Vector3(1, 1, 1),
        ).invert(),
      );
    const expectedWorldPoint = localPoint
      .clone()
      .applyMatrix4(matrixFor(start))
      .applyMatrix4(controllerDelta);

    expect(localPoint.applyMatrix4(matrixFor(result)).distanceTo(expectedWorldPoint))
      .toBeLessThan(1e-10);
    expect(result.metresPerEarthRadius).toBeCloseTo(start.metresPerEarthRadius);
  });

  it("preserves the grabbed midpoint through two-grip rotation and scaling", () => {
    const start: EclipseStageTransform = {
      position: new THREE.Vector3(0.5, 1, -2.5),
      quaternion: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        0.2,
      ),
      metresPerEarthRadius: 0.3,
    };
    const firstStart = grip(new THREE.Vector3(-0.4, 1.2, -0.6));
    const secondStart = grip(new THREE.Vector3(0.4, 1.2, -0.6));
    const startMidpoint = firstStart.position.clone().add(secondStart.position)
      .multiplyScalar(0.5);
    const localGrabPivot = startMidpoint.clone().applyMatrix4(
      matrixFor(start).invert(),
    );
    const firstEnd = grip(new THREE.Vector3(0.1, 1.0, -0.8));
    const secondEnd = grip(new THREE.Vector3(0.1, 2.6, -0.8));
    const endMidpoint = firstEnd.position.clone().add(secondEnd.position)
      .multiplyScalar(0.5);
    const gesture = beginTwoGrip(firstStart, secondStart, start);
    expect(gesture).not.toBeNull();
    const result = updateTwoGrip(gesture!, firstEnd, secondEnd);

    expect(localGrabPivot.applyMatrix4(matrixFor(result)).distanceTo(endMidpoint))
      .toBeLessThan(1e-10);
    expect(result.metresPerEarthRadius).toBeCloseTo(0.6);
  });

  it("scales only the model root and leaves the XR camera transform untouched", () => {
    const scene = new THREE.Scene();
    const stage = new THREE.Group();
    const xrCamera = new THREE.PerspectiveCamera();
    xrCamera.position.set(0, 1.65, 0);
    scene.add(stage, xrCamera);
    applyStageTransform(stage, presetStageTransform("moon", frame));

    expect(stage.scale.toArray()).toEqual([2.4, 2.4, 2.4]);
    expect(xrCamera.position.toArray()).toEqual([0, 1.65, 0]);
    expect(xrCamera.scale.toArray()).toEqual([1, 1, 1]);
  });
});
