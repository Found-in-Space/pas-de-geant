import { Vector2 } from "three";
import { describe, expect, it } from "vitest";
import {
  INITIAL_DISPLAY_RADIUS_M,
  applyRadialMultiplierRate,
  apexError,
  contactFrame,
  coordinatesForFrame,
  frameIsOrthonormal,
  initialPlanetState,
  rollContactFrame,
  solvePlanetPose,
} from "../apps/pas-de-geant/src/planet-state.js";

describe("Pas de Géant rolling-planet regressions", () => {
  it("does not allow the radial multiplier to become negative", () => {
    expect(applyRadialMultiplierRate(0.1, -1, 1)).toBe(0);
    expect(applyRadialMultiplierRate(0, -1, 1)).toBe(0);
    expect(applyRadialMultiplierRate(0, 1, 1)).toBe(3);
  });

  it("rolls continuously across the antimeridian and over a pole", () => {
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
    const headset = new Vector2(2.4, -1.1);

    for (const radialMultiplier of [0, 1, 20]) {
      state.radialMultiplier = radialMultiplier;
      for (const radius of [
        1,
        INITIAL_DISPLAY_RADIUS_M,
        INITIAL_DISPLAY_RADIUS_M * 100,
      ]) {
        state.displayRadiusM = radius;
        expect(
          apexError(
            state,
            solvePlanetPose(state, headset),
            headset,
          ).length(),
        ).toBeLessThan(1e-10);
      }
    }
  });
});
