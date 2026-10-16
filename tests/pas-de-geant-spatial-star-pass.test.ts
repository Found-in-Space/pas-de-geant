import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { StarCellData, StarCellDelta } from "@found-in-space/star-trees";
import type {
  StarOctreeProviderService,
  StarOctreeProviderSession,
} from "@found-in-space/star-octree-provider";
import {
  filterCatalogOriginStar,
  SpatialStarPass,
  SPATIAL_STAR_EXPOSURE,
  SPATIAL_STAR_LIMITING_MAGNITUDE,
} from "../apps/pas-de-geant/src/spatial-star-pass.js";

function starCell(): StarCellData {
  return {
    cellKey: "0:test",
    cell: { level: 0, mortonCode: "test" },
    bounds: {
      centerPc: { x: 2, y: 0, z: 0 },
      halfSizePc: 0,
      gridX: 0,
      gridY: 0,
      gridZ: 0,
    },
    count: 1,
    coordinates: {
      name: "icrs-parsec-position",
      frame: "icrs",
      units: ["pc", "pc", "pc"],
      components: new Float32Array([2, 0, 0]),
    },
    attributes: {
      magAbs: new Float32Array([1]),
      teffLog8: new Uint8Array([220]),
    },
  };
}

function mixedOriginCell(): StarCellData {
  return {
    ...starCell(),
    count: 3,
    coordinates: {
      ...starCell().coordinates,
      components: new Float32Array([
        0, 0, 0,
        2, 3, 4,
        -5, 6, 7,
      ]),
    },
    attributes: {
      magAbs: new Float32Array([4.83, 1.25, 2.5]),
      teffLog8: new Uint8Array([180, 210, 230]),
    },
    refs: [0, 1, 2].map((ordinal) => ({
      datasetId: "test",
      level: 0,
      mortonCode: "test",
      ordinal,
    })),
    pickMeta: [0, 1, 2].map((ordinal) => ({
      cellKey: "0:test" as const,
      level: 0,
      mortonCode: "test",
      ordinal,
      gridX: 0,
      gridY: 0,
      gridZ: 0,
      centerX: 0,
      centerY: 0,
      centerZ: 0,
    })),
  };
}

function fakeProvider(
  options: { empty?: boolean; cell?: StarCellData } = {},
) {
  const listeners = new Set<(delta: StarCellDelta) => void>();
  const views: unknown[] = [];
  const warmups: unknown[] = [];
  let populated = false;
  const session = {
    subscribe(listener: (delta: StarCellDelta) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateView(view: unknown) {
      views.push(view);
      const viewRevision = views.length;
      if (!populated) {
        populated = true;
        if (!options.empty) {
          const upsert: StarCellDelta = {
            type: "stars/cells-upsert",
            providerId: "test",
            cells: [options.cell ?? starCell()],
          };
          for (const listener of listeners) listener(upsert);
        }
      }
      const current: StarCellDelta = {
        type: "stars/current",
        providerId: "test",
        cellKeys: options.empty ? [] : ["0:test"],
        starCount: options.empty ? 0 : options.cell?.count ?? 1,
        viewRevision,
      };
      for (const listener of listeners) listener(current);
      return {
        sessionId: "test",
        viewRevision,
        demandRevision: viewRevision,
        demand: "forced",
        reasons: ["test"],
      };
    },
    dispose: vi.fn(async () => undefined),
  } as unknown as StarOctreeProviderSession;
  const provider = {
    ensureBootstrap: vi.fn(async () => undefined),
    createSession: vi.fn(() => session),
    warmCells: vi.fn(async (request: unknown) => {
      warmups.push(request);
      return {};
    }),
    dispose: vi.fn(async () => undefined),
  } as unknown as StarOctreeProviderService;
  return { provider, listeners, views, warmups, session };
}

describe("SpatialStarPass", () => {
  it("removes only the exact-origin Sun while preserving aligned star data", () => {
    const source = mixedOriginCell();
    const filtered = filterCatalogOriginStar(source);
    expect(filtered).not.toBeNull();
    expect(filtered!.count).toBe(2);
    expect(Array.from(filtered!.coordinates.components)).toEqual([
      2, 3, 4,
      -5, 6, 7,
    ]);
    expect(Array.from(filtered!.attributes.magAbs!)).toEqual([1.25, 2.5]);
    expect(Array.from(filtered!.attributes.teffLog8!)).toEqual([210, 230]);
    expect(filtered!.refs?.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
    expect(filtered!.pickMeta?.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
    const sunFree = starCell();
    expect(filterCatalogOriginStar(sunFree)).toBe(sunFree);
    expect(filterCatalogOriginStar({
      ...source,
      count: 1,
      coordinates: {
        ...source.coordinates,
        components: new Float32Array([0, 0, 0]),
      },
      attributes: {
        magAbs: new Float32Array([4.83]),
        teffLog8: new Uint8Array([180]),
      },
      refs: source.refs?.slice(0, 1),
      pickMeta: source.pickMeta?.slice(0, 1),
    })).toBeNull();
  });

  it("renders one application-owned origin Sun with distinct observer ownership", async () => {
    const fake = fakeProvider({ cell: mixedOriginCell() });
    const pass = new SpatialStarPass({ provider: fake.provider });
    await pass.load({ x: 0.0000048, y: 0, z: 0 });
    pass.setView({
      observerJ2000Pc: { x: 0.0000048, y: 0, z: 0 },
      sunObserverJ2000Pc: { x: 0, y: 0, z: 1 },
      j2000ToWorld: new THREE.Quaternion(),
      trackingAnchorWorld: new THREE.Vector3(),
      parallaxBlend: 1,
      sunOpacity: 1,
    });

    const cataloguePoints = pass.scene
      .getObjectByName("pas-de-geant-spatial-stars:points") as THREE.Points;
    const sunPoints = pass.scene
      .getObjectByName("pas-de-geant-stellar-sun:points") as THREE.Points;
    expect(Array.from(
      cataloguePoints.geometry.getAttribute("position").array,
    )).toEqual([2, 3, 4, -5, 6, 7]);
    expect(Array.from(
      sunPoints.geometry.getAttribute("position").array,
    )).toEqual([0, 0, 0]);
    expect(pass.getSnapshot().starCount).toBe(2);
    expect(((cataloguePoints.material as THREE.ShaderMaterial)
      .uniforms.uObserverPosition!.value as THREE.Vector3).toArray())
      .toEqual([0.0000048, 0, 0]);
    expect(((sunPoints.material as THREE.ShaderMaterial)
      .uniforms.uObserverPosition!.value as THREE.Vector3).toArray())
      .toEqual([0, 0, 1]);

    const remove: StarCellDelta = {
      type: "stars/cells-remove",
      providerId: "test",
      cellKeys: ["0:test"],
    };
    for (const listener of fake.listeners) listener(remove);
    const error: StarCellDelta = {
      type: "stars/error",
      providerId: "test",
      error: { message: "later network failure" },
    };
    for (const listener of fake.listeners) listener(error);
    expect(Array.from(
      cataloguePoints.geometry.getAttribute("position").array,
    )).toEqual([2, 3, 4, -5, 6, 7]);
    await pass.dispose();
  });

  it("keeps one SkyKit XR profile from the Earth view through the stellar view", async () => {
    const fake = fakeProvider();
    const pass = new SpatialStarPass({ provider: fake.provider });
    await pass.load({ x: 0, y: 0, z: 0 });
    pass.setView({
      observerJ2000Pc: { x: 0, y: 0, z: 0 },
      sunObserverJ2000Pc: { x: 0, y: 0, z: 1 },
      j2000ToWorld: new THREE.Quaternion(),
      trackingAnchorWorld: new THREE.Vector3(),
      parallaxBlend: 0,
      sunOpacity: 0,
    });

    expect(pass.getSnapshot()).toMatchObject({ status: "ready", starCount: 1 });
    const catalogue = pass.scene.getObjectByName("pas-de-geant-spatial-stars");
    const points = catalogue?.getObjectByName(
      "pas-de-geant-spatial-stars:points",
    ) as THREE.Points | undefined;
    const material = points?.material as THREE.ShaderMaterial;
    const halo = catalogue?.getObjectByName(
      "pas-de-geant-spatial-stars:halo",
    ) as THREE.Points | undefined;
    const haloMaterial = halo?.material as THREE.ShaderMaterial;
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(haloMaterial.depthTest).toBe(false);
    expect(haloMaterial.depthWrite).toBe(false);
    expect(material.vertexShader).toContain("clip.z = clip.w * 0.999999");
    expect(material.vertexShader).not.toContain("520");
    expect((material.uniforms.uObserverPosition!.value as THREE.Vector3).toArray())
      .toEqual([0, 0, 0]);
    expect(material.uniforms.uScale!.value).toBe(1);
    expect(material.uniforms.uMagLimit!.value)
      .toBe(SPATIAL_STAR_LIMITING_MAGNITUDE);
    expect(material.uniforms.uExposure!.value).toBe(SPATIAL_STAR_EXPOSURE);
    expect(material.uniforms.uNearMagLimitRadiusPc!.value).toBe(1);
    expect(material.uniforms.uNearSizeFloor!.value).toBe(8);
    expect(material.uniforms.uNearAlphaFloor!.value).toBe(0.35);
    const earthVertexShader = material.vertexShader;
    const earthFragmentShader = material.fragmentShader;
    pass.setView({
      observerJ2000Pc: { x: 0, y: 0, z: 0 },
      sunObserverJ2000Pc: { x: 0, y: 0, z: 1 },
      j2000ToWorld: new THREE.Quaternion(),
      trackingAnchorWorld: new THREE.Vector3(),
      parallaxBlend: 1,
      sunOpacity: 1,
    });
    expect(material.vertexShader).toBe(earthVertexShader);
    expect(material.fragmentShader).toBe(earthFragmentShader);
    expect(material.uniforms.uExposure!.value).toBe(SPATIAL_STAR_EXPOSURE);
    expect(material.uniforms.uMagLimit!.value)
      .toBe(SPATIAL_STAR_LIMITING_MAGNITUDE);
    expect(material.uniforms.uParallaxBlend!.value).toBe(1);
    const sun = pass.scene.getObjectByName("pas-de-geant-stellar-sun");
    const sunPoints = sun?.getObjectByName(
      "pas-de-geant-stellar-sun:points",
    ) as THREE.Points | undefined;
    const sunMaterial = sunPoints?.material as THREE.ShaderMaterial;
    expect((sunMaterial.uniforms.uObserverPosition!.value as THREE.Vector3).toArray())
      .toEqual([0, 0, 1]);
    expect(sunMaterial.uniforms.uJourneyOpacity!.value).toBe(1);
    expect(fake.views.at(-1)).toMatchObject({
      limitingMagnitude: SPATIAL_STAR_LIMITING_MAGNITUDE,
      mDesired: SPATIAL_STAR_LIMITING_MAGNITUDE,
    });
    await pass.dispose();
  });

  it("warms route shells and volumes and retains valid cells after streaming error", async () => {
    const fake = fakeProvider();
    const pass = new SpatialStarPass({ provider: fake.provider });
    await pass.load({ x: 0, y: 0, z: 0 });
    const route = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0.5 },
      { x: 0, y: 0, z: 1 },
    ];
    await pass.warmJourney(route, route[2]!, new AbortController().signal);
    expect(fake.warmups).toHaveLength(5);
    const [destinationWarmup] = vi.mocked(fake.provider.warmCells).mock.calls.at(-1)!;
    const strategy = destinationWarmup.strategy!;
    const evaluator = strategy.createEvaluator(strategy.createAnchor({}));
    const cell = { centerX: 0, centerY: 0, centerZ: 30, halfSize: 0, level: 0, mortonCode: "0" };
    expect(evaluator.evaluateCell(cell).include).toBe(true);
    expect(evaluator.evaluateCell({ ...cell, centerZ: 31.5 }).include).toBe(false);

    const remove: StarCellDelta = {
      type: "stars/cells-remove",
      providerId: "test",
      cellKeys: ["0:test"],
    };
    for (const listener of fake.listeners) listener(remove);
    expect(pass.getSnapshot().starCount).toBe(0);
    const error: StarCellDelta = {
      type: "stars/error",
      providerId: "test",
      error: { message: "later network failure" },
    };
    for (const listener of fake.listeners) listener(error);
    expect(pass.getSnapshot()).toMatchObject({
      status: "failed",
      starCount: 1,
      lastError: "later network failure",
    });
    await pass.dispose();
  });

  it("rejects an empty current demand instead of allowing a blank reveal", async () => {
    const fake = fakeProvider({ empty: true });
    const pass = new SpatialStarPass({ provider: fake.provider });
    await expect(pass.load({ x: 0, y: 0, z: 0 })).rejects.toThrow(
      /no stars/i,
    );
    expect(pass.getSnapshot()).toMatchObject({
      status: "failed",
      starCount: 0,
    });
    await pass.dispose();
  });
});
