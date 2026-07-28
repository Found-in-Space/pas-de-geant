import { describe, expect, it } from "vitest";
import {
  AU_KM,
  magnitude,
  scale,
  subtract,
} from "@found-in-space/shadowline";
import { AstronomyEngineProvider } from "@found-in-space/shadowline-astronomy-engine";
import {
  earthFixedToEquatorialJ2000Basis,
  rotateWithBasis,
} from "../apps/visualizer/src/celestial-frame.js";

describe("sun-centric display frame adapter", () => {
  const provider = new AstronomyEngineProvider();
  const atUtc = "2026-08-12T17:45:46.794Z";

  it("rotates Earth-fixed ephemeris vectors into Earth-centred J2000", () => {
    const basis = earthFixedToEquatorialJ2000Basis(atUtc);
    for (const body of ["sun", "moon"] as const) {
      const earthFixedKm = scale(
        provider.stateVector(
          body,
          atUtc,
          "geocentric-earth-fixed",
        ).positionAu,
        AU_KM,
      );
      const expectedJ2000Km = scale(
        provider.stateVector(
          body,
          atUtc,
          "geocentric-equatorial-j2000",
        ).positionAu,
        AU_KM,
      );
      const actualJ2000Km = rotateWithBasis(basis, earthFixedKm);
      expect(
        magnitude(subtract(actualJ2000Km, expectedJ2000Km)),
      ).toBeLessThan(1e-5);
    }
  });

  it("returns an orthonormal right-handed basis", () => {
    const basis = earthFixedToEquatorialJ2000Basis(atUtc);
    for (const vector of [basis.x, basis.y, basis.z]) {
      expect(magnitude(vector)).toBeCloseTo(1, 12);
    }
    const dot = (
      left: typeof basis.x,
      right: typeof basis.x,
    ) => left.x * right.x + left.y * right.y + left.z * right.z;
    expect(dot(basis.x, basis.y)).toBeCloseTo(0, 12);
    expect(dot(basis.x, basis.z)).toBeCloseTo(0, 12);
    expect(dot(basis.y, basis.z)).toBeCloseTo(0, 12);
  });
});
