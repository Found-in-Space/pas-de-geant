import { Vector2 } from "three";
import { describe, expect, it } from "vitest";
import {
  applyTerrainMultiplierRate,
  apexError,
  contactFrame,
  coordinatesForFrame,
  frameIsOrthonormal,
  initialPlanetState,
  normalizedBodyLocalPhysicalOffset,
  normalizedBodyLocalTerrainOffset,
  rollContactFrame,
  solvePlanetPose,
} from "@found-in-space/worlds/planet-state";

const DISPLAY_RADIUS_M = 3_000;

describe("Pas de Géant rolling-planet regressions", () => {
  it("does not allow the terrain multiplier to become negative", () => {
    expect(applyTerrainMultiplierRate(0.1, -1, 1)).toBe(0);
    expect(applyTerrainMultiplierRate(0, -1, 1)).toBe(0);
    expect(applyTerrainMultiplierRate(0, 1, 1)).toBe(3);
  });

  it("keeps physical offsets separate from terrain exaggeration", () => {
    expect(normalizedBodyLocalPhysicalOffset(250, 1_000)).toBe(0.25);
    expect(normalizedBodyLocalTerrainOffset(250, 4, 1_000)).toBe(1);
  });

  it("rolls continuously across the antimeridian and over a pole", () => {
    let frame = contactFrame(0, 179.9);
    frame = rollContactFrame(
      frame,
      new Vector2(DISPLAY_RADIUS_M * 0.01, 0),
      DISPLAY_RADIUS_M,
    );
    expect(coordinatesForFrame(frame).longitudeDegrees).toBeLessThan(-179);
    expect(frameIsOrthonormal(frame)).toBe(true);

    frame = contactFrame(89.9, 0);
    frame = rollContactFrame(
      frame,
      new Vector2(0, -DISPLAY_RADIUS_M * 0.01),
      DISPLAY_RADIUS_M,
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
      DISPLAY_RADIUS_M,
    );
    const headset = new Vector2(2.4, -1.1);

    for (const terrainMultiplier of [0, 1, 20]) {
      state.terrainMultiplier = terrainMultiplier;
      for (const radius of [
        1,
        DISPLAY_RADIUS_M,
        DISPLAY_RADIUS_M * 100,
      ]) {
        expect(
          apexError(
            state,
            solvePlanetPose(state, headset, radius),
            headset,
            radius,
          ).length(),
        ).toBeLessThan(1e-10);
      }
    }
  });
});
