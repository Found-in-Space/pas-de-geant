import * as THREE from "three";
import { createGeantBodyAppearancePlugin, type GeantViewer } from "@found-in-space/pas-de-geant";
import { createReferenceSurfaceFactory } from "@found-in-space/pas-de-geant/browser";
import {
  celestialBody, createWorldRuntime, observeBodySurface,
  type TerrainSurfaceView, type WorldRuntime,
} from "@found-in-space/pas-de-geant/worlds";
import { createWorldSkykitPlugin } from "@found-in-space/pas-de-geant/worlds/skykit";
import { mountViewer, runCase } from "./case.js";
import { createSunAppearance } from "@found-in-space/pas-de-geant/appearances";

const bodies = ["moon", "earth", "sun"] as const;
// Keep all sizes on one scale, with a 20 cm Earth in comfortable viewing range.
const earth = celestialBody("earth");
const earthRadiusM = earth.shape.kind === "ellipsoid" ? earth.shape.equatorialRadiusM : earth.shape.radiusM;
const scaleDenominator = 2 * earthRadiusM / 0.2;
const centreY = 1.45, rowZ = -0.85;
const entries = bodies.map(id => {
  const body = celestialBody(id);
  const physicalRadiusM = body.shape.kind === "ellipsoid" ? body.shape.equatorialRadiusM : body.shape.radiusM;
  return { body, radiusM: physicalRadiusM / scaleDenominator };
});

function label(name: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = 128;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#101820"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.textAlign = "center"; context.textBaseline = "middle"; context.fillStyle = "#e5edf4";
  context.font = "600 60px system-ui"; context.fillText(name, 256, 64);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, toneMapped: false });
  const sprite = new THREE.Sprite(material); sprite.scale.set(0.22, 0.055, 1);
  return sprite;
}

async function compose(viewer: GeantViewer, signal: AbortSignal) {
  const annotations = new THREE.Group(); annotations.name = "size-comparison:annotations";
  const grid = new THREE.GridHelper(8, 16, 0x637585, 0x304050); grid.position.z = rowZ;
  const ambient = new THREE.AmbientLight(0xffffff, 1);
  viewer.scene.add(annotations, grid, ambient);
  viewer.addDisposable(() => {
    annotations.traverse(object => {
      if (object instanceof THREE.Sprite) { object.material.map?.dispose(); object.material.dispose(); }
      if (object instanceof THREE.Line) { object.geometry.dispose(); (object.material as THREE.LineBasicMaterial).dispose(); }
    });
    annotations.removeFromParent(); grid.removeFromParent(); ambient.removeFromParent();
    grid.geometry.dispose();
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
  });

  const reference = createReferenceSurfaceFactory();
  const bufferSize = new THREE.Vector2();
  const illumination = new THREE.Vector3(0.3, 0.5, 1).normalize();
  for (const { body, radiusM } of entries) {
    signal.throwIfAborted();
    const displayRadiusM = body.referenceRadiusM / scaleDenominator;
    const centreX = body.id === "moon" ? -0.24 : body.id === "sun" ? radiusM + 0.6 : 0;
    if (body.id === "sun") {
      const sun = createGeantBodyAppearancePlugin({ body, signal,
        appearance: context => createSunAppearance(context, { animationTime: "presentation" }) });
      sun.object3d.scale.setScalar(displayRadiusM);
      sun.object3d.position.set(centreX, centreY, rowZ);
      await viewer.install(sun);
    } else {
      const initialView: TerrainSurfaceView = { latitudeDegrees: 0, longitudeDegrees: 0,
        displayRadiusM, terrainMultiplier: 1, observerHeightWorldM: -rowZ, focalLengthPixels: 600 };
      const surface = await reference({ body: body.id, renderer: viewer.renderer, signal });
      let world: WorldRuntime;
      try { world = createWorldRuntime({ body, renderer: viewer.renderer, initialView, surface }); }
      catch (error) { if (surface?.disposeBaseTexture) surface.baseTexture.dispose(); throw error; }
      // Authored per-body poses. No ephemeris or common Solar System placement is installed.
      world.object3d.position.set(centreX, centreY, rowZ);
      world.object3d.rotation.y = -Math.PI / 2;
      world.setSunlightDirection(illumination);
      await viewer.install(createWorldSkykitPlugin({ world, disposeWorld: true,
        getView() {
          const camera = viewer.renderer.xr.isPresenting ? viewer.renderer.xr.getCamera() : viewer.camera;
          const observed = observeBodySurface({ bodyId: body.id, root: world.object3d, camera,
            surface: world.surface ?? { sampleElevationMetres: () => 0 }, terrainMultiplier: 1 });
          viewer.renderer.getDrawingBufferSize(bufferSize);
          return { ...initialView, ...observed,
            focalLengthPixels: bufferSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(viewer.camera.fov / 2))) };
        },
      }));
    }

    const caption = label(body.name);
    const labelY = body.id === "moon" ? centreY - radiusM - 0.08 : centreY + radiusM + 0.08;
    caption.position.set(centreX, labelY, rowZ);
    // The Sun extends far to the right. Label its nearby edge inside the view.
    if (body.id === "sun") {
      caption.scale.set(0.28, 0.07, 1);
      caption.position.set(0.4, 1.85, rowZ);
    }
    annotations.add(caption);
    const direction = Math.sign(caption.position.y - centreY);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      body.id === "sun" ? new THREE.Vector3(centreX - radiusM, centreY, rowZ)
        : new THREE.Vector3(centreX, centreY + direction * radiusM, rowZ),
      new THREE.Vector3(caption.position.x, caption.position.y - direction * caption.scale.y / 2, rowZ),
    ]), new THREE.LineBasicMaterial({ color: 0x92cfff, toneMapped: false }));
    annotations.add(line);
  }

  function fitOverview() {
    if (signal.aborted || viewer.renderer.xr.isPresenting) return;
    // Frame the Earth/Moon pair; the same-scale Sun intentionally fills the side.
    const distance = Math.max(-rowZ, 0.4 /
      (Math.tan(THREE.MathUtils.degToRad(viewer.camera.fov / 2)) * viewer.camera.aspect));
    viewer.camera.position.set(-0.1, 1.65, rowZ + distance);
    viewer.camera.lookAt(-0.1, centreY, rowZ);
  }
  // Run after the session adapter restores its desktop camera position.
  const sessionEnded = () => { queueMicrotask(fitOverview); };
  viewer.renderer.xr.addEventListener("sessionend", sessionEnded);
  viewer.addDisposable(() => { viewer.renderer.xr.removeEventListener("sessionend", sessionEnded); });
  fitOverview();
  return { resize: fitOverview };
}

runCase(async () => {
  await mountViewer("world", { bodies, mode: "size-comparison", scaleDenominator, timeRate: 0,
    xr: true, movement: false, controls: false, compose });
});
