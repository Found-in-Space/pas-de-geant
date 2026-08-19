import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  createTerrainRenderVisibilityEntry,
  TerrainRenderVisibility,
} from "../apps/pas-de-geant/src/terrain-render-visibility.js";

function meshEntry(
  center: THREE.Vector3,
  radius: number,
  usesElevationBounds: boolean,
) {
  const positions = [
    center.x - radius,
    center.y,
    center.z,
    center.x + radius,
    center.y,
    center.z,
    center.x,
    center.y - radius,
    center.z,
    center.x,
    center.y + radius,
    center.z,
    center.x,
    center.y,
    center.z - radius,
    center.x,
    center.y,
    center.z + radius,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.frustumCulled = false;
  return createTerrainRenderVisibilityEntry(mesh, usesElevationBounds);
}

function cameraLookingFrom(
  position: THREE.Vector3,
  target: THREE.Vector3,
): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.05, 20);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function visibility(
  group: THREE.Group,
  bounds: { minimum: number; maximum: number } | undefined = {
    minimum: -32_768,
    maximum: 32_767 + 255 / 256,
  },
): TerrainRenderVisibility {
  group.updateMatrixWorld(true);
  const result = new TerrainRenderVisibility(group, bounds);
  result.updateDisplacement(1, 1_000);
  return result;
}

describe("terrain render visibility", () => {
  it("keeps the stereo union visible when only one eye contains a mesh", () => {
    const group = new THREE.Group();
    const entry = meshEntry(new THREE.Vector3(0, 0, 1), 0.02, false);
    group.add(entry.mesh);
    const classifier = visibility(group);
    classifier.setEntries([entry]);
    const left = cameraLookingFrom(
      new THREE.Vector3(0, 0, 2),
      new THREE.Vector3(0, 0, 0),
    );
    const right = cameraLookingFrom(
      new THREE.Vector3(0, 0, 2),
      new THREE.Vector3(0, 0, 3),
    );

    const stereo = new THREE.ArrayCamera([left, right]);
    // Three's WebXRManager supplies a conservative union projection on the
    // ArrayCamera before scene.onBeforeRender. This synthetic pair uses the
    // left-eye projection as a sufficient union for the visible test mesh.
    stereo.projectionMatrix.copy(left.projectionMatrix);
    stereo.matrixWorld.copy(left.matrixWorld);
    stereo.matrixWorldInverse.copy(left.matrixWorldInverse);
    classifier.update(stereo);

    expect(entry.mesh.visible).toBe(true);
    expect(classifier.metrics).toMatchObject({
      leftEyeVisibleCount: 1,
      rightEyeVisibleCount: 0,
      stereoUnionVisibleCount: 1,
      estimatedTerrainDrawCalls: 2,
    });
  });

  it("rejects a flat polar-region bound hidden behind the ellipsoid", () => {
    const group = new THREE.Group();
    const entry = meshEntry(new THREE.Vector3(0, 0, -1), 0.02, false);
    group.add(entry.mesh);
    const classifier = visibility(group);
    classifier.setEntries([entry]);
    const camera = cameraLookingFrom(
      new THREE.Vector3(0, 0, 2),
      new THREE.Vector3(0, 0, 0),
    );

    classifier.update(camera);

    expect(entry.mesh.visible).toBe(false);
    expect(classifier.metrics.horizonCulledCount).toBe(1);
  });

  it("classifies in terrain-local space beneath the posed planet root", () => {
    const planetRoot = new THREE.Group();
    planetRoot.position.set(3, -2, 5);
    planetRoot.rotation.set(0.3, -0.7, 0.2);
    planetRoot.scale.setScalar(6);
    const group = new THREE.Group();
    planetRoot.add(group);
    const near = meshEntry(new THREE.Vector3(0, 0, 1), 0.02, false);
    const far = meshEntry(new THREE.Vector3(0, 0, -1), 0.02, false);
    group.add(near.mesh, far.mesh);
    planetRoot.updateMatrixWorld(true);
    const classifier = visibility(group);
    classifier.setEntries([near, far]);
    const cameraPosition = planetRoot.localToWorld(
      new THREE.Vector3(0, 0, 2),
    );
    const cameraTarget = planetRoot.localToWorld(new THREE.Vector3());
    const camera = cameraLookingFrom(cameraPosition, cameraTarget);

    classifier.update(camera);

    expect(near.mesh.visible).toBe(true);
    expect(far.mesh.visible).toBe(false);
    expect(classifier.metrics.horizonCulledCount).toBe(1);
  });

  it("expands frustum bounds for shader displacement", () => {
    const group = new THREE.Group();
    const x = 0.22;
    const entry = meshEntry(
      new THREE.Vector3(x, 0, Math.sqrt(1 - x * x)),
      0.02,
      true,
    );
    group.add(entry.mesh);
    const camera = cameraLookingFrom(
      new THREE.Vector3(0, 0, 2),
      new THREE.Vector3(0, 0, 0),
    );
    camera.fov = 20;
    camera.updateProjectionMatrix();
    const flat = visibility(group, { minimum: 0, maximum: 0 });
    flat.setEntries([entry]);
    flat.update(camera);
    expect(entry.mesh.visible).toBe(false);

    const displaced = visibility(group, {
      minimum: -637_100,
      maximum: 637_100,
    });
    displaced.setEntries([entry]);
    displaced.update(camera);

    expect(entry.mesh.visible).toBe(true);
  });

  it("retains an elevation mesh when provider bounds are unavailable", () => {
    const group = new THREE.Group();
    const entry = meshEntry(new THREE.Vector3(10, 0, -2), 0.02, true);
    group.add(entry.mesh);
    group.updateMatrixWorld(true);
    const classifier = new TerrainRenderVisibility(group, undefined);
    classifier.updateDisplacement(1, 1_000);
    classifier.setEntries([entry]);
    const camera = cameraLookingFrom(
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, -1),
    );

    classifier.update(camera);

    expect(entry.mesh.visible).toBe(true);
    expect(classifier.metrics.conservativeRetainCount).toBe(1);
  });

  it("falls back conservatively inside the ellipsoid and at extreme radial scale", () => {
    const group = new THREE.Group();
    const entry = meshEntry(new THREE.Vector3(10, 0, -2), 0.02, true);
    group.add(entry.mesh);
    const classifier = visibility(group);
    classifier.setEntries([entry]);
    const inside = cameraLookingFrom(
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, -1),
    );

    classifier.update(inside);
    expect(entry.mesh.visible).toBe(true);
    expect(classifier.metrics.conservativeRetainCount).toBe(1);

    const outside = cameraLookingFrom(
      new THREE.Vector3(0, 0, 2),
      new THREE.Vector3(0, 0, 0),
    );
    classifier.updateDisplacement(250_000, 1_000);
    classifier.update(outside);
    expect(entry.mesh.visible).toBe(true);
    expect(classifier.metrics.conservativeRetainCount).toBe(1);
  });

  it("restores every mesh when render culling is disabled", () => {
    const group = new THREE.Group();
    const entry = meshEntry(new THREE.Vector3(0, 0, -1), 0.02, false);
    group.add(entry.mesh);
    const classifier = visibility(group);
    classifier.setEntries([entry]);
    const camera = cameraLookingFrom(
      new THREE.Vector3(0, 0, 2),
      new THREE.Vector3(0, 0, 0),
    );
    classifier.update(camera);
    expect(entry.mesh.visible).toBe(false);

    classifier.setEnabled(false);

    expect(entry.mesh.visible).toBe(true);
    expect(classifier.metrics).toMatchObject({
      enabled: false,
      stereoUnionVisibleCount: 1,
    });
  });
});
