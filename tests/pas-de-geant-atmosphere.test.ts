import { describe, expect, it } from "vitest";
import {
  ATMOSPHERE_TOP_KM,
  atmosphereSurfacePoint,
} from "../apps/pas-de-geant/src/atmosphere.js";
import {
  EARTH_MEAN_RADIUS_KM,
  INITIAL_DISPLAY_RADIUS_M,
  WGS84_A_KM,
  WGS84_B_KM,
  radialWorldMetresForKilometres,
} from "../apps/pas-de-geant/src/planet-state.js";

describe("Pas de Géant atmosphere scale", () => {
  it("starts on the sea-level WGS84 oblate spheroid", () => {
    const equator = atmosphereSurfacePoint(0, 0, 0);
    const pole = atmosphereSurfacePoint(90, 0, 0);

    expect(equator.x).toBeCloseTo(WGS84_A_KM / EARTH_MEAN_RADIUS_KM);
    expect(pole.y).toBeCloseTo(WGS84_B_KM / EARTH_MEAN_RADIUS_KM);
    expect(equator.x).toBeGreaterThan(pole.y);
  });

  it("places its 100 km top through the shared radial scale", () => {
    const base = atmosphereSurfacePoint(0, 0, 0);
    for (const multiplier of [1, 20]) {
      const top = atmosphereSurfacePoint(0, 0, multiplier);
      expect(top.x - base.x).toBeCloseTo(
        ATMOSPHERE_TOP_KM * multiplier / EARTH_MEAN_RADIUS_KM,
      );
      expect((top.x - base.x) * INITIAL_DISPLAY_RADIUS_M).toBeCloseTo(
        radialWorldMetresForKilometres(
          ATMOSPHERE_TOP_KM,
          INITIAL_DISPLAY_RADIUS_M,
          multiplier,
        ),
      );
    }
  });
});
