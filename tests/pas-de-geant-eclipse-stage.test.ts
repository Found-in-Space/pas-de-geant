import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  MOON_RADIUS_KM,
  geodeticToEcef,
} from "@found-in-space/shadowline";
import { describe, expect, it } from "vitest";
import {
  eclipseEarthSurfaceObservation,
  eclipseTopographicAltitudeMetres,
  eclipseTopographicSurfaceRadius,
  trackedHeadWorldPosition,
  trackedHeadWorldQuaternion,
} from "../apps/pas-de-geant/src/eclipse-earth-surface.js";
import { earthTextureUv } from "../apps/pas-de-geant/src/earth-texture-projection.js";
import {
  beginObserverTwoGrip,
  observerProjectedToEarthRadius,
  observerTranslatedForHeadPosition,
  updateObserverEarthOrbit,
  updateObserverTwoGrip,
  type EclipseObserverTransform,
} from "../apps/pas-de-geant/src/eclipse-observer.js";
import {
  apparentAngularRadius,
  createGeodeticEllipsoidGeometry,
  ecefKmToDisplay,
} from "../apps/pas-de-geant/src/eclipse-rendering.js";
import {
  eclipseCameraDepthRange,
  eclipseRadialDistanceAfterInput,
  eclipseScaleAfterInput,
  headsetPointAfterSimulationScaleChange,
  type GripPose,
} from "../apps/pas-de-geant/src/eclipse-stage.js";

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

  it("keeps one Earth-radius coordinate system", () => {
    expect(
      ecefKmToDisplay({ x: EARTH_MEAN_RADIUS_KM, y: 0, z: 0 }).length(),
    ).toBeCloseTo(1, 12);
  });

  it("uses rendered topography for radial altitude and the inward floor", () => {
    const surface = geodeticToEcef({ latitudeDeg: 0, longitudeDeg: 0 });
    const head = new THREE.Vector3(
      (surface.x + 5) / EARTH_MEAN_RADIUS_KM,
      0,
      0,
    );
    const observation = eclipseEarthSurfaceObservation(head, 0.75);
    const ellipsoidRadius = observation.surfacePoint.length();

    expect(eclipseTopographicSurfaceRadius(observation, 1_500))
      .toBeCloseTo(ellipsoidRadius + 1.5 / EARTH_MEAN_RADIUS_KM, 12);
    expect(eclipseTopographicAltitudeMetres(observation, 1_500))
      .toBeCloseTo(3_500, 6);
    expect(eclipseTopographicAltitudeMetres(observation, -400))
      .toBeCloseTo(5_400, 6);
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
    const trackedHead = new THREE.Vector3(0, 1.65, 0);
    const candidateHead = trackedHead.clone()
      .applyQuaternion(observerCurrent.quaternion)
      .add(observerCurrent.position);
    const earthCentre = new THREE.Vector3(0.3, -0.8, -2);
    const projected = observerProjectedToEarthRadius(
      observerCurrent,
      candidateHead,
      earthCentre,
      4.5,
    );
    const projectedHead = trackedHead.clone()
      .applyQuaternion(projected.quaternion)
      .add(projected.position);

    expect(currentMidpoint.distanceTo(startMidpoint)).toBeLessThan(1e-10);
    expect(currentDirection.angleTo(startDirection)).toBeLessThan(1e-10);
    expect(observerRig.scale.toArray()).toEqual([1, 1, 1]);
    expect(xrCamera.scale.toArray()).toEqual([1, 1, 1]);
    expect(projectedHead.distanceTo(earthCentre)).toBeCloseTo(4.5, 12);
    expect(projected.quaternion.angleTo(observerCurrent.quaternion))
      .toBeLessThan(1e-12);
  });

  it("orbits in headset-relative directions while preserving Earth framing", () => {
    const observer: EclipseObserverTransform = {
      position: new THREE.Vector3(0, 0, 4),
      quaternion: new THREE.Quaternion(),
    };
    const earthCentre = new THREE.Vector3();
    const headPosition = observer.position.clone();
    const headQuaternion = observer.quaternion.clone();
    const originalEarthBearing = earthCentre.clone().sub(headPosition)
      .applyQuaternion(headQuaternion.clone().invert());
    const orbited = updateObserverEarthOrbit(
      observer,
      headPosition,
      headQuaternion,
      earthCentre,
      0.3,
      0.2,
    );
    const nextEarthBearing = earthCentre.clone().sub(orbited.position)
      .applyQuaternion(orbited.quaternion.clone().invert());
    const stopped = updateObserverEarthOrbit(
      observer,
      headPosition,
      headQuaternion,
      earthCentre,
      0,
      0,
    );

    expect(orbited.position.length()).toBeCloseTo(headPosition.length(), 12);
    expect(nextEarthBearing.distanceTo(originalEarthBearing)).toBeLessThan(1e-10);
    expect(stopped.position.distanceTo(observer.position)).toBe(0);
    expect(stopped.quaternion.angleTo(observer.quaternion)).toBe(0);
  });

  it("changes radial distance proportionally without changing its direction", () => {
    const earthCentre = new THREE.Vector3(1, -2, 0.5);
    const headPosition = new THREE.Vector3(1, -2, 4.5);
    const observer: EclipseObserverTransform = {
      position: headPosition.clone(),
      quaternion: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        0.4,
      ),
    };
    const desiredRadius = eclipseRadialDistanceAfterInput(4, 1, 1 / 1.2);
    const projected = observerProjectedToEarthRadius(
      observer,
      headPosition,
      earthCentre,
      desiredRadius,
    );

    expect(desiredRadius).toBeCloseTo(8, 12);
    expect(projected.position.distanceTo(earthCentre)).toBeCloseTo(8, 12);
    expect(projected.position.clone().sub(earthCentre).normalize().distanceTo(
      headPosition.clone().sub(earthCentre).normalize(),
    )).toBeLessThan(1e-12);
    expect(projected.quaternion.angleTo(observer.quaternion)).toBe(0);
  });

  it("changes the headset conversion while preserving observer distance in Earth units", () => {
    const earthCentre = new THREE.Vector3(1, -2, 0.5);
    const oldScale = 0.1;
    const trackedHead = new THREE.Vector3(0.2, 1.65, -0.3);
    const observer: EclipseObserverTransform = {
      position: new THREE.Vector3(0.7, -3.4, 0.9),
      quaternion: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        0.35,
      ),
    };
    const oldHeadPosition = trackedHead.clone()
      .applyQuaternion(observer.quaternion)
      .add(observer.position);
    const nextScale = eclipseScaleAfterInput(
      oldScale,
      1,
      2,
    );
    const desiredHeadPosition = headsetPointAfterSimulationScaleChange(
      oldHeadPosition,
      earthCentre,
      oldScale,
      nextScale,
    );
    const scaledObserver = observerTranslatedForHeadPosition(
      observer,
      oldHeadPosition,
      desiredHeadPosition,
    );
    const scaledHeadPosition = trackedHead.clone()
      .applyQuaternion(scaledObserver.quaternion)
      .add(scaledObserver.position);
    const moonRadius = MOON_RADIUS_KM / EARTH_MEAN_RADIUS_KM;
    const moonDistance = 60.3;

    expect(scaledHeadPosition.distanceTo(earthCentre) / nextScale)
      .toBeCloseTo(oldHeadPosition.distanceTo(earthCentre) / oldScale, 12);
    expect(earthCentre.toArray()).toEqual([1, -2, 0.5]);
    expect(apparentAngularRadius(
      moonRadius * oldScale,
      moonDistance * oldScale,
    )).toBeCloseTo(apparentAngularRadius(
      moonRadius * nextScale,
      moonDistance * nextScale,
    ), 12);
  });

  it("keeps the Earth–Moon scene inside the camera depth range at tiny and large display conversions", () => {
    const systemExtentSimulationUnits = 64;
    const tinyScale = 0.001;
    const tinyObserverDistance = tinyScale * 4;
    const tiny = eclipseCameraDepthRange(
      tinyScale,
      tinyObserverDistance,
      systemExtentSimulationUnits,
    );
    const earthSurfaceClearance = tinyObserverDistance - tinyScale;

    expect(tiny.nearM).toBeLessThan(earthSurfaceClearance);
    expect(tiny.farM).toBeGreaterThanOrEqual(1_200);

    const largeScale = 100;
    const largeObserverDistance = largeScale * 4;
    const large = eclipseCameraDepthRange(
      largeScale,
      largeObserverDistance,
      systemExtentSimulationUnits,
    );

    expect(large.nearM).toBe(0.02);
    expect(large.farM).toBeGreaterThan(
      largeObserverDistance + systemExtentSimulationUnits * largeScale,
    );
  });
});
