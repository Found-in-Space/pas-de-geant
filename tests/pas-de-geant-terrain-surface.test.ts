import { describe, expect, it } from "vitest";
import {
  flatSurfaceObserverHeightMetres,
  imageryUvForGeographicPoint,
  sampleTerrariumElevationMetres,
  sourceUvForTilePoint,
} from "../apps/pas-de-geant/src/terrain-surface.js";

describe("Terrain surface composition", () => {
  it("maps adjacent overzoom children to the same source coordinate at their join", () => {
    const westChild = {
      sourceScale: 2,
      sourceOffsetX: 0,
      sourceOffsetY: 0,
    };
    const eastChild = {
      sourceScale: 2,
      sourceOffsetX: 1,
      sourceOffsetY: 0,
    };
    const northChild = westChild;
    const southChild = {
      sourceScale: 2,
      sourceOffsetX: 0,
      sourceOffsetY: 1,
    };

    expect(sourceUvForTilePoint(westChild, 1, 0.37)).toEqual(
      sourceUvForTilePoint(eastChild, 0, 0.37),
    );
    expect(sourceUvForTilePoint(northChild, 0.42, 0)).toEqual(
      sourceUvForTilePoint(southChild, 0.42, 1),
    );
  });

  it("derives physical observer height only from flat-surface scale", () => {
    const first = flatSurfaceObserverHeightMetres(1.65, 64);
    const sameScaleRatio = flatSurfaceObserverHeightMetres(3.3, 128);
    const higherObserver = flatSurfaceObserverHeightMetres(3.3, 64);

    expect(sameScaleRatio).toBeCloseTo(first, 12);
    expect(higherObserver).toBeCloseTo(first * 2, 12);
  });

  it("maps photographic pages in Web Mercator rather than equirectangular latitude", () => {
    const uv = imageryUvForGeographicPoint(
      { west: -180, east: 180, north: 85, south: -85 },
      60,
      0,
    );
    const equirectangularV = (85 - 60) / 170;

    expect(uv.u).toBeCloseTo(0.5);
    expect(uv.v).not.toBeCloseTo(equirectangularV, 2);
    expect(uv.v).toBeGreaterThan(0);
    expect(uv.v).toBeLessThan(0.5);
  });

  it("samples the same bilinear Terrarium heights used by the terrain shader", () => {
    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    const writeElevation = (index: number, elevationMetres: number): void => {
      const encoded = elevationMetres + 32_768;
      pixels[index * 4] = Math.floor(encoded / 256);
      pixels[index * 4 + 1] = Math.floor(encoded) % 256;
      pixels[index * 4 + 2] = Math.round((encoded % 1) * 256);
      pixels[index * 4 + 3] = 255;
    };
    writeElevation(0, 100);
    writeElevation(1, 200);
    writeElevation(2, 300);
    writeElevation(3, 400);

    expect(sampleTerrariumElevationMetres(pixels, 2, 2, 0.25, 0.75)).toBe(100);
    expect(sampleTerrariumElevationMetres(pixels, 2, 2, 0.75, 0.25)).toBe(400);
    expect(sampleTerrariumElevationMetres(pixels, 2, 2, 0.5, 0.5)).toBe(250);
  });
});
