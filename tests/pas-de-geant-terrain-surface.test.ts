import { describe, expect, it } from "vitest";
import {
  imageryUvForGeographicPoint,
  TerrainSurface,
  sampleTerrariumElevationMetres,
  sourceUvForTilePoint,
  terrainTargetForView,
} from "@found-in-space/worlds/terrain-surface";
import {
  decodeHeightMetres,
  EARTH_SURFACE_MODEL,
  MOON_SURFACE_MODEL,
  MOON_GEOGRAPHIC_SURFACE_MODEL,
} from "@found-in-space/worlds/surface-model";
import {
  elevationSourceZoomForTile,
} from "@found-in-space/worlds/terrain-lod";

describe("Terrain surface composition", () => {
  it("samples loaded fine terrain while a coarser target is still awaiting publication", () => {
    const surface = Object.create(TerrainSurface.prototype) as any;
    surface.surfaceModel = MOON_GEOGRAPHIC_SURFACE_MODEL;
    surface.currentTarget = { maxZoom: 0 };
    surface.maximumMeshZoom = 12;
    const encoding = MOON_GEOGRAPHIC_SURFACE_MODEL.heightEncoding;
    const encodedHeight = encoding.kind === "rg16"
      ? (-1_927.5 - encoding.offsetM) / encoding.scaleM
      : -1_927.5 + 32_768;
    const pixels = { data: new Uint8ClampedArray([
      Math.floor(encodedHeight / 256), Math.floor(encodedHeight) % 256,
      Math.round((encodedHeight % 1) * 256), 255,
    ]), width: 1, height: 1 };
    surface.pixelsForElevation = () => pixels;
    const tile = { z: 12, x: 2315, y: 2032 };
    const bounds = MOON_GEOGRAPHIC_SURFACE_MODEL.tileBounds(tile);
    const latitude = (bounds.north + bounds.south) / 2;
    const longitude = (bounds.west + bounds.east) / 2;
    const elevation = { image: {}, sourceScale: 1, sourceOffsetX: 0, sourceOffsetY: 0 };
    surface.meshes = new Map([["12/2315/2032", { tile, elevation }]]);
    expect(surface.sampleElevationMetres(latitude, longitude)).toBe(-1_927.5);
    // A visible no-data child must stay flat even if its ancestor has relief.
    surface.meshes.get("12/2315/2032").elevation = undefined;
    surface.meshes.set("0/0/0", { tile: { z: 0, x: 0, y: 0 }, elevation });
    expect(surface.sampleElevationMetres(latitude, longitude)).toBe(0);
    surface.meshes.delete("12/2315/2032");
    expect(surface.sampleElevationMetres(latitude, longitude)).toBe(-1_927.5);
  });

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
      }, EARTH_SURFACE_MODEL.elevationMetadata.tilePixels);

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

  it("selects terrain from displayed body size rather than an Earth radius", () => {
    const scaleDenominator = 60_000;
    const shared = {
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      terrainMultiplier: 1,
      observerHeightWorldM: 1.65,
      focalLengthPixels: 1_000,
    };
    const earth = terrainTargetForView({
      ...shared,
      displayRadiusM:
        EARTH_SURFACE_MODEL.referenceRadiusM / scaleDenominator,
    }, EARTH_SURFACE_MODEL.elevationMetadata.tilePixels);
    const moon = terrainTargetForView({
      ...shared,
      displayRadiusM:
        MOON_SURFACE_MODEL.referenceRadiusM / scaleDenominator,
      projection: "geographic",
    }, MOON_SURFACE_MODEL.elevationMetadata.tilePixels, {
      projection: "geographic",
    });

    expect(moon.maxZoom).toBeLessThan(earth.maxZoom);
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
    const bounds = MOON_GEOGRAPHIC_SURFACE_MODEL.tileBounds({ z: 1, x: 0, y: 0 });
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
