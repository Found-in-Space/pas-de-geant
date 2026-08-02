import { describe, expect, it } from "vitest";
import {
  ATMOSPHERE_TOP_KM,
  AtmosphereLayer,
} from "../apps/pas-de-geant/src/atmosphere.js";
import { EARTH_MEAN_RADIUS_KM } from "../apps/pas-de-geant/src/planet-state.js";

describe("Pas de Geant atmosphere", () => {
  it("only renders the exterior halo while the observer is above it", () => {
    const atmosphere = new AtmosphereLayer();
    const displayRadiusM = EARTH_MEAN_RADIUS_KM / ATMOSPHERE_TOP_KM;

    atmosphere.update({
      displayRadiusM,
      radialMultiplier: 1,
      observerHeightWorldM: 1.01,
    });
    expect(atmosphere.mesh.visible).toBe(true);

    atmosphere.update({
      displayRadiusM,
      radialMultiplier: 1,
      observerHeightWorldM: 1,
    });
    expect(atmosphere.mesh.visible).toBe(false);

    atmosphere.update({
      displayRadiusM: displayRadiusM / 2,
      radialMultiplier: 2,
      observerHeightWorldM: 1,
    });
    expect(atmosphere.mesh.visible).toBe(false);
  });
});
