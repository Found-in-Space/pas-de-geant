import { describe, expect, it } from "vitest";
import {
  flatSurfaceObserverHeightMetres,
  imageryUvForGeographicPoint,
  sampleTerrariumElevationMetres,
  sourceUvForTilePoint,
  terrainTargetForView,
} from "../apps/pas-de-geant/src/terrain-surface.js";
import {
  decodeHeightMetres,
  EARTH_SURFACE_MODEL,
  MOON_SURFACE_MODEL,
} from "../apps/pas-de-geant/src/surface-model.js";
import {
  elevationSourceZoomForTile,
} from "../apps/pas-de-geant/src/terrain-lod.js";

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

  it("keeps orbit topology scale-invariant while refining beyond source zoom", () => {
    const referenceRadiusM = EARTH_SURFACE_MODEL.referenceRadiusM;
    const targetAt = (physicalAltitudeM: number, scaleDenominator: number) =>
      terrainTargetForView({
        latitudeDegrees: 0,
        longitudeDegrees: 0,
        displayRadiusM: referenceRadiusM / scaleDenominator,
        terrainMultiplier: 1,
        observerHeightWorldM: physicalAltitudeM / scaleDenominator,
        focalLengthPixels: 1_000,
      }, EARTH_SURFACE_MODEL.elevationMetadata.tilePixels, {
        referenceRadiusM,
      });

    const tenKilometres = targetAt(10_000, 60_000);
    expect(targetAt(10_000, 120_000).maxZoom).toBe(
      tenKilometres.maxZoom,
    );

    const descendingTargets = [100_000, 10_000, 1_000].map((altitudeM) =>
      targetAt(altitudeM, 60_000).maxZoom
    );
    expect(descendingTargets[1]).toBeGreaterThan(descendingTargets[0]!);
    expect(descendingTargets[2]).toBeGreaterThan(descendingTargets[1]!);

    const closeOrbitZoom = descendingTargets[2]!;
    const maximumElevationSourceZoom =
      EARTH_SURFACE_MODEL.elevationMetadata.maxSourceZoom;
    expect(closeOrbitZoom).toBeGreaterThan(maximumElevationSourceZoom);
    expect(elevationSourceZoomForTile(
      { z: closeOrbitZoom },
      maximumElevationSourceZoom,
    )).toBe(maximumElevationSourceZoom);
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

  it("maps the lunar geographic pyramid through both poles", () => {
    const bounds = MOON_SURFACE_MODEL.tileBounds({ z: 1, x: 0, y: 0 });
    expect(bounds).toEqual({ west: -180, east: 0, north: 90, south: 0 });
    expect(imageryUvForGeographicPoint(
      bounds,
      45,
      -90,
      "geographic",
    )).toEqual({ u: 0.5, v: 0.5 });
  });

  it("decodes the lossless red/green LOLA height representation", () => {
    expect(decodeHeightMetres(MOON_SURFACE_MODEL.heightEncoding, 78, 32, 0))
      .toBe(0);
    expect(decodeHeightMetres(MOON_SURFACE_MODEL.heightEncoding, 0, 0, 0))
      .toBe(-10_000);
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
