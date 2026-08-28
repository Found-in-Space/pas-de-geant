import { describe, expect, it } from "vitest";
import {
  observerTileZoom,
  projectedFocalLengthPixels,
  selectZoomWithVerticalHysteresis,
} from "../apps/pas-de-geant/src/observer-tile-zoom.js";

function observerAtBoundary(
  boundaryHeightWorldM: number,
  lowerZoom: number,
  observerHeightWorldM: number,
  previousZoom?: number,
) {
  return observerTileZoom({
    observerHeightWorldM,
    displayRadiusM:
      boundaryHeightWorldM * 2 ** (lowerZoom + 0.5) / (2 * Math.PI),
    latitudeDegrees: 0,
    projectedFocalLengthPixels: 512,
    tilePixels: 512,
    previousZoom,
  });
}

describe("Observer-driven tile zoom", () => {
  it("coarsens monotonically as radial altitude increases", () => {
    const zooms = [10, 100, 1_000, 10_000].map((observerHeightWorldM) =>
      observerTileZoom({
        observerHeightWorldM,
        displayRadiusM: 1_000,
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
      observerHeightWorldM: 12,
      displayRadiusM: 1_000,
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
      observerHeightWorldM: 4,
      displayRadiusM: 1_000,
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
      observerHeightWorldM: 1,
      displayRadiusM: 1,
      latitudeDegrees: 0,
      projectedFocalLengthPixels: tilePixels * 2 ** exactZoom / (2 * Math.PI),
      tilePixels,
    });

    expect(result.continuousZoom).toBeCloseTo(exactZoom, 12);
    expect(result.zoom).toBe(exactZoom);
    expect(projectedFocalLengthPixels(1_000, 90)).toBeCloseTo(500, 12);
  });

  it("retains a refined level until the eye rises twenty centimetres past its boundary", () => {
    const boundaryHeightWorldM = 1.5;
    const lowerZoom = 10;
    const coarse = observerAtBoundary(
      boundaryHeightWorldM,
      lowerZoom,
      boundaryHeightWorldM + 0.01,
    ).zoom;
    const refined = observerAtBoundary(
      boundaryHeightWorldM,
      lowerZoom,
      boundaryHeightWorldM - 0.01,
      coarse,
    ).zoom;

    expect(coarse).toBe(lowerZoom);
    expect(refined).toBe(lowerZoom + 1);
    expect(observerAtBoundary(
      boundaryHeightWorldM,
      lowerZoom,
      boundaryHeightWorldM + 0.199,
      refined,
    ).zoom).toBe(refined);
    expect(observerAtBoundary(
      boundaryHeightWorldM,
      lowerZoom,
      boundaryHeightWorldM + 0.201,
      refined,
    ).zoom).toBe(lowerZoom);
  });

  it("uses the same twenty-centimetre separation at different display scales", () => {
    for (const boundaryHeightWorldM of [0.8, 1.6, 3.2]) {
      const lowerZoom = 9;
      const refined = observerAtBoundary(
        boundaryHeightWorldM,
        lowerZoom,
        boundaryHeightWorldM - 0.001,
        lowerZoom,
      ).zoom;
      expect(observerAtBoundary(
        boundaryHeightWorldM,
        lowerZoom,
        boundaryHeightWorldM + 0.199,
        refined,
      ).zoom).toBe(refined);
      expect(observerAtBoundary(
        boundaryHeightWorldM,
        lowerZoom,
        boundaryHeightWorldM + 0.201,
        refined,
      ).zoom).toBe(lowerZoom);
    }
  });

  it("does not churn levels during a repeated ten-centimetre head movement", () => {
    const boundaryHeightWorldM = 1.5;
    const lowerZoom = 10;
    let zoom = lowerZoom;
    for (const observerHeightWorldM of [
      boundaryHeightWorldM - 0.01,
      boundaryHeightWorldM + 0.09,
      boundaryHeightWorldM - 0.01,
      boundaryHeightWorldM + 0.09,
    ]) {
      zoom = observerAtBoundary(
        boundaryHeightWorldM,
        lowerZoom,
        observerHeightWorldM,
        zoom,
      ).zoom;
      expect(zoom).toBe(lowerZoom + 1);
    }
  });

  it("supports multi-level changes, detail floors, caps, and zoom zero", () => {
    expect(selectZoomWithVerticalHysteresis({
      continuousZoom: 8.6,
      observerHeightWorldM: 1,
      previousZoom: 2,
    })).toBe(9);
    expect(selectZoomWithVerticalHysteresis({
      continuousZoom: Number.NEGATIVE_INFINITY,
      minimumContinuousZoom: 5.6,
      observerHeightWorldM: 1,
      previousZoom: 8,
    })).toBe(6);
    expect(selectZoomWithVerticalHysteresis({
      continuousZoom: 8.6,
      observerHeightWorldM: 1,
      previousZoom: 2,
      maximumZoom: 4,
    })).toBe(4);
    expect(selectZoomWithVerticalHysteresis({
      continuousZoom: 1.2,
      observerHeightWorldM: 1,
      previousZoom: 2,
      minimumZoom: 3,
    })).toBe(3);
    expect(selectZoomWithVerticalHysteresis({
      continuousZoom: Number.NEGATIVE_INFINITY,
      observerHeightWorldM: 1,
      previousZoom: 0,
    })).toBe(0);
  });
});
