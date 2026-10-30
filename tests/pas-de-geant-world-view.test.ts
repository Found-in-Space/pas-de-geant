import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGeantViewer, createGeantWorldsPlugin, createGeantMovementPlugin,
  createGeantSurfaceMovementModel, GEANT_ACTIONS, type GeantViewer,
} from "@found-in-space/pas-de-geant";
import {
  celestialBody, contactFrame, createBodySurfaceModel, createWorldRuntime, solveBodySurfacePose, EARTH_SURFACE_MODEL,
  type SolarSystemBodyId,
} from "@found-in-space/pas-de-geant/worlds";
import { createWorldSkykitPart } from "@found-in-space/pas-de-geant/worlds/skykit";
import type { SkykitThreeFrame } from "@found-in-space/skykit";
import { terrainTargetForView } from "../packages/pas-de-geant/src/worlds/terrain-surface.js";

const viewers: GeantViewer[] = [];
afterEach(async () => { for (const viewer of viewers.splice(0)) await viewer.dispose(); vi.unstubAllGlobals(); });

async function fixture(immersive = false, body: SolarSystemBodyId = "earth", movementFirst = false) {
  const camera = new THREE.PerspectiveCamera(62, 1, 0.025, 1e8);
  camera.position.set(0, 1.65, 0);
  const eyes = [new THREE.PerspectiveCamera(90), new THREE.PerspectiveCamera(80)];
  eyes[0]!.viewport = new THREE.Vector4(0, 0, 1600, 1800);
  eyes[1]!.viewport = new THREE.Vector4(1600, 0, 1600, 2000);
  const head = new THREE.ArrayCamera(eyes); head.position.copy(camera.position);
  const reference = new EventTarget(), session = {};
  const xr = {
    isPresenting: immersive, getCamera: () => head, getSession: () => session,
    getReferenceSpace: () => reference,
    getFrame: () => ({ getViewerPose: () => ({ transform: { position: head.position, orientation: head.quaternion } }) }),
    updateCamera(camera: THREE.Camera) {
      head.matrix.compose(head.position, head.quaternion, new THREE.Vector3(1, 1, 1));
      head.matrixWorld.multiplyMatrices(camera.parent!.matrixWorld, head.matrix);
      for (const [index, eye] of eyes.entries()) {
        eye.matrix.makeTranslation(index ? 0.032 : -0.032, 0, 0);
        eye.matrixWorld.multiplyMatrices(head.matrixWorld, eye.matrix);
      }
    },
  };
  const renderer = { xr, render() {}, getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600) } as unknown as THREE.WebGLRenderer;
  const viewer = await createGeantViewer({
    renderer, camera, bodies: [body], scaleDenominator: 60_000,
    time: "2026-10-18T12:00:00Z", timeRate: 0,
    location: { latitudeDegrees: 47, longitudeDegrees: 11, altitudeM: 120 },
  });
  viewers.push(viewer);
  const movement = createGeantMovementPlugin({ model: createGeantSurfaceMovementModel() });
  if (movementFirst) await viewer.install(movement);
  await viewer.install(createGeantWorldsPlugin());
  if (!movementFirst) await viewer.install(movement);
  const world = viewer.worlds.get(body)!;
  const tick = () => { viewer.update(0); return world.getView(); };
  return { viewer, world, renderer, camera, eyes, head, xr, tick };
}

describe("posed world tile selection", () => {
  it("uses each XR eye's viewport and projection for detail, independently of the desktop canvas", async () => {
    const f = await fixture(true), view = f.tick();
    // The taller eye has an 80-degree vertical FOV over 2000 framebuffer pixels.
    expect(view.focalLengthPixels).toBeCloseTo(1000 / Math.tan(40 * Math.PI / 180), 8);
    expect(view.observerHeightWorldM).toBeCloseTo(1.652, 7);
    expect(terrainTargetForView(view, 512).maxZoom).toBe(8);
    // Crouching changes the detail demand using the same tracked eye height.
    f.head.position.y = 0.65;
    expect(f.tick().observerHeightWorldM).toBeCloseTo(0.652, 7);
  });

  it("uses the desktop projection matrix, including camera zoom", async () => {
    const f = await fixture();
    f.camera.zoom = 2; f.camera.updateProjectionMatrix();
    expect(f.tick().focalLengthPixels).toBeCloseTo(600 * f.camera.projectionMatrix.elements[5]! * 0.5, 8);
  });

  it.each([
    [false, "earth", false], [true, "earth", false], [false, "moon", true], [true, "moon", true],
  ] as const)("measures the current globe scale on the first frame (XR=%s, body=%s, movement first=%s)", async (immersive, body, movementFirst) => {
    const f = await fixture(immersive, body, movementFirst);
    f.tick();
    for (const scaleDenominator of [120, 120_000, 60_000]) {
      f.viewer.navigation.dispatch(GEANT_ACTIONS.setScale, { scaleDenominator });
      const view = f.tick();
      expect(view.displayRadiusM).toBeCloseTo(celestialBody(body).referenceRadiusM / scaleDenominator, 8);
      expect(view.observerHeightWorldM).toBeCloseTo(1.65 + 120 / scaleDenominator, 7);
      expect(view.latitudeDegrees).toBeCloseTo(47, 7);
      expect(view.longitudeDegrees).toBeCloseTo(11, 7);
    }
  });

  it("switches detail density between XR and desktop using the current viewport", async () => {
    const f = await fixture(true);
    const xrView = f.tick();
    f.xr.isPresenting = false;
    const desktop = f.tick();
    expect(terrainTargetForView(xrView, 512).maxZoom).toBe(8);
    expect(terrainTargetForView(desktop, 512).maxZoom).toBe(7);
    f.renderer.getDrawingBufferSize = target => target.set(1600, 1200);
    const denser = f.tick();
    expect(terrainTargetForView(denser, 512).maxZoom).toBe(8);
    expect(denser.observerHeightWorldM).toBeCloseTo(desktop.observerHeightWorldM, 8);
  });

  it("measures an authored SkyKit pose before selecting detail", async () => {
    const f = await fixture(true);
    f.tick();
    const pose = solveBodySurfacePose({ contact: contactFrame(-25, 130), terrainMultiplier: 1 },
      new THREE.Vector2(), 100, EARTH_SURFACE_MODEL);
    // A host can move its rig without running Geant's movement adapter.
    const rig = f.viewer.cameraRoot;
    rig.position.set(3, 0, -4); rig.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
    const part = createWorldSkykitPart({ world: f.world,
      getFrame: () => ({ pose: {
        position: pose.centre.clone().applyQuaternion(rig.quaternion).add(rig.position),
        orientation: rig.quaternion.clone().multiply(pose.bodyToWorld), displayRadiusM: 100,
      }, terrainMultiplier: 1 }),
    });
    part.update?.({ camera: f.camera, renderer: f.renderer } as unknown as SkykitThreeFrame);
    const view = f.world.getView();
    expect(view.latitudeDegrees).toBeCloseTo(-25, 7);
    expect(view.longitudeDegrees).toBeCloseTo(130, 7);
    expect(view.observerHeightWorldM).toBeCloseTo(1.65, 7);
    expect(view.displayRadiusM).toBeCloseTo(100, 8);
    expect(view.focalLengthPixels).toBeCloseTo(1191.75359259421, 8);
    Object.assign(view, { observerHeightWorldM: 123 }); // Inspection cannot change the retained view.
    expect(f.world.getView().observerHeightWorldM).toBeCloseTo(1.65, 7);
  });

  it("measures each surface's own terrain at the same pose, including a replacement candidate", () => {
    // Platform boundaries only: no GPU, worker execution or network is needed to measure a view.
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({}) }) });
    const renderer = { xr: { isPresenting: false }, initTexture() {},
      capabilities: { getMaxAnisotropy: () => 1 },
      getDrawingBufferSize: (target: THREE.Vector2) => target.set(800, 600),
    } as unknown as THREE.WebGLRenderer;
    const camera = new THREE.PerspectiveCamera(60); camera.position.y = 1.65;
    const seed = { latitudeDegrees: 0, longitudeDegrees: 0, displayRadiusM: 1,
      observerHeightWorldM: 1, terrainMultiplier: 2, focalLengthPixels: 1 };
    const worlds = [500, 450].map((height, index) => {
      const surfaceModel = index === 0 ? EARTH_SURFACE_MODEL : createBodySurfaceModel(celestialBody("earth"), {
        ...EARTH_SURFACE_MODEL, projection: "geographic", hasPolarCaps: false,
      });
      const world = createWorldRuntime({ body: celestialBody("earth"), renderer, initialView: seed,
        surface: { baseTexture: new THREE.Texture(), disposeBaseTexture: true, surfaceModel,
          workers: () => ({ addEventListener() {}, removeEventListener() {}, postMessage() {}, terminate() {} }) as unknown as Worker },
      });
      vi.spyOn(world.surface, "sampleElevationMetres").mockReturnValue(height);
      return world;
    });
    try {
      const radius = EARTH_SURFACE_MODEL.referenceRadiusM / 100;
      const posed = solveBodySurfacePose({ contact: contactFrame(47, 11), terrainMultiplier: 2 },
        new THREE.Vector2(), radius, EARTH_SURFACE_MODEL, 500);
      const frame = { camera, terrainMultiplier: 2,
        pose: { position: posed.centre, orientation: posed.bodyToWorld, displayRadiusM: radius } };
      const [active, candidate] = worlds.map(world => world.updateFromCamera(frame));
      expect(active!.observerHeightWorldM).toBeCloseTo(1.65, 7);
      expect(candidate!.observerHeightWorldM).toBeCloseTo(2.65, 7);
      expect(active!.projection).toBe("web-mercator");
      expect(candidate!.projection).toBe("geographic");
      for (const world of worlds) {
        expect(world.surface.sampleElevationMetres).toHaveBeenCalledWith(expect.closeTo(47, 7), expect.closeTo(11, 7));
        expect(world.surface.getTileDebugControls().terrain.effective_target_zoom)
          .toBe(terrainTargetForView(world.getView(), 512).maxZoom);
      }
    } finally { for (const world of worlds) world.dispose(); }
  });
});
