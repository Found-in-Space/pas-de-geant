import { describe, expect, it } from "vitest";
import {
  ATMOSPHERE_TOP_KM,
  AtmosphereLayer,
} from "../apps/pas-de-geant/src/atmosphere.js";
import { EARTH_MEAN_RADIUS_KM } from "../packages/pas-de-geant/src/worlds/planet-state.js";

describe("Pas de Geant atmosphere", () => {
  it("uses global scale for its height and exterior-halo visibility", () => {
    const atmosphere = new AtmosphereLayer();
    const displayRadiusM = EARTH_MEAN_RADIUS_KM / ATMOSPHERE_TOP_KM;

    atmosphere.update({
      displayRadiusM,
      observerHeightWorldM: 1.01,
    });
    expect(atmosphere.mesh.visible).toBe(true);
    expect(
      atmosphere.mesh.material.uniforms.bodyLocalAtmosphereOffset!.value,
    ).toBeCloseTo(ATMOSPHERE_TOP_KM / EARTH_MEAN_RADIUS_KM, 10);

    atmosphere.update({
      displayRadiusM,
      observerHeightWorldM: 1,
    });
    expect(atmosphere.mesh.visible).toBe(false);

    atmosphere.update({
      displayRadiusM: displayRadiusM / 2,
      observerHeightWorldM: 1,
    });
    expect(atmosphere.mesh.visible).toBe(true);
  });
});
