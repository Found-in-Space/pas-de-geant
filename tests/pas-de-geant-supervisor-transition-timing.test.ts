import { describe, expect, it } from "vitest";
import {
  UI_SCALE_TRANSITION_SECONDS,
  uiTransitionTimeForHeadsetDistance,
  uiWarpTransitionTime,
} from "../apps/pas-de-geant/src/supervisor-transition-timing.js";

describe("supervisor automatic transition timing", () => {
  it("uses the long warp duration only above five metres in headset space", () => {
    expect(uiTransitionTimeForHeadsetDistance(5)).toBe(1);
    expect(uiTransitionTimeForHeadsetDistance(5.001)).toBe(2.5);
  });

  it("always gives scale changes 2.5 seconds", () => {
    expect(UI_SCALE_TRANSITION_SECONDS).toBe(2.5);
  });

  it("measures warp arcs at the current displayed radius", () => {
    const target = { latitudeDegrees: 0, longitudeDegrees: 90 };

    expect(uiWarpTransitionTime({
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      displayRadiusM: 3,
    }, target)).toBe(1);
    expect(uiWarpTransitionTime({
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      displayRadiusM: 10,
    }, target)).toBe(2.5);
  });
});
