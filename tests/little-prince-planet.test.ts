import { Vector2, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  INITIAL_DISPLAY_RADIUS_M,
  MAX_DISPLAY_RADIUS_M,
  MIN_DISPLAY_RADIUS_M,
  apexError,
  applyLogarithmicScale,
  applyReliefRate,
  contactFrame,
  coordinatesForFrame,
  earthToWorldQuaternion,
  frameIsOrthonormal,
  initialPlanetState,
  rollContactFrame,
  solvePlanetPose,
} from "../apps/little-prince/src/planet-state.js";

describe("Little Planet rolling contact frame", () => {
  it("starts at central Iberia with an orthonormal frame", () => {
    const state = initialPlanetState();
    const coordinates = coordinatesForFrame(state.contact);
    expect(coordinates.latitudeDegrees).toBeCloseTo(40, 12);
    expect(coordinates.longitudeDegrees).toBeCloseTo(-4, 12);
    expect(frameIsOrthonormal(state.contact)).toBe(true);
  });

  it("maps the right-handed contact frame onto the room axes", () => {
    const frame = contactFrame(40, -4);
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
    for (const radius of [1, INITIAL_DISPLAY_RADIUS_M, MAX_DISPLAY_RADIUS_M]) {
      state.displayRadiusM = radius;
      const headset = new Vector2(2.4, -1.1);
      const error = apexError(state, solvePlanetPose(state, headset), headset);
      expect(error.length()).toBeLessThan(1e-10);
    }
  });
});

describe("Little Planet scale controls", () => {
  it("clamps world scale and retains the tactile Iberia detent", () => {
    expect(applyLogarithmicScale(1, -1, 10)).toBe(MIN_DISPLAY_RADIUS_M);
    expect(
      applyLogarithmicScale(MAX_DISPLAY_RADIUS_M, 1, 10),
    ).toBe(MAX_DISPLAY_RADIUS_M);
    expect(
      applyLogarithmicScale(INITIAL_DISPLAY_RADIUS_M * 1.01, 0, 1),
    ).toBe(INITIAL_DISPLAY_RADIUS_M);
  });

  it("clamps radial relief and retains its true-scale detent", () => {
    expect(applyReliefRate(0, -1, 10)).toBe(0);
    expect(applyReliefRate(20, 1, 10)).toBe(20);
    expect(applyReliefRate(1.04, 0, 1)).toBe(1);
  });
});
