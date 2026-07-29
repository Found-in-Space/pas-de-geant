import { Vector2, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  INITIAL_DISPLAY_RADIUS_M,
  MIN_DISPLAY_RADIUS_M,
  apexError,
  applyLogarithmicScale,
  applyRadialMultiplierRate,
  contactFrame,
  coordinatesForFrame,
  earthToWorldQuaternion,
  frameIsOrthonormal,
  horizontalWorldMetresForKilometres,
  initialPlanetState,
  normalizedRadialOffsetForKilometres,
  radialWorldMetresForKilometres,
  rollContactFrame,
  solvePlanetPose,
} from "../apps/pas-de-geant/src/planet-state.js";

describe("Pas de Géant rolling contact frame", () => {
  it("starts at the supplied global location with an orthonormal frame", () => {
    const state = initialPlanetState(-33.8688, 151.2093);
    const coordinates = coordinatesForFrame(state.contact);
    expect(coordinates.latitudeDegrees).toBeCloseTo(-33.8688, 12);
    expect(coordinates.longitudeDegrees).toBeCloseTo(151.2093, 12);
    expect(frameIsOrthonormal(state.contact)).toBe(true);
  });

  it("maps the right-handed contact frame onto the room axes", () => {
    const frame = contactFrame(35.6762, 139.6503);
    const earthToWorld = earthToWorldQuaternion(frame);
    expect(
      frame.upEcef
        .clone()
        .applyQuaternion(earthToWorld)
        .distanceTo(new Vector3(0, 1, 0)),
    ).toBeLessThan(1e-10);
    expect(
      frame.eastEcef
        .clone()
        .applyQuaternion(earthToWorld)
        .distanceTo(new Vector3(1, 0, 0)),
    ).toBeLessThan(1e-10);
    expect(
      frame.northEcef
        .clone()
        .applyQuaternion(earthToWorld)
        .distanceTo(new Vector3(0, 0, -1)),
    ).toBeLessThan(1e-10);
  });

  it("rolls east, north, across the antimeridian, and over a pole", () => {
    let frame = contactFrame(0, 179.9);
    frame = rollContactFrame(
      frame,
      new Vector2(INITIAL_DISPLAY_RADIUS_M * 0.01, 0),
      INITIAL_DISPLAY_RADIUS_M,
    );
    expect(coordinatesForFrame(frame).longitudeDegrees).toBeLessThan(-179);
    expect(frameIsOrthonormal(frame)).toBe(true);

    frame = contactFrame(89.9, 0);
    frame = rollContactFrame(
      frame,
      new Vector2(0, -INITIAL_DISPLAY_RADIUS_M * 0.01),
      INITIAL_DISPLAY_RADIUS_M,
    );
    expect(Number.isFinite(coordinatesForFrame(frame).longitudeDegrees)).toBe(
      true,
    );
    expect(frameIsOrthonormal(frame)).toBe(true);
  });

  it("keeps the sea-level apex pinned beneath the headset", () => {
    const state = initialPlanetState();
    state.contact = rollContactFrame(
      state.contact,
      new Vector2(17.3, -8.8),
      state.displayRadiusM,
    );
    for (const radialMultiplier of [0, 1, 20]) {
      state.radialMultiplier = radialMultiplier;
      for (const radius of [
        1,
        INITIAL_DISPLAY_RADIUS_M,
        INITIAL_DISPLAY_RADIUS_M * 100,
      ]) {
        state.displayRadiusM = radius;
        const headset = new Vector2(2.4, -1.1);
        const error = apexError(
          state,
          solvePlanetPose(state, headset),
          headset,
        );
        expect(error.length()).toBeLessThan(1e-10);
      }
    }
  });
});

describe("Pas de Géant scale controls", () => {
  it("keeps the lower scale bound without imposing an upper cap", () => {
    expect(applyLogarithmicScale(1, -1, 10)).toBe(MIN_DISPLAY_RADIUS_M);
    const formerUpperLimit = INITIAL_DISPLAY_RADIUS_M * 5;
    expect(
      applyLogarithmicScale(formerUpperLimit, 1, 10),
    ).toBeGreaterThan(formerUpperLimit);
  });

  it("retains the tactile initial-scale detent", () => {
    expect(
      applyLogarithmicScale(INITIAL_DISPLAY_RADIUS_M * 1.01, 0, 1),
    ).toBe(INITIAL_DISPLAY_RADIUS_M);
  });

  it("clamps the radial multiplier and retains its true-scale detent", () => {
    expect(applyRadialMultiplierRate(0, -1, 10)).toBe(0);
    expect(applyRadialMultiplierRate(20, 1, 10)).toBe(20);
    expect(applyRadialMultiplierRate(1.04, 0, 1)).toBe(1);
  });

  it("composes uniform planet scale with a separate radial multiplier", () => {
    expect(
      horizontalWorldMetresForKilometres(
        1,
        INITIAL_DISPLAY_RADIUS_M,
      ),
    ).toBeCloseTo(0.01);
    expect(
      radialWorldMetresForKilometres(
        1,
        INITIAL_DISPLAY_RADIUS_M,
        10,
      ),
    ).toBeCloseTo(0.1);
    expect(
      normalizedRadialOffsetForKilometres(100, 20),
    ).toBeCloseTo(2_000 / 6_371.0088);
  });
});
