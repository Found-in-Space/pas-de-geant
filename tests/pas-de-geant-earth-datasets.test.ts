import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { resolveBodySurfaceDatasets } from "../packages/pas-de-geant/src/worlds/datasets.js";
import { ImageryVirtualTexture } from "../packages/pas-de-geant/src/worlds/imagery.js";
import { TerrainSurface } from "../packages/pas-de-geant/src/worlds/terrain-surface.js";

const binding = (name: string) => ({ productUrl: `https://fixtures.test/${name}/product.json`, urlTemplate: "./imagery/{z}/{x}/{y}.png", attribution: name });
function product(name: string, projection = "web-mercator") {
  return { format_version: 2, target: { id: "earth" }, product_identity_sha256: (name === "day" ? "a" : "b").repeat(64),
    grid: { formatVersion: 1, projection, radiusMetres: 6378137 },
    tiles: { addressing: "XYZ", matrix: "2^z x 2^z", opaque: true, format: "png", tile_size: 256, maximum_zoom: 9 },
    baseTexture: { projection: "equirectangular", path: "base.png", width: 4096, height: 2048, sha256: "c".repeat(64) } };
}
function fetcher(projection = "web-mercator") {
  return vi.fn<typeof fetch>(async input => Response.json(product(String(input).includes("/day/") ? "day" : "night", String(input).includes("/night/") ? projection : "web-mercator")));
}
const datasets = { imagery: binding("day"), nightImagery: binding("night") };

describe("day and night surface datasets", () => {
  it("admits both sources before loading their equirectangular bases and keeps provider caches distinct", async () => {
    const fallback = new THREE.Texture(), day = new THREE.Texture(), night = new THREE.Texture();
    const dispose = vi.spyOn(fallback, "dispose"), fetch = fetcher();
    const loadTexture = vi.fn(async (url: string) => {
      expect(fetch).toHaveBeenCalledTimes(2);
      return url.includes("/day/") ? day : night;
    });
    const source = await resolveBodySurfaceDatasets({ body: "earth", datasets, baseTexture: fallback, disposeBaseTexture: true, fetcher: fetch, loadTexture });
    expect(source.baseTexture).toBe(day); expect(source.nightTexture).toBe(night);
    expect(source.disposeBaseTexture).toBe(true); expect(source.disposeNightTexture).toBe(true);
    expect(source.imageryProvider?.id).not.toBe(source.nightImageryProvider?.id);
    expect(loadTexture.mock.calls.map(([url]) => url)).toEqual(["https://fixtures.test/day/base.png", "https://fixtures.test/night/base.png"]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects incompatible grids before acquiring either base texture", async () => {
    const loadTexture = vi.fn(async () => new THREE.Texture());
    await expect(resolveBodySurfaceDatasets({ body: "earth", datasets, baseTexture: new THREE.Texture(), fetcher: fetcher("geographic"), loadTexture }))
      .rejects.toThrow("different body grids");
    expect(loadTexture).not.toHaveBeenCalled();
  });

  it("retains the disconnected day fallback and emits black if the night base cannot load", async () => {
    const fallback = new THREE.Texture(), dispose = vi.spyOn(fallback, "dispose");
    const source = await resolveBodySurfaceDatasets({ body: "earth", datasets, baseTexture: fallback, disposeBaseTexture: true,
      fetcher: fetcher(), loadTexture: async () => { throw new Error("offline"); } });
    expect(source.baseTexture).toBe(fallback); expect(source.baseFallback).toBe(true);
    expect((source.nightTexture as THREE.DataTexture).image.data).toEqual(new Uint8Array([0, 0, 0, 255]));
    expect(dispose).not.toHaveBeenCalled();
    expect(source.imageryProvider).toBeDefined(); expect(source.nightImageryProvider).toBeDefined();
  });

  it("releases an acquired day base on cancellation without taking the caller's fallback", async () => {
    const abort = new AbortController(), day = new THREE.Texture(), fallback = new THREE.Texture();
    const dayDispose = vi.spyOn(day, "dispose"), fallbackDispose = vi.spyOn(fallback, "dispose");
    await expect(resolveBodySurfaceDatasets({ body: "earth", datasets, baseTexture: fallback, signal: abort.signal, fetcher: fetcher(),
      loadTexture: async url => { if (url.includes("/day/")) return day; abort.abort(); throw abort.signal.reason; } }))
      .rejects.toThrow();
    expect(dayDispose).toHaveBeenCalledOnce(); expect(fallbackDispose).not.toHaveBeenCalled();
  });

  it("namespaces material uniforms while preserving shared live updates and independent per-mesh transforms", () => {
    const imagery = Object.create(ImageryVirtualTexture.prototype) as any;
    imagery.sharedUniforms = { imageryEnabled: new THREE.Uniform(0), blueMarbleMap: new THREE.Uniform(new THREE.Texture()) };
    const day = imagery.materialUniforms(), night = imagery.materialUniforms("night");
    expect(night.nightImageryEnabled).toBe(day.imageryEnabled);
    day.imageryEnabled.value = 1; expect(night.nightImageryEnabled.value).toBe(1);
    const material = new THREE.ShaderMaterial({ uniforms: { ...day, ...night } });
    imagery.configureMaterial(material, { west: 0.5, east: 0.75, north: 0.25, south: 0.5 }, "night");
    expect(night.nightImageryGlobalOriginScale.value.toArray()).toEqual([0.5, 0.25, 0.25, 0.25]);
    expect(day.imageryGlobalOriginScale.value.toArray()).toEqual([0, 0, 0, 1]);
  });

  it("publishes and suspends both layers and waits for night readiness", () => {
    const surface = Object.create(TerrainSurface.prototype) as any;
    surface.imagery = { processFrame: vi.fn(), setLoadingSuspended: vi.fn(), hasCompleteImagery: true, hasFailure: false };
    surface.nightImagery = { processFrame: vi.fn(), setLoadingSuspended: vi.fn(), hasCompleteImagery: false, hasFailure: false };
    surface.scheduler = { setSuspended: vi.fn() }; surface.loadingSuspended = false;
    expect(surface.hasCompleteImagery).toBe(false);
    surface.nightImagery.hasCompleteImagery = true; expect(surface.hasCompleteImagery).toBe(true);
    surface.nightImagery.hasFailure = true; expect(surface.hasImageryFailure).toBe(true);
    surface.processFrame(); surface.setLoadingSuspended(true);
    for (const layer of [surface.imagery, surface.nightImagery]) {
      expect(layer.processFrame).toHaveBeenCalledOnce(); expect(layer.setLoadingSuspended).toHaveBeenCalledWith(true);
    }
  });
});

describe("Three r170 imagery pool uploads", () => {
  it("uploads each mip at its own destination level without overwriting the base", () => {
    const imagery = Object.create(ImageryVirtualTexture.prototype) as any;
    imagery.paddedSize = 4; imagery.stagingTexture = new THREE.DataTexture(); imagery.uploadTotal = 0;
    const destination = new Map<number, { width: number; value: number }>();
    // Match the installed Three r170 API: the fifth argument is the mip level.
    imagery.renderer = { copyTextureToTexture(source: THREE.DataTexture, _target: unknown, _region: unknown, _position: unknown, level = 0) {
      destination.set(level, { width: source.image.width, value: source.image.data![0]! });
    } };
    const levels = [4, 2, 1].map((size, index) => ({ width: size, height: size, pixels: new Uint8Array(size * size * 4).fill(index + 1) }));
    expect(imagery.uploadMipChain({ texture: new THREE.DataArrayTexture() }, 2, levels)).toBe(true);
    expect([...destination.entries()]).toEqual([[0, { width: 4, value: 1 }], [1, { width: 2, value: 2 }], [2, { width: 1, value: 3 }]]);
  });
});
