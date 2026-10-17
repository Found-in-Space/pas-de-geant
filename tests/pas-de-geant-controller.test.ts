import {
  orbitalAngularStepRadians,
  orbitalDragRadiansPerPixel,
  orbitalLogarithmicValue,
  shapedOrbitalAxis,
  applyTerrainMultiplierRate,
  scaleDenominatorAfterInput,
  dominantStickAxes,
  headRelativeTravel,
  isHandTrackingInputSource,
} from "@found-in-space/pas-de-geant";
import * as THREE from "three";
import { describe, expect, it } from "vitest";





describe("Pas de Géant controller regressions", () => {
  it("distinguishes controller input from articulated hand tracking", () => {
    const controller = {
      profiles: ["oculus-touch-v3"],
    } as unknown as XRInputSource;
    const profileOnlyHand = {
      profiles: ["generic-hand-select"],
    } as unknown as XRInputSource;
    const jointTrackedHand = {
      hand: {},
      profiles: [],
    } as unknown as XRInputSource;

    expect(isHandTrackingInputSource(controller)).toBe(false);
    expect(isHandTrackingInputSource(profileOnlyHand)).toBe(true);
    expect(isHandTrackingInputSource(jointTrackedHand)).toBe(true);
  });

  it("rotates travel with headset yaw while ignoring pitch", () => {
    const lookingEast = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-0.7, -Math.PI / 2, 0, "YXZ"),
    );
    const travel = headRelativeTravel(
      new THREE.Vector2(0, -1),
      lookingEast,
    );
    expect(travel.x).toBeCloseTo(1);
    expect(travel.y).toBeCloseTo(0);
  });

  it("keeps global scale unbounded and terrain amplification non-negative", () => {
    expect(scaleDenominatorAfterInput(60_000, 1, 10)).toBeLessThan(60_000);
    expect(applyTerrainMultiplierRate(20, 1, 1)).toBeGreaterThan(20);
    expect(applyTerrainMultiplierRate(0, -1, 1)).toBe(0);
  });

  it("uses calm cubic orbital response with four-second doubling", () => {
    expect(shapedOrbitalAxis(0.5)).toBeCloseTo(0.125, 12);
    expect(THREE.MathUtils.radToDeg(
      orbitalAngularStepRadians(1, 1, false),
    )).toBeCloseTo(20, 12);
    expect(orbitalLogarithmicValue(3, 1, 4, false)).toBeCloseTo(6, 12);
    expect(orbitalLogarithmicValue(3, -1, 4, false)).toBeCloseTo(1.5, 12);
  });

  it("reduces pointer orbit travel in proportion to surface altitude", () => {
    const far = orbitalDragRadiansPerPixel(3_000, 1_000, 1_000, 0.004);
    const near = orbitalDragRadiansPerPixel(1_010, 1_000, 1_000, 0.004);

    expect(far).toBeCloseTo(0.002, 12);
    expect(near).toBeCloseTo(0.00001, 12);
    expect(orbitalDragRadiansPerPixel(10_000, 1_000, 1_000, 0.004))
      .toBe(0.004);
  });

  it("latches a diagonal right stick to one orbital function", () => {
    const altitude = dominantStickAxes(0.8, 0.6, null);
    expect(altitude).toEqual({
      horizontal: 0.8,
      vertical: 0,
      latched: "horizontal",
    });
    expect(dominantStickAxes(0.2, 0.9, altitude.latched)).toEqual({
      horizontal: 0.2,
      vertical: 0,
      latched: "horizontal",
    });
    expect(dominantStickAxes(0, 0, altitude.latched).latched).toBeNull();
  });
});
