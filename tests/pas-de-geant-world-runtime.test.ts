import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  createWorldRuntime,
  createBodySurfaceModel,
  celestialBody,
  contactFrame,
  coordinatesForFrame,
  EARTH_SURFACE_MODEL,
  MOON_SURFACE_MODEL,
  SOLAR_SYSTEM_BODIES,
  loadWorldBaseTexture,
  rollContactFrame,
  solveBodySurfacePose,
  solvePlanetPose,
  worldSurfaceReadiness,
} from "@found-in-space/worlds";
import { observerTileZoom } from "@found-in-space/worlds/observer-tile-zoom";
import { observerHeightForImageryZoom, selectImageryZoom } from "@found-in-space/worlds/imagery-core";
import { terrainTargetForView } from "@found-in-space/worlds/terrain-surface";
import {
  createWorldSkykitPart,
  createWorldSkykitPlugin,
  physicalJ2000MetresToSkykitPosition,
  WORLD_METRES_PER_PARSEC,
} from "@found-in-space/worlds/skykit";
import type { SkykitThreeFrame, SkykitThreePluginContext } from "@found-in-space/skykit";

const view = {
  latitudeDegrees: 18, longitudeDegrees: -24,
  displayRadiusM: 2.25, terrainMultiplier: 1,
  observerHeightWorldM: 0.012, focalLengthPixels: 1_000,
};

describe("Shared world runtime", () => {
  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL, createBodySurfaceModel(celestialBody("mars"))])(
    "pins $id beneath the observer and preserves movement direction after transport",
    (model) => {
      const contact = rollContactFrame(contactFrame(60, 0), new THREE.Vector2(1, 0), 1);
      const state = { contact, terrainMultiplier: 1 };
      const coordinates = coordinatesForFrame(contact);
      const floor = new THREE.Vector2(2.4, -1.1);
      for (const radius of [1, 3_000, 300_000]) {
        const pose = solveBodySurfacePose(state, floor, radius, model);
        const point = model.positionAndNormal(coordinates.latitudeDegrees, coordinates.longitudeDegrees).position
          .multiplyScalar(radius).applyQuaternion(pose.bodyToWorld).add(pose.centre);
        expect(point.distanceTo(new THREE.Vector3(floor.x, 0, floor.y))).toBeLessThan(1e-9);
        expect(contact.eastEcef.clone().applyQuaternion(pose.bodyToWorld)
          .distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-10);
        expect(contact.northEcef.clone().applyQuaternion(pose.bodyToWorld)
          .distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-10);
      }
    },
  );

  it("preserves the Earth WGS84 pose at the equator, poles, and antimeridian", () => {
    for (const [latitude, longitude] of [[0, 0], [60, 120], [90, 180], [-90, -180]]) {
      const state = { contact: contactFrame(latitude!, longitude!), terrainMultiplier: 1 };
      const floor = new THREE.Vector2(1, -2);
      const previous = solvePlanetPose(state, floor, 3_000);
      const shared = solveBodySurfacePose(state, floor, 3_000, EARTH_SURFACE_MODEL);
      expect(shared.centre.distanceTo(previous.centre)).toBeLessThan(1e-9);
      expect(shared.bodyToWorld.angleTo(previous.earthToWorld)).toBeLessThan(1e-7);
    }
    const equator = EARTH_SURFACE_MODEL.positionAndNormal(0, 0).position;
    const pole = EARTH_SURFACE_MODEL.positionAndNormal(90, 0).position;
    expect(equator.length() * EARTH_SURFACE_MODEL.referenceRadiusM).toBeCloseTo(6_378_137, 6);
    expect(pole.length() * EARTH_SURFACE_MODEL.referenceRadiusM).toBeCloseTo(6_356_752.314245, 6);
  });

  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL])(
    "pins loaded $id terrain to the floor through scale, relief, and crouching changes",
    (model) => {
      const contact = rollContactFrame(
        contactFrame(0.67416, 23.47314), new THREE.Vector2(0.2, -0.1),
        model.referenceRadiusM / 50,
      );
      const coordinates = coordinatesForFrame(contact);
      const floor = new THREE.Vector2(2.4, -1.1);
      for (const denominator of [50, 100, 60_000]) {
        const radius = model.referenceRadiusM / denominator;
        for (const elevationMetres of [0, -1_927.5, 1_500]) {
          for (const terrainMultiplier of [0, 1, 3]) {
            const state = { contact, terrainMultiplier };
            const pose = solveBodySurfacePose(state, floor, radius, model, elevationMetres);
            const { position, normal } = model.positionAndNormal(
              coordinates.latitudeDegrees, coordinates.longitudeDegrees,
            );
            // Mirror the renderer's normal displacement and one root scale.
            const groundWorld = position.addScaledVector(normal,
              elevationMetres * terrainMultiplier / model.referenceRadiusM,
            ).multiplyScalar(radius).applyQuaternion(pose.bodyToWorld).add(pose.centre);
            expect(groundWorld.distanceTo(new THREE.Vector3(floor.x, 0, floor.y)))
              .toBeLessThan(1e-9);
            for (const eyeHeight of [1.65, 0.65, 0.1]) {
              const headWorld = new THREE.Vector3(floor.x, eyeHeight, floor.y);
              expect(headWorld.distanceTo(groundWorld)).toBeCloseTo(eyeHeight, 8);
            }
          }
        }
      }
    },
  );

  it("creates every registered body through the same runtime and disposes only owned geometry", () => {
    for (const body of SOLAR_SYSTEM_BODIES) {
      const root = new THREE.Group();
      const borrowedMarker = new THREE.Object3D();
      root.add(borrowedMarker);
      const world = createWorldRuntime({ body, root, renderer: {} as THREE.WebGLRenderer, initialView: view });
      const globe = root.children.find((child) => child instanceof THREE.Mesh) as THREE.Mesh;
      const dispose = vi.spyOn(globe.geometry, "dispose");
      world.update({ ...view, displayRadiusM: 4 });
      expect(root.scale.x).toBe(4);
      expect(world.getReadiness().ready).toBe(true);
      world.dispose();
      world.dispose();
      expect(dispose).toHaveBeenCalledOnce();
      expect(root.children).toEqual([borrowedMarker]);
    }
  });

  it("uses the body's physical shape when its reference radius differs", () => {
    for (const original of [celestialBody("moon"), celestialBody("earth")]) {
      const body = { ...original, referenceRadiusM: original.referenceRadiusM * 2 };
      const world = createWorldRuntime({ body, renderer: {} as THREE.WebGLRenderer, initialView: view });
      const globe = world.object3d.children[0] as THREE.Mesh;
      const model = createBodySurfaceModel(body);
      const equator = model.positionAndNormal(0, 0).position;
      const pole = model.positionAndNormal(90, 0).position;
      expect(globe.scale.x).toBeCloseTo(equator.length(), 12);
      expect(globe.scale.y).toBeCloseTo(pole.length(), 12);
      expect(globe.scale.z).toBeCloseTo(equator.length(), 12);
      world.dispose();
    }
  });

  it("keeps geographic terrain and imagery detail finite at both poles without changing Mercator behavior", () => {
    for (const latitudeDegrees of [-90, -89.9999, 89.9999, 90]) {
      const geographic = { ...view, latitudeDegrees, projection: "geographic" as const };
      const terrain = terrainTargetForView(geographic, 512, { maxTopologyZoom: 8 });
      const imagery = selectImageryZoom({ ...geographic, tilePixels: 512, minZoom: 0, maxZoom: 8, maxTopologyZoom: 8 });
      expect(terrain.maxZoom).toBe(8);
      expect(imagery).toBe(8);
      expect(observerHeightForImageryZoom({ ...geographic, tilePixels: 512, zoom: 8 }))
        .toBeCloseTo(Math.PI * view.displayRadiusM * view.focalLengthPixels / (512 * 256), 12);
    }
    const shared = { ...view, tilePixels: 512, projectedFocalLengthPixels: view.focalLengthPixels };
    expect(observerTileZoom({ ...shared, latitudeDegrees: 60 }).continuousZoom)
      .toBeCloseTo(observerTileZoom({ ...shared, latitudeDegrees: 0 }).continuousZoom - 1, 12);
  });

  it("uses a bundled base after source failure and allows later imagery recovery", async () => {
    const fallback = new THREE.Texture();
    const load = vi.fn(async (url: string) => {
      if (url === "source") throw new Error("offline");
      return fallback;
    });
    const result = await loadWorldBaseTexture({ sourceUrl: "source", fallbackUrl: "bundled", loadTexture: load });
    expect(result.texture).toBe(fallback);
    expect(load.mock.calls.map(([url]) => url)).toEqual(["source", "bundled"]);
    const status = { configuredImagery: true, completeImagery: false, imageryFailed: result.baseFallback };
    expect(worldSurfaceReadiness({ ...status, committedSurface: false }).ready).toBe(false);
    expect(worldSurfaceReadiness({ ...status, committedSurface: true })).toEqual({ ready: true, imagery: "fallback" });
    expect(worldSurfaceReadiness({ ...status, committedSurface: true, completeImagery: true }))
      .toEqual({ ready: true, imagery: "ready" });
    await expect(loadWorldBaseTexture({ fallbackUrl: "missing", loadTexture: async () => { throw new Error("missing"); } }))
      .rejects.toThrow("missing");
    fallback.dispose();
  });
});

describe("Skykit world lifecycle", () => {
  it("participates in an actual Skykit viewer and unregisters cleanly", async () => {
    const { createSkykitViewer } = await import("@found-in-space/skykit");
    const renderer = { render: vi.fn() };
    const world = createWorldRuntime({
      body: celestialBody("mars"), renderer: renderer as unknown as THREE.WebGLRenderer, initialView: view,
    });
    const visibility = vi.spyOn(world, "beforeRender");
    const dispose = vi.spyOn(world, "dispose");
    const getView = vi.fn(() => ({ ...view, displayRadiusM: 4 }));
    const present = vi.fn((_frame, runtime) => runtime.object3d.position.set(1, 2, 3));
    const viewer = await createSkykitViewer({ renderer });
    const unregister = await viewer.addPlugin(createWorldSkykitPlugin({ world, getView, present, disposeWorld: true }));
    expect(world.object3d.parent).toBe(viewer.roots.originContentRoot);
    viewer.frame(1 / 60);
    expect(getView).toHaveBeenCalledOnce();
    expect(world.object3d.scale.x).toBe(4);
    expect(world.object3d.position.toArray()).toEqual([1, 2, 3]);
    expect(visibility).toHaveBeenCalledWith(viewer.camera);
    expect(renderer.render).toHaveBeenCalledWith(viewer.scene, viewer.camera);
    await unregister();
    expect(world.object3d.parent).toBeNull();
    expect(viewer.getSnapshot().partCount).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    await viewer.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("mounts, updates, renders, detaches, and respects borrowed ownership", () => {
    const world = createWorldRuntime({ body: celestialBody("moon"), renderer: {} as THREE.WebGLRenderer, initialView: view });
    const update = vi.spyOn(world, "update");
    const process = vi.spyOn(world, "processFrame");
    const visibility = vi.spyOn(world, "beforeRender");
    const dispose = vi.spyOn(world, "dispose");
    const roots = { originContentRoot: new THREE.Group(), observerContentRoot: new THREE.Group() };
    const context = { roots } as unknown as SkykitThreePluginContext;
    const camera = new THREE.PerspectiveCamera();
    const xrCamera = new THREE.ArrayCamera();
    const frame = { camera, renderer: { xr: { isPresenting: true, getCamera: () => xrCamera } } } as unknown as SkykitThreeFrame;
    const part = createWorldSkykitPart({ world, getView: () => view });
    part.attach?.(context);
    expect(world.object3d.parent).toBe(roots.originContentRoot);
    part.update?.(frame);
    part.beforeRender?.(frame);
    expect(update).toHaveBeenCalledWith(view);
    expect(process).toHaveBeenCalledOnce();
    expect(visibility).toHaveBeenCalledWith(xrCamera);
    part.detach?.();
    expect(world.object3d.parent).toBeNull();
    part.attach?.(context);
    part.dispose?.();
    expect(dispose).not.toHaveBeenCalled();
    const owned = createWorldSkykitPart({ world, getView: () => view, parent: "observer", disposeWorld: true });
    owned.attach?.(context);
    expect(world.object3d.parent).toBe(roots.observerContentRoot);
    owned.dispose?.();
    expect(dispose).toHaveBeenCalledOnce();
    const addPart = vi.fn();
    const plugin = createWorldSkykitPlugin({ world, getView: () => view });
    plugin.setup({ ...context, addPart });
    expect(addPart).toHaveBeenCalledOnce();
  });

  it("converts physical positions into Skykit coordinates while retaining the ICRS axes", () => {
    const position = physicalJ2000MetresToSkykitPosition({
      x: WORLD_METRES_PER_PARSEC, y: -2 * WORLD_METRES_PER_PARSEC, z: 3 * WORLD_METRES_PER_PARSEC,
    }, 0.001);
    expect(position.x).toBeCloseTo(0.001, 12);
    expect(position.y).toBeCloseTo(-0.002, 12);
    expect(position.z).toBeCloseTo(0.003, 12);
  });
});
