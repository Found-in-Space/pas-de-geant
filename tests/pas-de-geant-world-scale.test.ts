import { describe, expect, it } from "vitest";
import {
  celestialBody,
} from "../apps/pas-de-geant/src/solar-system.js";
import {
  displayRadiusForScale,
  initialWorldNavigationState,
  withNavigationTarget,
  withScaleDenominator,
} from "../apps/pas-de-geant/src/world-navigation.js";
import {
  sampleScaleTransition,
} from "../apps/pas-de-geant/src/navigation-transition.js";
import {
  DEFAULT_SCALE_DENOMINATOR,
  formatScaleRatio,
  headsetScaleFactorForDenominatorChange,
  headsetMetresForPhysicalMetres,
  physicalMetresForHeadsetMetres,
  scaleDenominatorAfterInput,
} from "../apps/pas-de-geant/src/world-scale.js";

describe("universal 1:N world scale", () => {
  it("displays Earth at 106.18348 metres at 1:60,000", () => {
    expect(DEFAULT_SCALE_DENOMINATOR).toBe(60_000);
    expect(displayRadiusForScale("earth", DEFAULT_SCALE_DENOMINATOR))
      .toBeCloseTo(106.18348, 8);
  });

  it("uses the same physical conversion for the Moon and every other body", () => {
    for (const bodyId of ["moon", "mars", "sun"] as const) {
      const body = celestialBody(bodyId);
      expect(displayRadiusForScale(bodyId, DEFAULT_SCALE_DENOMINATOR))
        .toBeCloseTo(
          body.referenceRadiusM / DEFAULT_SCALE_DENOMINATOR,
          12,
        );
    }
    expect(
      displayRadiusForScale("moon", DEFAULT_SCALE_DENOMINATOR) /
        displayRadiusForScale("earth", DEFAULT_SCALE_DENOMINATOR),
    ).toBeCloseTo(
      celestialBody("moon").referenceRadiusM /
        celestialBody("earth").referenceRadiusM,
      12,
    );
  });

  it("round-trips physical and headset metres without imposing a ceiling", () => {
    for (const denominator of [1e-9, 60_000, Number.MAX_VALUE]) {
      const headsetM = headsetMetresForPhysicalMetres(12.5, denominator);
      expect(physicalMetresForHeadsetMetres(headsetM, denominator))
        .toBeCloseTo(12.5, 12);
    }
  });

  it("preserves scale and physical observer state across focus and mode changes", () => {
    const observer = { x: 12_000, y: -34_000, z: 56_000 };
    const initial = {
      ...initialWorldNavigationState(51.5, -0.1, 72_345),
      observerSystemPositionM: observer,
    };
    const orbit = withNavigationTarget(initial, "moon", "orbit");
    const free = withNavigationTarget(orbit, "mars", "free");

    expect(orbit.scaleDenominator).toBe(72_345);
    expect(free.scaleDenominator).toBe(72_345);
    expect(free.observerSystemPositionM).toBe(observer);
    expect(withScaleDenominator(free, 120_000).observerSystemPositionM)
      .toBe(observer);
  });

  it("keeps physical observer distance fixed throughout an animated scale", () => {
    const physicalDistanceM = 384_400_000;
    const transition = {
      from: 60_000,
      to: 120_000,
      startedAtMs: 1_000,
      durationSeconds: 2,
    };
    for (const nowMs of [1_000, 1_500, 2_000, 2_500, 3_000]) {
      const denominator = sampleScaleTransition(transition, nowMs).value;
      const headsetDistanceM = headsetMetresForPhysicalMetres(
        physicalDistanceM,
        denominator,
      );
      expect(physicalMetresForHeadsetMetres(headsetDistanceM, denominator))
        .toBeCloseTo(physicalDistanceM, 6);
    }
  });

  it("scales headset offsets inversely when the denominator changes", () => {
    expect(headsetScaleFactorForDenominatorChange(60_000, 120_000)).toBe(0.5);
    expect(headsetScaleFactorForDenominatorChange(60_000, 30_000)).toBe(2);
  });

  it("formats the only user-facing scale representation consistently", () => {
    expect(formatScaleRatio(150)).toBe("1 : 150");
    expect(formatScaleRatio(9_200)).toBe("1 : 9,000");
    expect(formatScaleRatio(42_473)).toBe("1 : 40,000");
    expect(formatScaleRatio(60_000)).toBe("1 : 60,000");
    expect(formatScaleRatio(8_494_678.4)).toBe("1 : 8,000,000");
    expect(formatScaleRatio(12.567)).toBe("1 : 13");
  });

  it("reverses controller direction and detents at the main default", () => {
    expect(scaleDenominatorAfterInput(60_000, 1, 1)).toBeLessThan(60_000);
    expect(scaleDenominatorAfterInput(60_000, -1, 1)).toBeGreaterThan(60_000);
    expect(scaleDenominatorAfterInput(61_000, 0, 1)).toBe(60_000);
  });
});
