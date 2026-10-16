import * as THREE from "three";
import { inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL, type SurfaceModel } from "../packages/pas-de-geant/src/worlds/surface-model.js";
import {
  TerrainSurface, terrainMeshAngularMargin, terrainPatchGeometry,
  sampleEncodedElevationMetres,
} from "../packages/pas-de-geant/src/worlds/terrain-surface.js";
import { normalizeTerrainLodOptions, terrainSegmentsForZoom } from "../packages/pas-de-geant/src/worlds/terrain-lod.js";
import { TileOnionLayoutSource } from "../packages/pas-de-geant/src/worlds/tile-layout-source.js";
import { TileHorizonCulling, classifyTilesWithinHorizon } from "../packages/pas-de-geant/src/worlds/tile-horizon-culling.js";
import { surfaceDisplacementBounds, TERRAIN_SKIRT_DEPTH_WORLD_METRES } from "../packages/pas-de-geant/src/worlds/surface-visibility-geometry.js";
import { imageryBoundsForGeographicBounds, ScheduledImageryProvider, type ImageryTileResource } from "../packages/pas-de-geant/src/worlds/imagery.js";
import { SparseImageryProvider } from "../packages/pas-de-geant/src/worlds/sparse-imagery-provider.js";
import { XyzImageryProvider } from "../packages/pas-de-geant/src/worlds/imagery-provider.js";
import {
  BLUE_MARBLE_IMAGERY_NODE, buildDesiredImageryTree,
  reconcileImageryTree, imageryTreeImageAtGlobalUv,
} from "../packages/pas-de-geant/src/worlds/imagery-tree.js";
import { tileIdentityKey, type TileIdentity } from "../packages/pas-de-geant/src/worlds/tile-transition-planner.js";
import {
  createTerrainRenderVisibilityEntry, TerrainRenderVisibility,
  type TerrainRenderVisibilityEntry,
} from "../packages/pas-de-geant/src/worlds/terrain-render-visibility.js";

function elevationPixels(model: SurfaceModel): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(16);
  for (const [index, height] of [-2_300, -2_100, -2_000, -1_900].entries()) {
    const encoded = model.heightEncoding.kind === "terrarium"
      ? height + 32_768 : (height - model.heightEncoding.offsetM) / model.heightEncoding.scaleM;
    pixels[index * 4] = Math.floor(encoded / 256);
    pixels[index * 4 + 1] = encoded % 256;
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

function fragmentGlobalUv(hit: THREE.Intersection, tile: TileIdentity, model: SurfaceModel) {
  const geometry = (hit.object as THREE.Mesh).geometry;
  const positions = geometry.getAttribute("position");
  const face = hit.face!;
  const barycentric = new THREE.Triangle(
    new THREE.Vector3().fromBufferAttribute(positions, face.a),
    new THREE.Vector3().fromBufferAttribute(positions, face.b),
    new THREE.Vector3().fromBufferAttribute(positions, face.c),
  ).getBarycoord(hit.point, new THREE.Vector3())!;
  const uv = geometry.getAttribute("imageryUv");
  const u = uv.getX(face.a) * barycentric.x + uv.getX(face.b) * barycentric.y + uv.getX(face.c) * barycentric.z;
  const v = uv.getY(face.a) * barycentric.x + uv.getY(face.b) * barycentric.y + uv.getY(face.c) * barycentric.z;
  const bounds = imageryBoundsForGeographicBounds(model.tileBounds(tile), model.projection);
  return { u: bounds.west + u * (bounds.east - bounds.west), v: bounds.north + v * (bounds.south - bounds.north) };
}

describe("rendered displaced terrain coverage", () => {
  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL])(
    "hydrates grazing $id intersections through the existing source queue and imagery tree",
    async (model) => {
      const view = { latitudeDegrees: 0.67416, longitudeDegrees: 23.47314,
        displayRadiusM: model.referenceRadiusM / 50, observerHeightWorldM: 0.771805,
        projection: model.projection, minimumNormalizedSurfaceRadius: model.minimumNormalizedSurfaceRadius };
      const cut = new TileOnionLayoutSource().calculate({ ...view, maxZoom: 12 });
      const nominal = classifyTilesWithinHorizon(cut, view);
      const lod = normalizeTerrainLodOptions(model.elevationMetadata);
      const margin = terrainMeshAngularMargin(model, cut, lod);
      const { position, normal } = model.positionAndNormal(view.latitudeDegrees, view.longitudeDegrees);
      const origin = position.clone().addScaledVector(normal, view.observerHeightWorldM / view.displayRadiusM);
      const retained = classifyTilesWithinHorizon(cut, {
        ...view, surfaceGeometry: model.visibilityGeometry, observerPositions: [origin],
        displacementBounds: surfaceDisplacementBounds(model.visibilityGeometry,
          model.elevationMetadata.elevationBoundsMetres, 1, view.displayRadiusM, Math.cos(margin)),
        meshAngularMargin: margin,
      });
      const pixels = elevationPixels(model);
      const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      const group = new THREE.Group();
      const entries: TerrainRenderVisibilityEntry[] = [];
      const meshes = cut.map((tile) => {
        const geometry = terrainPatchGeometry(model.tileBounds(tile),
          terrainSegmentsForZoom(tile.z, lod.segmentTiers, model.minimumProjectedWorldSegments),
          terrainSegmentsForZoom(tile.z, lod.segmentTiers, model.minimumProjectedWorldSegments), true, model);
        const mesh = new THREE.Mesh(geometry, material);
        entries.push(createTerrainRenderVisibilityEntry(mesh, true, model.visibilityGeometry));
        const positions = geometry.getAttribute("position");
        const normals = geometry.getAttribute("normal");
        const uvs = geometry.getAttribute("tileUv");
        const skirts = geometry.getAttribute("skirt");
        for (let index = 0; index < positions.count; index += 1) {
          // Simulate the captured mixed cut: admitted meshes have elevation;
          // unhydrated meshes remain flat. Exercise a cropped source ancestor.
          const height = nominal.has(tileIdentityKey(tile)) ? sampleEncodedElevationMetres(
            pixels, 2, 2, uvs.getX(index) / 2 + 0.25, uvs.getY(index) / 2 + 0.25, model.heightEncoding,
          ) : 0;
          const displacement = height / model.referenceRadiusM -
            skirts.getX(index) * TERRAIN_SKIRT_DEPTH_WORLD_METRES / view.displayRadiusM;
          positions.setXYZ(index,
            positions.getX(index) + normals.getX(index) * displacement,
            positions.getY(index) + normals.getY(index) * displacement,
            positions.getZ(index) + normals.getZ(index) * displacement);
        }
        geometry.computeBoundingSphere();
        mesh.userData.tile = tile;
        group.add(mesh);
        mesh.updateMatrixWorld(true);
        return mesh;
      });
      const longitude = view.longitudeDegrees * Math.PI / 180;
      const east = new THREE.Vector3(-Math.sin(longitude), 0, -Math.cos(longitude));
      const classifier = new TerrainRenderVisibility(group,
        model.elevationMetadata.elevationBoundsMetres, model.visibilityGeometry);
      classifier.setEntries(entries);
      classifier.updateDisplacement(1, view.displayRadiusM, Math.cos(margin));
      group.updateMatrixWorld(true);
      const hits: { hit: THREE.Intersection; tile: TileIdentity; oldFallback: boolean }[] = [];
      for (const bearing of [-0.5, 0, 0.5]) {
        const tangent = east.clone().applyAxisAngle(normal, bearing);
        for (const depression of [0.4, 0.6, 1, 1.5, 2, 2.5, 3, 4]) {
          const angle = depression * Math.PI / 180;
          const direction = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(normal, -Math.sin(angle));
          const hit = new THREE.Raycaster(origin, direction).intersectObjects(meshes, false)[0];
          if (!hit) continue;
          const tile = hit.object.userData.tile as TileIdentity;
          const camera = new THREE.PerspectiveCamera(60, 1, 1e-7, 3);
          camera.position.copy(origin);
          camera.lookAt(origin.clone().add(direction));
          camera.updateMatrixWorld(true);
          classifier.update(camera);
          expect(hit.object.visible).toBe(true);
          expect(retained.has(tileIdentityKey(tile))).toBe(true);
          hits.push({ hit, tile, oldFallback: !nominal.has(tileIdentityKey(tile)) });
        }
      }
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.filter((hit) => hit.oldFallback).length).toBeGreaterThan(0);
      expect(hits.some(({ hit, oldFallback }) => oldFallback &&
        hit.face!.normal.dot(hit.point.clone().sub(origin)) > 0)).toBe(true);

      // A real 1x1 RGBA PNG, served successfully through the ordinary provider.
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQCKj4DwADhAHwaWoWWwAAAABJRU5ErkJggg==", "base64");
      const fetcher = vi.fn(async () => new Response(new Uint8Array(png), {
        status: 200, headers: { "content-type": "image/png" },
      }));
      const configuration = { attribution: "fixture", tileSize: 1, minZoom: 0,
        urlTemplate: "https://fixture.invalid/{z}/{x}/{y}.png" };
      const global = new XyzImageryProvider({ ...configuration, id: "global", maxZoom: 8 }, { fetcher, cacheStorage: null });
      const source = new SparseImageryProvider(global, [{
        provider: new XyzImageryProvider({ ...configuration, id: "detail", maxZoom: 12 }, { fetcher, cacheStorage: null }), priority: 100,
        hasTile: (tile) => tile.z >= 10 && nominal.has(tileIdentityKey(tile)),
      }]);
      const scheduled = new ScheduledImageryProvider(source, async (blob) => {
        const encoded = Buffer.from(await blob.arrayBuffer());
        // Decode this fixture's single unfiltered PNG scanline in Node. The
        // browser decoder has its own tests; no DOM/GL emulation is needed here.
        return new Uint8Array(inflateSync(encoded.subarray(41, 41 + encoded.readUInt32BE(33))).subarray(1));
      });
      try {
        const resources = await Promise.all(cut.filter((tile) => retained.has(tileIdentityKey(tile))).map((tile) =>
          new Promise<ImageryTileResource>((resolve, reject) => scheduled.request(tile, (event) => {
            if (event.phase === "response") resolve(event.resource);
            if (event.phase === "failure") reject(new Error(event.reason));
          })),
        ));
        const resident = new Set(resources.map((resource) => tileIdentityKey(resource.sourceTile!)));
        for (const resource of resources) expect(resource.pixels).toEqual(new Uint8Array([40, 80, 120, 255]));
        const desired = buildDesiredImageryTree(cut, (tile) => ({
          image: retained.has(tileIdentityKey(tile)) ? tileIdentityKey(source.resolveSource(tile)) : "",
          fallbackFromNotFound: false,
        }));
        const tree = reconcileImageryTree(BLUE_MARBLE_IMAGERY_NODE, desired, {
          isResident: (key) => key === "" || resident.has(key),
          sourceZoom: (key) => key === "" ? -1 : Number(key.split("/")[0]),
          imageNode: (image) => ({ image }),
        });
        for (const { hit, tile } of hits) {
          const uv = fragmentGlobalUv(hit, tile, model);
          expect(imageryTreeImageAtGlobalUv(tree, uv.u, uv.v)).not.toBe("");
        }
        expect(fetcher).toHaveBeenCalledTimes(resident.size);
      } finally {
        scheduled.dispose();
        meshes.forEach((mesh) => mesh.geometry.dispose());
        material.dispose();
      }
    },
  );

  it("uses actual posed stereo eye positions for loading without reacting to head rotation", () => {
    const surface = Object.create(TerrainSurface.prototype) as any;
    const root = new THREE.Group();
    root.position.set(4, -2, 3);
    root.rotation.set(0.2, 0.7, -0.3);
    root.scale.setScalar(1_000);
    const group = new THREE.Group();
    root.add(group);
    root.updateMatrixWorld(true);
    surface.group = group;
    surface.meshes = new Map();
    surface.surfaceModel = MOON_SURFACE_MODEL;
    surface.meshAngularMargin = 0;
    surface.resourceObserverPositions = [];
    surface.resourceObserverPosition = new THREE.Vector3();
    surface.resourceEyePositions = [];
    surface.resourceObserverRadius = 0;
    surface.resourceTerrainWorldInverse = new THREE.Matrix4();
    surface.latestView = { latitudeDegrees: 0, longitudeDegrees: 0, displayRadiusM: 1_000,
      terrainMultiplier: 1, observerHeightWorldM: 1, focalLengthPixels: 1_000 };
    surface.imagery = { updateHorizonView: vi.fn() };
    surface.renderVisibility = { update: vi.fn() };
    surface.horizonCulling = new TileHorizonCulling();
    surface.snapshot = { revision: 1, committedCut: [{ z: 1, x: 1, y: 0 }], graph: { groups: [] } };
    surface.scheduler = { updateHorizonCulling: vi.fn(), workingSetTiles: [] };
    surface.provider = { retainSourceTiles: vi.fn() };
    const local = [new THREE.Vector3(1.001, 0, -0.00003), new THREE.Vector3(1.001, 0, 0.00003)];
    const eyes = local.map((position) => {
      const eye = new THREE.PerspectiveCamera();
      eye.position.copy(group.localToWorld(position.clone()));
      eye.updateMatrixWorld(true);
      return eye;
    });
    const camera = new THREE.ArrayCamera(eyes);
    surface.updateRenderVisibility(camera);
    const context = surface.imagery.updateHorizonView.mock.calls[0][0];
    expect(new THREE.Vector3().copy(context.observerPositions[0])
      .distanceTo(new THREE.Vector3(1.001, 0, 0))).toBeLessThan(1e-14);
    expect(context.observerRadius).toBeCloseTo(0.00003, 14);
    eyes.forEach((eye) => { eye.rotation.y += 1; eye.updateMatrixWorld(true); });
    surface.updateRenderVisibility(camera);
    expect(surface.imagery.updateHorizonView).toHaveBeenCalledTimes(1);
    expect(surface.renderVisibility.update).toHaveBeenCalledTimes(2);
  });
});
