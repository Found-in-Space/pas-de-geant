import {
  Body,
  GeoMoon,
  GeoVector,
  MakeTime,
  Observer,
  ObserverVector,
  RotateVector,
  Rotation_EQJ_HOR,
  Vector,
} from "astronomy-engine";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  CELESTIAL_EPHEMERIS_STEP_MS,
  CELESTIAL_LIMITING_MAGNITUDE,
  CELESTIAL_PLANET_NAMES,
  CelestialSphere,
  type CelestialBodyEphemeris,
  calculateCelestialBodyEphemeris,
  celestialToWorldQuaternion,
} from "../apps/pas-de-geant/src/celestial-sphere.js";
import {
  parseCelestialVisibilityArguments,
} from "../apps/pas-de-geant/src/celestial-visibility.js";
import {
  contactFrame,
  earthToWorldQuaternion,
  geodeticSurfaceEcefKm,
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
    expect(
      sphere.object3d.getObjectByName("skykit-celestial-sphere"),
    ).toBeUndefined();
    expect(
      sphere.object3d.getObjectByName("celestial-bodies"),
    ).toBeDefined();
    sphere.dispose();
  });

  it("places the Sun and Moon at current J2000 directions", () => {
    const at = new Date("2026-08-12T17:45:46.794Z");
    const ephemeris = calculateCelestialBodyEphemeris(at);
    const angularSeparation = new THREE.Vector3(
      ephemeris.sunDirectionJ2000.x,
      ephemeris.sunDirectionJ2000.y,
      ephemeris.sunDirectionJ2000.z,
    ).angleTo(
      new THREE.Vector3(
        ephemeris.moonDirectionJ2000.x,
        ephemeris.moonDirectionJ2000.y,
        ephemeris.moonDirectionJ2000.z,
      ),
    );

    expect(THREE.MathUtils.radToDeg(angularSeparation)).toBeLessThan(1);
    expect(
      THREE.MathUtils.radToDeg(ephemeris.sunAngularRadiusRad),
    ).toBeCloseTo(0.266, 2);
    expect(
      THREE.MathUtils.radToDeg(ephemeris.moonAngularRadiusRad),
    ).toBeGreaterThan(0.25);
    expect(
      Math.abs(ephemeris.moonLibrationLatitudeDeg) +
      Math.abs(ephemeris.moonLibrationLongitudeDeg),
    ).toBeGreaterThan(1);

    const sphere = new CelestialSphere();
    sphere.update(
      new THREE.Quaternion(),
      new THREE.Vector3(),
      at.getTime(),
    );
    const moon = sphere.object3d.getObjectByName("celestial-moon")!;
    const longitude = THREE.MathUtils.degToRad(
      ephemeris.moonLibrationLongitudeDeg,
    );
    const latitude = THREE.MathUtils.degToRad(
      ephemeris.moonLibrationLatitudeDeg,
    );
    const subEarthSurface = new THREE.Vector3(
      Math.cos(latitude) * Math.cos(longitude),
      Math.sin(latitude),
      -Math.cos(latitude) * Math.sin(longitude),
    ).applyQuaternion(moon.quaternion);
    const moonToEarth = new THREE.Vector3(
      -ephemeris.moonDirectionJ2000.x,
      -ephemeris.moonDirectionJ2000.y,
      -ephemeris.moonDirectionJ2000.z,
    );
    expect(subEarthSurface.distanceTo(moonToEarth)).toBeLessThan(1e-12);
    sphere.dispose();
  });

  it("uses the exact observer location for eclipse parallax", () => {
    const at = new Date("2026-08-12T18:27:55.560Z");
    const latitude = 43;
    const longitude = -3;
    const heightMeters = 1.65;
    const frame = contactFrame(latitude, longitude);
    const observerAppEcefKm = geodeticSurfaceEcefKm(
      latitude,
      longitude,
    ).addScaledVector(frame.upEcef, heightMeters / 1_000);
    const sphere = new CelestialSphere();
    sphere.update(
      earthToWorldQuaternion(frame),
      new THREE.Vector3(0, heightMeters, 0),
      at.getTime(),
      observerAppEcefKm,
    );

    const renderedSun = sphere.object3d
      .getObjectByName("celestial-sun")!.position.clone().normalize();
    const renderedMoon = sphere.object3d
      .getObjectByName("celestial-moon")!.position.clone().normalize();
    const observer = ObserverVector(
      at,
      new Observer(latitude, longitude, heightMeters),
      false,
    );
    const sun = GeoVector(Body.Sun, at, true);
    const moon = GeoMoon(at);
    const expectedSun = new THREE.Vector3(
      sun.x - observer.x,
      sun.y - observer.y,
      sun.z - observer.z,
    ).normalize();
    const expectedMoon = new THREE.Vector3(
      moon.x - observer.x,
      moon.y - observer.y,
      moon.z - observer.z,
    ).normalize();

    expect(renderedSun.distanceTo(expectedSun)).toBeLessThan(2e-9);
    expect(renderedMoon.distanceTo(expectedMoon)).toBeLessThan(2e-9);
    expect(
      THREE.MathUtils.radToDeg(renderedSun.angleTo(renderedMoon)),
    ).toBeLessThan(0.01);
    sphere.dispose();
  });

  it("renders visible planets by magnitude while retaining every anchor", () => {
    const at = new Date("2026-08-07T12:00:00.000Z");
    const ephemeris = calculateCelestialBodyEphemeris(at);
    expect(ephemeris.planets.map(({ name }) => name)).toEqual(
      CELESTIAL_PLANET_NAMES,
    );

    const jupiter = ephemeris.planets.find(
      ({ name }) => name === "Jupiter",
    )!;
    const neptune = ephemeris.planets.find(
      ({ name }) => name === "Neptune",
    )!;
    expect(jupiter.apparentMagnitude).toBeLessThanOrEqual(
      CELESTIAL_LIMITING_MAGNITUDE,
    );
    expect(neptune.apparentMagnitude).toBeGreaterThan(
      CELESTIAL_LIMITING_MAGNITUDE,
    );

    const latitude = 43;
    const longitude = -3;
    const heightMeters = 1.65;
    const frame = contactFrame(latitude, longitude);
    const observerAppEcefKm = geodeticSurfaceEcefKm(
      latitude,
      longitude,
    ).addScaledVector(frame.upEcef, heightMeters / 1_000);
    const sphere = new CelestialSphere();
    sphere.update(
      earthToWorldQuaternion(frame),
      new THREE.Vector3(0, heightMeters, 0),
      at.getTime(),
      observerAppEcefKm,
    );

    for (const name of CELESTIAL_PLANET_NAMES) {
      const anchor = sphere.getPlanetAnchor(name);
      expect(anchor.name).toBe(
        `celestial-planet-${name.toLowerCase()}-anchor`,
      );
      expect(anchor.position.length()).toBeCloseTo(520, 4);
    }

    const observer = ObserverVector(
      at,
      new Observer(latitude, longitude, heightMeters),
      false,
    );
    const jupiterPosition = GeoVector(Body.Jupiter, at, true);
    const expectedJupiterDirection = new THREE.Vector3(
      jupiterPosition.x - observer.x,
      jupiterPosition.y - observer.y,
      jupiterPosition.z - observer.z,
    ).normalize();
    expect(
      sphere.getPlanetAnchor("Jupiter").position.clone().normalize()
        .distanceTo(expectedJupiterDirection),
    ).toBeLessThan(2e-9);

    const cores = sphere.object3d.getObjectByName(
      "celestial-planet-cores",
    ) as THREE.Points<THREE.BufferGeometry>;
    const magnitudes = cores.geometry.getAttribute("magAbs");
    expect(magnitudes.count).toBe(CELESTIAL_PLANET_NAMES.length);
    expect(
      magnitudes.getX(CELESTIAL_PLANET_NAMES.indexOf("Jupiter")),
    ).toBeCloseTo(jupiter.apparentMagnitude + 5, 5);
    expect(
      magnitudes.getX(CELESTIAL_PLANET_NAMES.indexOf("Neptune")),
    ).toBeCloseTo(neptune.apparentMagnitude + 5, 5);

    expect(sphere.getVisibility().all_enabled).toBe(true);
    sphere.setVisibility("sun_and_moon", false);
    expect(
      sphere.object3d.getObjectByName("celestial-sun")?.visible,
    ).toBe(false);
    expect(
      sphere.object3d.getObjectByName("celestial-moon")?.visible,
    ).toBe(false);

    sphere.setVisibility("planets", false);
    for (let index = 0; index < magnitudes.count; index += 1) {
      expect(magnitudes.getX(index)).toBe(100);
    }
    expect(sphere.getPlanetAnchor("Jupiter").position.length()).toBeCloseTo(
      520,
      4,
    );

    const jupiterVisibility = sphere.setVisibility("jupiter", true);
    expect(jupiterVisibility.planets.jupiter).toBe(true);
    expect(jupiterVisibility.planets.mars).toBe(false);
    expect(jupiterVisibility.all_planets_enabled).toBe(false);
    expect(
      magnitudes.getX(CELESTIAL_PLANET_NAMES.indexOf("Jupiter")),
    ).toBeCloseTo(jupiter.apparentMagnitude + 5, 5);
    expect(
      magnitudes.getX(CELESTIAL_PLANET_NAMES.indexOf("Mars")),
    ).toBe(100);

    expect(sphere.setVisibility("all", true).all_enabled).toBe(true);
    sphere.dispose();
  });

  it("validates individual and grouped celestial voice controls", () => {
    expect(parseCelestialVisibilityArguments({
      target: "saturn",
      enabled: false,
    })).toEqual({ target: "saturn", enabled: false });
    expect(parseCelestialVisibilityArguments({
      target: "planets",
      enabled: true,
    })).toEqual({ target: "planets", enabled: true });
    expect(() => parseCelestialVisibilityArguments({
      target: "stars",
      enabled: true,
    })).toThrow("target");
    expect(() => parseCelestialVisibilityArguments({
      target: "moon",
      enabled: "yes",
    })).toThrow("boolean");
  });

  it("refreshes slow ephemerides independently of frame updates", () => {
    const fixedEphemeris: CelestialBodyEphemeris = {
      sunDirectionJ2000: { x: 1, y: 0, z: 0 },
      moonDirectionJ2000: { x: 0, y: 1, z: 0 },
      sunDistanceAu: 1,
      moonDistanceAu: 0.00257,
      sunAngularRadiusRad: THREE.MathUtils.degToRad(0.266),
      moonAngularRadiusRad: THREE.MathUtils.degToRad(0.272),
      moonLibrationLatitudeDeg: 0,
      moonLibrationLongitudeDeg: 0,
      moonNorthPoleJ2000: { x: 0, y: 0, z: 1 },
      planets: CELESTIAL_PLANET_NAMES.map((name, index) => ({
        name,
        positionJ2000Au: { x: index + 1, y: 1, z: 1 },
        apparentMagnitude: index,
      })),
    };
    let ephemerisCalls = 0;
    const sphere = new CelestialSphere(
      async () => [],
      () => {
        ephemerisCalls += 1;
        return fixedEphemeris;
      },
    );
    const earthToWorld = new THREE.Quaternion();
    const cameraPosition = new THREE.Vector3();
    const startMs = Date.parse("2026-08-12T17:45:46.794Z");

    sphere.update(earthToWorld, cameraPosition, startMs);
    sphere.update(
      earthToWorld,
      cameraPosition,
      startMs + CELESTIAL_EPHEMERIS_STEP_MS - 1,
    );
    expect(ephemerisCalls).toBe(1);
    expect(
      sphere.object3d.getObjectByName("celestial-sun")?.position.x,
    ).toBeGreaterThan(500);
    expect(
      sphere.object3d.getObjectByName("celestial-moon")?.position.y,
    ).toBeGreaterThan(500);
    const moon = sphere.object3d.getObjectByName("celestial-moon");
    const nearSideDirection = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(moon!.quaternion);
    expect(
      nearSideDirection.distanceTo(new THREE.Vector3(0, -1, 0)),
    ).toBeLessThan(1e-12);

    sphere.update(
      earthToWorld,
      cameraPosition,
      startMs + CELESTIAL_EPHEMERIS_STEP_MS,
    );
    expect(ephemerisCalls).toBe(2);
    sphere.dispose();
  });
});
