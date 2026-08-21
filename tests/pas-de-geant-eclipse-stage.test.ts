import * as THREE from "three";
import { EARTH_MEAN_RADIUS_KM } from "@found-in-space/shadowline";
import { describe, expect, it } from "vitest";
import {
  beginObserverOneGrip,
  beginObserverTwoGrip,
  observerPositionForView,
  updateObserverOneGrip,
  updateObserverTwoGrip,
  type EclipseObserverTransform,
} from "../apps/pas-de-geant/src/eclipse-observer.js";
import { ecefKmToDisplay } from "../apps/pas-de-geant/src/eclipse-rendering.js";
import {
  presetFocus,
  presetMetresPerEarthRadius,
  presetViewDistance,
  type EclipseStageFrame,
  type GripPose,
} from "../apps/pas-de-geant/src/eclipse-stage.js";
import type { EclipseViewPreset } from "../apps/pas-de-geant/src/eclipse-types.js";

const frame: EclipseStageFrame = {
  moonPosition: new THREE.Vector3(59.8, 4, -2),
  shadowAxis: new THREE.Vector3(-1, 0, 0),
};

const expectedPresets: Record<
  EclipseViewPreset,
  { scale: number; distance: number; focusFraction: number }
> = {
  system: { scale: 0.09, distance: 5.8, focusFraction: 0.5 },
  earth: { scale: 0.75, distance: 3, focusFraction: 0 },
  moon: { scale: 2.4, distance: 3, focusFraction: 1 },
  shadow: { scale: 0.2, distance: 3.5, focusFraction: 0.58 },
};

function grip(
  position: THREE.Vector3,
  quaternion = new THREE.Quaternion(),
): GripPose {
  return { position, quaternion };
}

function rigidMatrix(transform: EclipseObserverTransform): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    transform.position,
    transform.quaternion,
    new THREE.Vector3(1, 1, 1),
  );
}

function poseMatrix(pose: GripPose): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    pose.position,
    pose.quaternion,
    new THREE.Vector3(1, 1, 1),
  );
}

describe("Eclipse observatory system and observer transforms", () => {
  it("keeps one Earth-radius coordinate system while presets place the observer", () => {
    expect(
      ecefKmToDisplay({ x: EARTH_MEAN_RADIUS_KM, y: 0, z: 0 }).length(),
    ).toBeCloseTo(1, 12);
    for (const preset of Object.keys(expectedPresets) as EclipseViewPreset[]) {
      const expected = expectedPresets[preset];
      expect(presetMetresPerEarthRadius(preset)).toBe(expected.scale);
      expect(presetViewDistance(preset)).toBe(expected.distance);
      expect(presetFocus(preset, frame).distanceTo(
        frame.moonPosition.clone().multiplyScalar(expected.focusFraction),
      )).toBeLessThan(1e-12);
    }
  });

  it("places the tracked head at the requested distance along its live gaze", () => {
    const focus = new THREE.Vector3(3, -1, 5);
    const trackedPosition = new THREE.Vector3(0.1, 1.65, -0.2);
    const trackedQuaternion = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      0.35,
    );
    const observerQuaternion = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      -0.2,
    );
    const observerPosition = observerPositionForView(
      focus,
      4.2,
      trackedPosition,
      trackedQuaternion,
      observerQuaternion,
    );
    const worldHead = trackedPosition.clone()
      .applyQuaternion(observerQuaternion)
      .add(observerPosition);
    const worldForward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(trackedQuaternion)
      .applyQuaternion(observerQuaternion)
      .normalize();

    expect(focus.clone().sub(worldHead).distanceTo(
      worldForward.multiplyScalar(4.2),
    )).toBeLessThan(1e-10);
  });

  it("moves the observer inversely so a one-grip point stays fixed in space", () => {
    const observerStart: EclipseObserverTransform = {
      position: new THREE.Vector3(1, 0.5, -2),
      quaternion: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        0.3,
      ),
    };
    const gripStart = grip(new THREE.Vector3(0.2, 1.1, -0.5));
    const gripCurrent = grip(
      new THREE.Vector3(-0.4, 1.4, -0.8),
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        0.4,
      ),
    );
    const gesture = beginObserverOneGrip(gripStart, observerStart);
    const observerCurrent = updateObserverOneGrip(gesture, gripCurrent);
    const grabbedWorldStart = rigidMatrix(observerStart).multiply(
      poseMatrix(gripStart),
    );
    const grabbedWorldCurrent = rigidMatrix(observerCurrent).multiply(
      poseMatrix(gripCurrent),
    );

    for (let index = 0; index < 16; index += 1) {
      expect(grabbedWorldCurrent.elements[index]).toBeCloseTo(
        grabbedWorldStart.elements[index]!,
        10,
      );
    }
  });

  it("uses two grips to reorient the observer without scaling the headset", () => {
    const observerStart: EclipseObserverTransform = {
      position: new THREE.Vector3(0.4, -0.2, 1),
      quaternion: new THREE.Quaternion(),
    };
    const firstStart = grip(new THREE.Vector3(-0.4, 1.2, -0.6));
    const secondStart = grip(new THREE.Vector3(0.4, 1.2, -0.6));
    const firstCurrent = grip(new THREE.Vector3(0.2, 0.7, -0.9));
    const secondCurrent = grip(new THREE.Vector3(0.2, 2.3, -0.9));
    const gesture = beginObserverTwoGrip(firstStart, secondStart, observerStart);
    expect(gesture).not.toBeNull();
    const observerCurrent = updateObserverTwoGrip(
      gesture!,
      firstCurrent,
      secondCurrent,
    );
    const startMidpoint = firstStart.position.clone().add(secondStart.position)
      .multiplyScalar(0.5)
      .applyMatrix4(rigidMatrix(observerStart));
    const currentMidpoint = firstCurrent.position.clone().add(secondCurrent.position)
      .multiplyScalar(0.5)
      .applyMatrix4(rigidMatrix(observerCurrent));
    const startDirection = secondStart.position.clone().sub(firstStart.position)
      .transformDirection(rigidMatrix(observerStart));
    const currentDirection = secondCurrent.position.clone().sub(firstCurrent.position)
      .transformDirection(rigidMatrix(observerCurrent));
    const observerRig = new THREE.Group();
    const xrCamera = new THREE.PerspectiveCamera();
    observerRig.add(xrCamera);
    observerRig.position.copy(observerCurrent.position);
    observerRig.quaternion.copy(observerCurrent.quaternion);

    expect(currentMidpoint.distanceTo(startMidpoint)).toBeLessThan(1e-10);
    expect(currentDirection.angleTo(startDirection)).toBeLessThan(1e-10);
    expect(observerRig.scale.toArray()).toEqual([1, 1, 1]);
    expect(xrCamera.scale.toArray()).toEqual([1, 1, 1]);
  });
});
