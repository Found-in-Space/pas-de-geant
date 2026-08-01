import { describe, expect, it } from "vitest";
import {
  observerTileZoom,
  projectedFocalLengthPixels,
} from "../apps/pas-de-geant/src/observer-tile-zoom.js";
import { EARTH_MEAN_RADIUS_KM } from "../apps/pas-de-geant/src/tile-onion-core.js";

describe("Observer-driven tile zoom", () => {
  it("coarsens monotonically as radial altitude increases", () => {
    const zooms = [10, 100, 1_000, 10_000].map((observerHeightMeters) =>
      observerTileZoom({
        observerHeightMeters,
        latitudeDegrees: 0,
        projectedFocalLengthPixels: 1_000,
        tilePixels: 512,
      }).continuousZoom,
    );

    for (let index = 1; index < zooms.length; index += 1) {
      expect(zooms[index]).toBeLessThan(zooms[index - 1]!);
      expect(zooms[index - 1]! - zooms[index]!).toBeCloseTo(Math.log2(10), 12);
    }
  });

  it("moves exactly one level coarser when tile resolution doubles", () => {
    const shared = {
      observerHeightMeters: 12_000,
      latitudeDegrees: 23,
      projectedFocalLengthPixels: 940,
    };
    const pixels256 = observerTileZoom({ ...shared, tilePixels: 256 });
    const pixels512 = observerTileZoom({ ...shared, tilePixels: 512 });

    expect(pixels512.continuousZoom).toBeCloseTo(
      pixels256.continuousZoom - 1,
      12,
    );
    expect(pixels512.zoom).toBe(pixels256.zoom - 1);
  });

  it("accounts for the shrinking east-west span at latitude", () => {
    const shared = {
      observerHeightMeters: 4_000,
      projectedFocalLengthPixels: 800,
      tilePixels: 512,
    };
    const equator = observerTileZoom({ ...shared, latitudeDegrees: 0 });
    const sixtyNorth = observerTileZoom({ ...shared, latitudeDegrees: 60 });

    expect(sixtyNorth.continuousZoom).toBeCloseTo(
      equator.continuousZoom - 1,
      12,
    );
    expect(sixtyNorth.zoom).toBe(equator.zoom - 1);
  });

  it("maps an exact projection scale to its matching integer level", () => {
    const tilePixels = 512;
    const exactZoom = 10;
    const result = observerTileZoom({
      observerHeightMeters: EARTH_MEAN_RADIUS_KM * 1_000,
      latitudeDegrees: 0,
      projectedFocalLengthPixels: tilePixels * 2 ** exactZoom / (2 * Math.PI),
      tilePixels,
    });

    expect(result.continuousZoom).toBeCloseTo(exactZoom, 12);
    expect(result.zoom).toBe(exactZoom);
    expect(projectedFocalLengthPixels(1_000, 90)).toBeCloseTo(500, 12);
  });
});
