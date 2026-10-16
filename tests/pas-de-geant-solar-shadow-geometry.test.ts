import { describe, expect, it } from "vitest";
import { celestialBody } from "../packages/pas-de-geant/src/worlds/solar-system.js";
import {
  calculateSolarShadowGeometry,
} from "../apps/pas-de-geant/src/solar-shadow-geometry.js";

describe("universal Sun–Moon shadow geometry", () => {
  it("reproduces the 2026 total eclipse from the shared body ephemeris", () => {
    const geometry = calculateSolarShadowGeometry(
      new Date("2026-08-12T17:45:46.794Z"),
    );
    const earthRadiusM = celestialBody("earth").referenceRadiusM;
    const sunAngularRadius = Math.asin(
      celestialBody("sun").referenceRadiusM / geometry.sunEarthDistanceM,
    );
    const moonAngularRadius = Math.asin(
      celestialBody("moon").referenceRadiusM / geometry.moonEarthDistanceM,
    );

    expect(geometry.axisDistanceToEarthPlaneM).toBeGreaterThan(0);
    expect(geometry.axisMissDistanceM).toBeLessThan(earthRadiusM);
    expect(geometry.centralConeRadiusAtEarthPlaneM).toBeGreaterThan(0);
    expect(geometry.penumbraConeRadiusAtEarthPlaneM).toBeGreaterThan(
      geometry.centralConeRadiusAtEarthPlaneM,
    );
    expect(Math.abs(sunAngularRadius - moonAngularRadius)).toBeLessThan(0.0005);
  });

  it("does not report an Earth intersection for an ordinary lunar phase", () => {
    const geometry = calculateSolarShadowGeometry(
      new Date("2026-08-20T12:00:00Z"),
    );
    expect(geometry.axisMissDistanceM).toBeGreaterThan(
      celestialBody("earth").referenceRadiusM * 10,
    );
  });
});
