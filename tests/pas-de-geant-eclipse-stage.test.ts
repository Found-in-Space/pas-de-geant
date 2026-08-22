import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  geodeticToEcef,
} from "@found-in-space/shadowline";
import { describe, expect, it } from "vitest";
import {
  eclipseEarthSurfaceObservation,
  trackedHeadWorldPosition,
  trackedHeadWorldQuaternion,
} from "../apps/pas-de-geant/src/eclipse-earth-surface.js";
import { earthTextureUv } from "../apps/pas-de-geant/src/earth-texture-projection.js";
import {
  beginObserverOneGrip,
  beginObserverTwoGrip,
  observerPositionForView,
  updateObserverHeadRelativeFlight,
  updateObserverOneGrip,
  updateObserverTwoGrip,
  type EclipseObserverTransform,
} from "../apps/pas-de-geant/src/eclipse-observer.js";
import {
  apparentAngularRadius,
  createGeodeticEllipsoidGeometry,
  ecefKmToDisplay,
} from "../apps/pas-de-geant/src/eclipse-rendering.js";
import {
  eclipseScaleAfterInput,
  eclipseTimeAfterInput,
  presetFocus,
  presetMetresPerEarthRadius,
  presetViewDistance,
  stagePositionForScaleAroundFocus,
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
  it("keeps the fallback ellipsoid on the terrain globe's north-up projection", () => {
    const longitudeSegments = 36;
    const latitudeSegments = 18;
    const geometry = createGeodeticEllipsoidGeometry(
      longitudeSegments,
      latitudeSegments,
    );
    const uvs = geometry.getAttribute("uv");
    const latitudeRow = 2;
    const longitudeColumn = 14;
    const greenlandUv = earthTextureUv(70, -40);
    const vertexIndex =
      latitudeRow * (longitudeSegments + 1) + longitudeColumn;

    expect(uvs.getX(vertexIndex)).toBeCloseTo(greenlandUv.u, 7);
    expect(uvs.getY(vertexIndex)).toBeCloseTo(greenlandUv.v, 7);
    expect(uvs.getY(vertexIndex)).toBeLessThan(0.5);
    geometry.dispose();
  });

  it("derives the nearest WGS84 point and room-space head distance", () => {
    const latitudeDegrees = 52.37;
    const longitudeDegrees = 4.9;
    const surface = geodeticToEcef({
      latitudeDeg: latitudeDegrees,
      longitudeDeg: longitudeDegrees,
    });
    const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
    const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
    const normal = new THREE.Vector3(
      Math.cos(latitude) * Math.cos(longitude),
      Math.cos(latitude) * Math.sin(longitude),
      Math.sin(latitude),
    );
    const heightKm = 500;
    const headEcef = new THREE.Vector3(surface.x, surface.y, surface.z)
      .addScaledVector(normal, heightKm);
    const headDisplay = new THREE.Vector3(
      headEcef.x / EARTH_MEAN_RADIUS_KM,
      headEcef.z / EARTH_MEAN_RADIUS_KM,
      -headEcef.y / EARTH_MEAN_RADIUS_KM,
    );
    const metresPerEarthRadius = 0.75;
    const observation = eclipseEarthSurfaceObservation(
      headDisplay,
      metresPerEarthRadius,
    );

    expect(observation.latitudeDegrees).toBeCloseTo(latitudeDegrees, 9);
    expect(observation.longitudeDegrees).toBeCloseTo(longitudeDegrees, 9);
    expect(observation.headDistanceWorldM).toBeCloseTo(
      heightKm / EARTH_MEAN_RADIUS_KM * metresPerEarthRadius,
      12,
    );
    expect(observation.nearestPointResidualWorldM).toBeLessThan(1e-12);
    expect(observation.headPoint.distanceTo(headDisplay)).toBeLessThan(1e-12);
  });

  it("retains a far-away southern sub-head latitude", () => {
    const latitudeDegrees = -58;
    const longitudeDegrees = 142;
    const surface = geodeticToEcef({
      latitudeDeg: latitudeDegrees,
      longitudeDeg: longitudeDegrees,
    });
    const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
    const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
    const normal = new THREE.Vector3(
      Math.cos(latitude) * Math.cos(longitude),
      Math.cos(latitude) * Math.sin(longitude),
      Math.sin(latitude),
    );
    const headEcef = new THREE.Vector3(surface.x, surface.y, surface.z)
      .addScaledVector(normal, 40_000);
    const observation = eclipseEarthSurfaceObservation(
      new THREE.Vector3(
        headEcef.x / EARTH_MEAN_RADIUS_KM,
        headEcef.z / EARTH_MEAN_RADIUS_KM,
        -headEcef.y / EARTH_MEAN_RADIUS_KM,
      ),
      0.75,
    );

    expect(observation.latitudeDegrees).toBeCloseTo(latitudeDegrees, 8);
    expect(observation.longitudeDegrees).toBeCloseTo(longitudeDegrees, 8);
    expect(observation.signedHeadHeightWorldM).toBeGreaterThan(0);
    expect(observation.nearestPointResidualWorldM).toBeLessThan(1e-10);
  });

  it("composes the current stereo head midpoint through the navigation rig", () => {
    const rig = new THREE.Matrix4().compose(
      new THREE.Vector3(4, -2, 7),
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        Math.PI / 2,
      ),
      new THREE.Vector3(1, 1, 1),
    );
    const head = trackedHeadWorldPosition(
      [
        new THREE.Vector3(-0.032, 1.7, -0.4),
        new THREE.Vector3(0.032, 1.7, -0.4),
      ],
      rig,
    );
    const expected = new THREE.Vector3(0, 1.7, -0.4).applyMatrix4(rig);

    expect(head.distanceTo(expected)).toBeLessThan(1e-12);
  });

  it("composes headset gaze through the navigation rig in the correct order", () => {
    const rigQuaternion = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI / 2,
    );
    const trackedQuaternion = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 3,
    );
    const worldQuaternion = trackedHeadWorldQuaternion(
      trackedQuaternion,
      rigQuaternion,
    );
    const worldForward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(worldQuaternion);
    const expectedForward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(trackedQuaternion)
      .applyQuaternion(rigQuaternion);

    expect(worldForward.distanceTo(expectedForward)).toBeLessThan(1e-12);
  });

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

  it("flies along the pitched headset gaze and rolls around the tracked head", () => {
    const observer: EclipseObserverTransform = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
    };
    const headPosition = new THREE.Vector3(0.2, 1.6, -0.3);
    const headQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.45, -0.7, 0, "YXZ"),
    );
    const forward = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(headQuaternion)
      .normalize();
    const rolled = updateObserverHeadRelativeFlight(
      observer,
      headPosition,
      headQuaternion,
      {
        flightAxis: 0,
        rollAxis: 1,
        elapsedSeconds: 0.5,
      },
    );
    const headAfterRoll = headPosition.clone()
      .applyQuaternion(rolled.quaternion)
      .add(rolled.position);
    const flown = updateObserverHeadRelativeFlight(
      observer,
      headPosition,
      headQuaternion,
      {
        flightAxis: 0.75,
        rollAxis: 0,
        elapsedSeconds: 2,
        metresPerSecond: 2,
      },
    );

    expect(headAfterRoll.distanceTo(headPosition)).toBeLessThan(1e-10);
    expect(flown.position.distanceTo(
      forward.multiplyScalar(3),
    )).toBeLessThan(1e-10);
  });

  it("scales the complete system around a fixed focus without changing solar angle", () => {
    const stage = {
      position: new THREE.Vector3(1, -2, 0.5),
      quaternion: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        0.3,
      ),
      metresPerEarthRadius: 0.1,
    };
    const focus = frame.moonPosition.clone().multiplyScalar(0.5);
    const fixedWorldFocus = focus.clone()
      .multiplyScalar(stage.metresPerEarthRadius)
      .applyQuaternion(stage.quaternion)
      .add(stage.position);
    const nextScale = eclipseScaleAfterInput(
      stage.metresPerEarthRadius,
      1,
      2,
    );
    const nextPosition = stagePositionForScaleAroundFocus(
      stage,
      focus,
      nextScale,
    );
    const nextWorldFocus = focus.clone()
      .multiplyScalar(nextScale)
      .applyQuaternion(stage.quaternion)
      .add(nextPosition);
    const oldMoonWorld = frame.moonPosition.clone()
      .multiplyScalar(stage.metresPerEarthRadius)
      .applyQuaternion(stage.quaternion)
      .add(stage.position);
    const nextMoonWorld = frame.moonPosition.clone()
      .multiplyScalar(nextScale)
      .applyQuaternion(stage.quaternion)
      .add(nextPosition);
    const sunRadius = 109.2;
    const sunDistance = 23_455;

    expect(nextWorldFocus.distanceTo(fixedWorldFocus)).toBeLessThan(1e-10);
    expect(nextScale).toBeGreaterThan(stage.metresPerEarthRadius);
    expect(nextMoonWorld.distanceTo(nextPosition) /
      oldMoonWorld.distanceTo(stage.position)).toBeCloseTo(
        nextScale / stage.metresPerEarthRadius,
        12,
      );
    expect(apparentAngularRadius(
      sunRadius * stage.metresPerEarthRadius,
      sunDistance * stage.metresPerEarthRadius,
    )).toBeCloseTo(apparentAngularRadius(
      sunRadius * nextScale,
      sunDistance * nextScale,
    ), 12);
  });

  it("scrubs eclipse time in both directions and stops at the contacts", () => {
    const start = Date.parse("2026-08-12T16:00:00Z");
    const end = Date.parse("2026-08-12T20:00:00Z");
    const middle = Date.parse("2026-08-12T18:00:00Z");

    expect(eclipseTimeAfterInput(middle, 1, 1, start, end)).toBeGreaterThan(
      middle,
    );
    expect(eclipseTimeAfterInput(middle, -1, 1, start, end)).toBeLessThan(
      middle,
    );
    expect(eclipseTimeAfterInput(middle, 1, 60, start, end)).toBe(end);
    expect(eclipseTimeAfterInput(middle, -1, 60, start, end)).toBe(start);
  });
});
