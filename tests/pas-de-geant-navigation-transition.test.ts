import { describe, expect, it } from "vitest";
import {
  sampleAngleTransition,
  sampleScaleTransition,
  sampleWarpTransition,
} from "../apps/pas-de-geant/src/navigation-transition.js";

describe("timed navigation transitions", () => {
  it("eases a warp along the short great-circle route across the antimeridian", () => {
    const transition = {
      from: { latitudeDegrees: 0, longitudeDegrees: 170 },
      to: { latitudeDegrees: 0, longitudeDegrees: -170 },
      startedAtMs: 1_000,
      durationSeconds: 4,
    };

    expect(sampleWarpTransition(transition, 1_000)).toEqual({
      value: transition.from,
      complete: false,
    });
    const quarter = sampleWarpTransition(transition, 2_000);
    expect(quarter.value.latitudeDegrees).toBeCloseTo(0, 10);
    expect(quarter.value.longitudeDegrees).toBeCloseTo(173.125, 10);
    const halfway = sampleWarpTransition(transition, 3_000);
    expect(Math.abs(halfway.value.longitudeDegrees)).toBeCloseTo(180, 10);
    expect(sampleWarpTransition(transition, 5_000)).toEqual({
      value: transition.to,
      complete: true,
    });
  });

  it("interpolates scale logarithmically so equal ratios take equal time", () => {
    const transition = {
      from: 1,
      to: 100,
      startedAtMs: 0,
      durationSeconds: 2,
    };

    expect(sampleScaleTransition(transition, 0)).toEqual({
      value: 1,
      complete: false,
    });
    expect(sampleScaleTransition(transition, 1_000).value).toBeCloseTo(10, 12);
    const finished = sampleScaleTransition(transition, 2_000);
    expect(finished.value).toBe(100);
    expect(finished.complete).toBe(true);
  });

  it("turns through the shortest angle when a heading crosses north", () => {
    const transition = {
      from: 170 * Math.PI / 180,
      to: -170 * Math.PI / 180,
      startedAtMs: 0,
      durationSeconds: 2,
    };

    expect(sampleAngleTransition(transition, 0).value * 180 / Math.PI)
      .toBeCloseTo(170, 10);
    expect(Math.abs(
      sampleAngleTransition(transition, 1_000).value * 180 / Math.PI,
    )).toBeCloseTo(180, 10);
    expect(sampleAngleTransition(transition, 2_000)).toEqual({
      value: transition.to,
      complete: true,
    });
  });
});
