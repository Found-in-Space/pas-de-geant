import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  contactFrame, EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL, solveBodySurfacePose,
} from "@found-in-space/worlds";
import { terrainTargetForView } from "@found-in-space/worlds/terrain-surface";
import { observeBodySurface } from "../apps/pas-de-geant/src/body-surface-view.js";

describe("posed terrain view", () => {
  it("uses the lunar ground distance instead of floor height when terrain lies below the reference sphere", () => {
    const model = MOON_SURFACE_MODEL;
    const state = { contact: contactFrame(0.67416, 23.47314), terrainMultiplier: 1 };
    const radius = model.referenceRadiusM / 50;
    // Reproduce the original reference-sphere anchor with loaded negative relief.
    const pose = solveBodySurfacePose(state, new THREE.Vector2(), radius, model);
    const root = new THREE.Group();
    root.position.copy(pose.centre);
    root.quaternion.copy(pose.bodyToWorld);
    root.scale.setScalar(radius);
    const camera = new THREE.PerspectiveCamera();
    const zooms: number[] = [];
    for (const eyeHeight of [1.65, 0.65]) {
      camera.position.set(0, eyeHeight, 0);
      const observed = observeBodySurface({
        bodyId: "moon", root, camera, terrainMultiplier: 1,
        surface: { sampleElevationMetres: () => -1_927.5 },
      });
      expect(observed.observerHeightWorldM).toBeCloseTo(eyeHeight + 38.55, 8);
      const view = { ...observed, terrainMultiplier: 1, focalLengthPixels: 1_000,
        projection: "geographic" as const };
      const actualZoom = terrainTargetForView(view, 512).maxZoom;
      const floorZoom = terrainTargetForView({ ...view, observerHeightWorldM: eyeHeight }, 512).maxZoom;
      expect(actualZoom).toBeLessThan(floorZoom);
      zooms.push(actualZoom);
    }
    // Kneeling is a small distance change when ground is still almost 40 m away.
    expect(zooms[1]).toBe(zooms[0]);
  });

  it.each([EARTH_SURFACE_MODEL, MOON_SURFACE_MODEL])(
    "measures $id standing and crouching clearance through posed terrain and camera transforms",
    (model) => {
      const bodyId = model.id as "earth" | "moon";
      const floor = new THREE.Vector2(2.4, -1.1);
      const contact = contactFrame(0.67416, 23.47314);
      const scene = new THREE.Group();
      scene.position.set(3, -11, 8);
      scene.rotation.set(0.7, 1, -0.2);
      const root = new THREE.Group();
      const camera = new THREE.PerspectiveCamera();
      scene.add(root, camera);
      for (const denominator of [50, 100]) {
        for (const elevationMetres of [-1_927.5, 0, 1_500]) {
          for (const terrainMultiplier of [0, 1, 3]) {
            const radius = model.referenceRadiusM / denominator;
            const pose = solveBodySurfacePose({ contact, terrainMultiplier }, floor,
              radius, model, elevationMetres);
            root.position.copy(pose.centre);
            root.quaternion.copy(pose.bodyToWorld);
            root.scale.setScalar(radius);
            for (const eyeHeight of [1.65, 0.65, 0.1]) {
              camera.position.set(floor.x, eyeHeight, floor.y);
              const observed = observeBodySurface({
                bodyId, root, camera, terrainMultiplier,
                surface: { sampleElevationMetres: () => elevationMetres },
              });
              expect(observed.latitudeDegrees).toBeCloseTo(0.67416, 6);
              expect(observed.longitudeDegrees).toBeCloseTo(23.47314, 6);
              expect(observed.referenceSurfaceHeightWorldM)
                .toBeCloseTo(eyeHeight + elevationMetres * terrainMultiplier / denominator, 7);
              expect(observed.observerHeightWorldM).toBeCloseTo(eyeHeight, 7);
            }
          }
        }
      }
    },
  );
});
