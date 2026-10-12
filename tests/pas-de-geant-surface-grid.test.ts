import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tileGrid, tileGridKey, productTileGrid, surfaceSourceUrl } from "../packages/worlds/src/tile-grid.js";
import { tileBounds, projectedTilePoint } from "../packages/worlds/src/tile-onion-core.js";
import { celestialBody } from "../packages/worlds/src/solar-system.js";
import { displayTextureSource, elevationSource, requireCompatibleSurfaceSources } from "../packages/worlds/src/surface-product.js";
import { geographicStudyPreview, type LunarPreviewProduct } from "../apps/pas-de-geant/src/lunar-preview-pyramid.js";
import { EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL } from "../packages/worlds/src/surface-model.js";
import { terrainPatchGeometry } from "../packages/worlds/src/terrain-surface.js";

const fixture = JSON.parse(readFileSync(new URL("./surface-grid.fixture.json", import.meta.url), "utf8"));
const moon = celestialBody("moon");
const mercator = { formatVersion: 1 as const, projection: "web-mercator" as const, radiusMetres: moon.shape.kind === "sphere" ? moon.shape.radiusM : 0 };
const hash = "a".repeat(64);
const display = () => ({ format_version: 2, product_identity_sha256: hash, target: { id: "moon" }, grid: mercator,
  tiles: { addressing: "XYZ", matrix: "2^z x 2^z", opaque: true, format: "png", tile_size: 512, maximum_zoom: 8 },
  baseTexture: { path: "base.png", projection: "equirectangular", width: 2048, height: 1024, sha256: hash } });
const height = () => ({ kind: "elevation-xyz", formatVersion: 2, identity: hash, target: "moon", grid: mercator,
  units: "metres", verticalDatum: { kind: "reference-surface", radiusMetres: mercator.radiusMetres },
  encoding: { kind: "rg16", scaleM: 0.5, offsetM: -10000 }, tileSize: 512, maximumZoom: 5,
  elevationBoundsMetres: { minimum: -10000, maximum: 22767.5 } });

describe("producer and consumer surface grid contract", () => {
  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL])("maps $id mesh heights onto the same nonlinear Mercator rows as imagery", (model) => {
    const bounds = tileBounds({ z: 1, x: 1, y: 0 });
    const geometry = terrainPatchGeometry(bounds, 8, 8, false, model);
    const elevationUvs = geometry.getAttribute("tileUv"), imageryUvs = geometry.getAttribute("imageryUv");
    for (let row = 0; row <= 8; row++) {
      const latitude = bounds.north + (bounds.south - bounds.north) * row / 8;
      const expected = (1 - Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) / Math.PI) / 2 * 2;
      for (let column = 0; column <= 8; column++) {
        const index = row * 9 + column;
        expect(elevationUvs.getX(index)).toBeCloseTo(column / 8, 6);
        expect(elevationUvs.getY(index)).toBeCloseTo(1 - expected, 6);
        expect(elevationUvs.getY(index) + imageryUvs.getY(index)).toBeCloseTo(1, 6);
      }
    }
    expect(elevationUvs.getY(2 * 9)).not.toBeCloseTo(0.75, 2);
    geometry.dispose();
  });
  it("matches generated bounds, nonlinear pixel centres, XYZ orientation and antimeridian wrapping", () => {
    for (const test of fixture.cases) {
      const grid = tileGrid(test.grid), address = test.address;
      const bounds = tileBounds(address, grid.projection);
      [bounds.west, bounds.south, bounds.east, bounds.north].forEach((value, i) => expect(value).toBeCloseTo(test.bounds[i], 10));
      for (let i = 0; i < test.pixelSize; i++) {
        const point = projectedTilePoint(test.latitudeCentres[i], test.longitudeCentres[i], address.z, grid.projection);
        expect(point.x - address.x).toBeCloseTo((i + 0.5) / test.pixelSize, 9);
        expect(point.y - address.y).toBeCloseTo((i + 0.5) / test.pixelSize, 9);
      }
      const parent = { z: Math.max(0, address.z - 2), x: Math.floor(address.x / 4), y: Math.floor(address.y / 4) };
      const factor = 2 ** (address.z - parent.z);
      const point = projectedTilePoint(test.latitudeCentres[0], test.longitudeCentres[0], parent.z, grid.projection);
      expect(point.x - parent.x).toBeCloseTo((address.x % factor + 0.5 / test.pixelSize) / factor, 9);
      expect(point.y - parent.y).toBeCloseTo((address.y % factor + 0.5 / test.pixelSize) / factor, 9);
    }
    expect(projectedTilePoint(0, 180, 8).x).toBe(projectedTilePoint(0, -180, 8).x);
  });

  it("admits the separate display and value-preserving height sources on one body grid", () => {
    const imagery = displayTextureSource(display(), moon), elevation = elevationSource(height(), moon);
    expect(imagery.basePath).toBe("base.png");
    expect(elevation.heightEncoding).toEqual({ kind: "rg16", scaleM: 0.5, offsetM: -10000 });
    expect(() => requireCompatibleSurfaceSources(imagery, elevation)).not.toThrow();
    expect(() => elevationSource(display(), moon)).toThrow();
    expect(() => displayTextureSource(height(), moon)).toThrow();
    expect(() => elevationSource({ ...height(), units: "kilometres" }, moon)).toThrow();
    expect(() => elevationSource({ ...height(), verticalDatum: { kind: "reference-surface", radiusMetres: 6378137 } }, moon)).toThrow();
  });

  it("preserves old geographic bytes and rejects missing, relabelled or mismatched grid identities", () => {
    const old = { ...display(), format_version: 1, grid: undefined };
    const legacy = displayTextureSource(old, moon);
    expect(legacy.grid.projection).toBe("geographic");
    expect(legacy.basePath).toBe("imagery/0/0/0.png");
    expect(tileGridKey(legacy.grid)).not.toBe(tileGridKey(mercator));
    expect(() => productTileGrid(1, mercator, mercator.radiusMetres)).toThrow();
    expect(() => displayTextureSource({ ...display(), grid: undefined }, moon)).toThrow();
    expect(() => displayTextureSource({ ...display(), grid: { ...mercator, radiusMetres: 6378137 } }, moon)).toThrow();
    expect(() => requireCompatibleSurfaceSources(legacy, elevationSource(height(), moon))).toThrow();
    expect(() => geographicStudyPreview({ formatVersion: 2, grid: mercator } as LunarPreviewProduct)).toThrow(/comparison page/);
  });

  it("requires an independent full-latitude base for version 2", () => {
    expect(() => displayTextureSource({ ...display(), baseTexture: undefined }, moon)).toThrow();
    expect(() => displayTextureSource({ ...display(), baseTexture: { ...display().baseTexture, path: "imagery/0/0/0.png" } }, moon)).toThrow();
    const earth = celestialBody("earth");
    const descriptor = { ...display(), target: { id: "earth" }, grid: { ...mercator, radiusMetres: 6378137 } };
    expect(displayTextureSource(descriptor, earth).grid.radiusMetres).toBe(6378137);
  });

  it("separates cached tile bytes across grid or product changes while preserving URL parameters", () => {
    const template = "https://tiles.test/imagery/{z}/{x}/{y}.png?style=gray#anchor";
    const first = surfaceSourceUrl(template, mercator, hash);
    const second = surfaceSourceUrl(template, { ...mercator, projection: "geographic" }, hash);
    expect(first).not.toBe(second);
    expect(first).not.toBe(surfaceSourceUrl(template, mercator, "b".repeat(64)));
    const url = new URL(first);
    expect(url.searchParams.get("style")).toBe("gray");
    expect(url.hash).toBe("#anchor");
    expect(url.searchParams.get("surface-product")).toContain(tileGridKey(mercator));
  });
});
