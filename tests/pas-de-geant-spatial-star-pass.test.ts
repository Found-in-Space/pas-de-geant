import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import type { StarCellData, StarCellDelta } from "@found-in-space/star-trees";
import type {
  StarOctreeProviderService,
  StarOctreeProviderSession,
} from "@found-in-space/star-octree-provider";
import {
  SpatialStarPass,
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

function fakeProvider(options: { empty?: boolean } = {}) {
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
            cells: [starCell()],
          };
          for (const listener of listeners) listener(upsert);
        }
      }
      const current: StarCellDelta = {
        type: "stars/current",
        providerId: "test",
        cellKeys: options.empty ? [] : ["0:test"],
        starCount: options.empty ? 0 : 1,
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
  it("renders catalogue points at background depth without a finite star shell", async () => {
    const fake = fakeProvider();
    const pass = new SpatialStarPass({ provider: fake.provider });
    await pass.load({ x: 0, y: 0, z: 0 });
    pass.setView({
      observerJ2000Pc: { x: 0, y: 0, z: 0 },
      sunObserverJ2000Pc: { x: 0, y: 0, z: 10 },
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
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.vertexShader).toContain("clip.z = clip.w * 0.999999");
    expect(material.vertexShader).not.toContain("520");
    expect((material.uniforms.uObserverPc!.value as THREE.Vector3).toArray())
      .toEqual([0, 0, 0]);
    const sun = pass.scene.getObjectByName("pas-de-geant-stellar-sun");
    const sunPoints = sun?.getObjectByName(
      "pas-de-geant-stellar-sun:points",
    ) as THREE.Points | undefined;
    const sunMaterial = sunPoints?.material as THREE.ShaderMaterial;
    expect((sunMaterial.uniforms.uObserverPc!.value as THREE.Vector3).toArray())
      .toEqual([0, 0, 10]);
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
      { x: 0, y: 0, z: 5 },
      { x: 0, y: 0, z: 10 },
    ];
    await pass.warmJourney(route, route[2]!, new AbortController().signal);
    expect(fake.warmups.length).toBeGreaterThanOrEqual(5);

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
