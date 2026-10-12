import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL, type SurfaceModel } from "@found-in-space/worlds/surface-model";
import { TerrainSurface, elevationBoundsForTile, sampleEncodedElevationMetres } from "@found-in-space/worlds/terrain-surface";
import { createTerrainRenderVisibilityEntry, TerrainRenderVisibility } from "@found-in-space/worlds/terrain-render-visibility";

function pixelsFor(model: SurfaceModel): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(16 * 16 * 4);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) {
    const height = x === 4 && y === 4 ? 10_000 : x === 15 && y === 15 ? 12_000 : x * 100 - y * 100 - 2_500;
    const value = model.heightEncoding.kind === "terrarium" ? height + 32_768 :
      (height - model.heightEncoding.offsetM) / model.heightEncoding.scaleM;
    const index = (y * 16 + x) * 4;
    pixels[index] = Math.floor(value / 256);
    pixels[index + 1] = value % 256;
    pixels[index + 3] = 255;
  }
  return pixels;
}

describe("measured elevation bounds ported from 34c4e33", () => {
  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL])("tightens $id target horizons while retaining high terrain under the global occluding shell", (model) => {
    const centre = model.positionAndNormal(0, 0.12 * 180 / Math.PI).position;
    const geometry = new THREE.SphereGeometry(0.0001, 4, 4);
    geometry.translate(centre.x, centre.y, centre.z);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    const group = new THREE.Group();
    group.add(mesh);
    group.updateMatrixWorld(true);
    const entry = createTerrainRenderVisibilityEntry(mesh, true, model.visibilityGeometry);
    const visibility = new TerrainRenderVisibility(group, { minimum: 0, maximum: model.referenceRadiusM / 100 }, model.visibilityGeometry);
    visibility.updateDisplacement(1, 1000);
    visibility.setEntries([entry]);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.00001, 10);
    camera.position.set(1.001 / model.visibilityGeometry.xzScale, 0, 0);
    camera.lookAt(centre);
    camera.updateMatrixWorld(true);
    visibility.update(camera);
    expect(mesh.visible).toBe(true);
    visibility.setElevationBounds(entry, { minimum: 0, maximum: 0 });
    visibility.update(camera);
    expect(mesh.visible).toBe(false);
    expect(visibility.metrics.horizonCulledCount).toBe(1);
    visibility.setElevationBounds(entry, { minimum: 0, maximum: model.referenceRadiusM / 100 });
    visibility.update(camera);
    expect(mesh.visible).toBe(true);
    expect(visibility.metrics.horizonCulledCount).toBe(0);
    geometry.dispose();
    mesh.material.dispose();
  });

  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL])(
    "covers every bilinear $id crop sample, including edge texels and negative heights",
    (model) => {
      const pixels = pixelsFor(model);
      for (const sourceScale of [1, 2, 4, 16]) {
        for (const sourceOffsetX of [0, sourceScale - 1]) for (const sourceOffsetY of [0, sourceScale - 1]) {
          const resource = { sourceScale, sourceOffsetX, sourceOffsetY };
          const bounds = elevationBoundsForTile(pixels, 16, 16, resource, model.heightEncoding);
          for (const u of [0, 0.01, 0.2, 0.5, 0.99, 1]) for (const v of [0, 0.01, 0.2, 0.5, 0.99, 1]) {
            const height = sampleEncodedElevationMetres(pixels, 16, 16,
              (sourceOffsetX + u) / sourceScale, (sourceScale - sourceOffsetY - 1 + v) / sourceScale, model.heightEncoding);
            expect(height).toBeGreaterThanOrEqual(bounds.minimum);
            expect(height).toBeLessThanOrEqual(bounds.maximum);
          }
        }
      }
      const crop = elevationBoundsForTile(pixels, 16, 16,
        { sourceScale: 4, sourceOffsetX: 0, sourceOffsetY: 0 }, model.heightEncoding);
      expect(crop.minimum).toBeLessThan(0);
      expect(crop.maximum).toBe(10_000); // Include contributing halo; exclude remote outlier.
    },
  );

  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL])(
    "caches $id source/crop bounds and releases bounds-only pixel buffers",
    async (model) => {
      const surface = Object.create(TerrainSurface.prototype) as any;
      surface.surfaceModel = model;
      surface.elevationPixels = new WeakMap();
      surface.transientElevationPixels = new WeakMap();
      surface.transientPixelReleases = new WeakSet();
      surface.elevationBoundsByImage = new WeakMap();
      surface.readElevationPixels = vi.fn(() => ({ data: pixelsFor(model), width: 16, height: 16 }));
      const image = {};
      const resource = { image, sourceScale: 4, sourceOffsetX: 0, sourceOffsetY: 0 };
      const first = surface.boundsForElevation(resource);
      expect(surface.boundsForElevation(resource)).toBe(first);
      surface.boundsForElevation({ ...resource, sourceOffsetX: 1 });
      expect(surface.readElevationPixels).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(surface.transientElevationPixels.has(image)).toBe(false);
      expect(surface.elevationPixels.has(image)).toBe(false);
      surface.boundsForElevation({ ...resource, sourceOffsetY: 1 });
      expect(surface.readElevationPixels).toHaveBeenCalledTimes(2);
      surface.pixelsForElevation(image);
      surface.boundsForElevation({ ...resource, sourceOffsetX: 2 });
      expect(surface.readElevationPixels).toHaveBeenCalledTimes(3);
      expect(surface.elevationPixels.has(image)).toBe(true); // Persistent ground sampling is reusable.
    },
  );

  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL])(
    "tightens $id frustum bounds and restores the provider fallback when a measurement is removed",
    (model) => {
      const group = new THREE.Group();
      const centre = new THREE.Vector3(0.22, 0, Math.sqrt(1 - 0.22 ** 2));
      const geometry = new THREE.SphereGeometry(0.001, 4, 4);
      geometry.translate(centre.x, centre.y, centre.z);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
      group.add(mesh);
      group.updateMatrixWorld(true);
      const entry = createTerrainRenderVisibilityEntry(mesh, true, model.visibilityGeometry);
      const visibility = new TerrainRenderVisibility(group, { minimum: -model.referenceRadiusM / 10, maximum: model.referenceRadiusM / 10 }, model.visibilityGeometry);
      visibility.updateDisplacement(1, 1_000);
      visibility.setEntries([entry]);
      const camera = new THREE.PerspectiveCamera(20, 1, 0.05, 20);
      camera.position.set(0, 0, 2);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      visibility.update(camera);
      expect(mesh.visible).toBe(true);
      visibility.setElevationBounds(entry, { minimum: 0, maximum: 0 });
      visibility.update(camera);
      expect(mesh.visible).toBe(false);
      expect(visibility.metrics.measuredElevationBoundCount).toBe(1);
      visibility.setElevationBounds(entry, undefined);
      visibility.update(camera);
      expect(mesh.visible).toBe(true);
      expect(visibility.metrics.providerFallbackElevationBoundCount).toBe(1);
      geometry.dispose();
      mesh.material.dispose();
    },
  );
});
