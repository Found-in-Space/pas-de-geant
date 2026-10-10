import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { observerHeightForImageryZoom } from "@found-in-space/worlds/imagery-core";
import { lunarSurfaceSource } from "./lunar-configuration.js";
import { MOON_SURFACE_MODEL } from "@found-in-space/worlds/surface-model";
import { createWorldRuntime, celestialBody, contactFrame } from "@found-in-space/worlds";
import { orbitalDragRadiansPerPixel } from "@found-in-space/worlds/world-navigation";

const DISPLAY_RADIUS_M = 2.25;
const ABSOLUTE_MINIMUM_HEIGHT_M = 0.012;
const MAXIMUM_DISTANCE_M = 18;
const MAXIMUM_DRAG_RADIANS_PER_PIXEL = 0.002;
const INITIAL_DISTANCE_M = 5.8;
const INITIAL_LATITUDE_DEGREES = 18;
const INITIAL_LONGITUDE_DEGREES = -24;
const PHYSICAL_TERRAIN_MULTIPLIER = 1;
const EXAGGERATED_TERRAIN_MULTIPLIER = 5;

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}.`);
  return value as T;
};

const sceneRoot = element<HTMLDivElement>("scene-root");
const coordinatesReadout = element<HTMLElement>("coordinates-readout");
const altitudeReadout = element<HTMLElement>("altitude-readout");
const textureReadout = element<HTMLElement>("texture-readout");
const loadingState = element<HTMLElement>("loading-state");
const exaggeratedTopography = element<HTMLInputElement>(
  "exaggerated-topography",
);

function terrainMultiplier(): number {
  return exaggeratedTopography.checked
    ? EXAGGERATED_TERRAIN_MULTIPLIER
    : PHYSICAL_TERRAIN_MULTIPLIER;
}

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance",
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.3;
renderer.setClearColor(0x050507, 1);
sceneRoot.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.002,
  100,
);

function directionForCoordinates(
  latitudeDegrees: number,
  longitudeDegrees: number,
): THREE.Vector3 {
  return contactFrame(latitudeDegrees, longitudeDegrees).upEcef;
}

const initialDirection = directionForCoordinates(
  INITIAL_LATITUDE_DEGREES,
  INITIAL_LONGITUDE_DEGREES,
);
camera.position.copy(initialDirection).multiplyScalar(INITIAL_DISTANCE_M);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.minDistance = DISPLAY_RADIUS_M + ABSOLUTE_MINIMUM_HEIGHT_M;
controls.maxDistance = MAXIMUM_DISTANCE_M;
controls.rotateSpeed = 0.42;
controls.zoomSpeed = 0.85;
controls.target.set(0, 0, 0);
controls.update();

const source = await lunarSurfaceSource(renderer);
const imageryProvider = source.imageryProvider;
const maximumNativeZoom = imageryProvider?.maxZoom ?? 2;
const world = createWorldRuntime({
  body: celestialBody("moon"),
  renderer,
  surface: source,
  initialView: {
    latitudeDegrees: INITIAL_LATITUDE_DEGREES,
    longitudeDegrees: INITIAL_LONGITUDE_DEGREES,
    displayRadiusM: DISPLAY_RADIUS_M,
    terrainMultiplier: terrainMultiplier(),
    observerHeightWorldM: INITIAL_DISTANCE_M - DISPLAY_RADIUS_M,
    focalLengthPixels: 1_000,
  },
});
const surface = world.surface;
surface.setTileMaxZoom({ target: "both", value: maximumNativeZoom });
world.setSunlightDirection(new THREE.Vector3(4, 2.6, 3));
scene.add(world.object3d);

scene.onBeforeRender = (_renderer, _scene, renderCamera): void => {
  world.beforeRender(renderCamera);
};

const viewDirection = new THREE.Vector3();
let lastViewSignature = "";
let firstSurfaceShown = false;
const zoomInButton = element<HTMLButtonElement>("zoom-in");
const zoomOutButton = element<HTMLButtonElement>("zoom-out");

function focalLengthPixels(): number {
  const drawingBufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  return drawingBufferSize.y /
    (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

function currentView(): {
  latitudeDegrees: number;
  longitudeDegrees: number;
  distanceM: number;
} {
  viewDirection.copy(camera.position).sub(controls.target);
  const distanceM = viewDirection.length();
  viewDirection.multiplyScalar(1 / distanceM);
  return {
    latitudeDegrees: THREE.MathUtils.radToDeg(Math.asin(viewDirection.y)),
    longitudeDegrees: THREE.MathUtils.radToDeg(
      Math.atan2(-viewDirection.z, viewDirection.x),
    ),
    distanceM,
  };
}

function hemisphere(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(1)}°${value >= 0 ? positive : negative}`;
}

function updateSurface(): void {
  let view = currentView();
  const currentTerrainMultiplier = terrainMultiplier();
  const minimumObserverHeightM = imageryProvider
    ? observerHeightForImageryZoom({
        projection: MOON_SURFACE_MODEL.projection,
        displayRadiusM: DISPLAY_RADIUS_M,
        latitudeDegrees: view.latitudeDegrees,
        focalLengthPixels: focalLengthPixels(),
        tilePixels: imageryProvider.tileSize,
        zoom: imageryProvider.maxZoom,
      })
    : ABSOLUTE_MINIMUM_HEIGHT_M;
  controls.minDistance = DISPLAY_RADIUS_M + Math.max(
    ABSOLUTE_MINIMUM_HEIGHT_M,
    minimumObserverHeightM,
  );
  if (view.distanceM < controls.minDistance) {
    camera.position.copy(viewDirection).multiplyScalar(controls.minDistance);
    controls.update();
    view = currentView();
  }
  controls.rotateSpeed = orbitalDragRadiansPerPixel(
    view.distanceM,
    DISPLAY_RADIUS_M,
    renderer.domElement.clientHeight /
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)),
    MAXIMUM_DRAG_RADIANS_PER_PIXEL,
  ) * renderer.domElement.clientHeight / (2 * Math.PI);
  const signature = [
    view.latitudeDegrees.toFixed(4),
    view.longitudeDegrees.toFixed(4),
    view.distanceM.toFixed(4),
    currentTerrainMultiplier,
    window.innerHeight,
  ].join(":");
  if (signature !== lastViewSignature) {
    lastViewSignature = signature;
    world.update({
      latitudeDegrees: view.latitudeDegrees,
      longitudeDegrees: view.longitudeDegrees,
      displayRadiusM: DISPLAY_RADIUS_M,
      terrainMultiplier: currentTerrainMultiplier,
      observerHeightWorldM: Math.max(
        0.001,
        view.distanceM - DISPLAY_RADIUS_M,
      ),
      focalLengthPixels: focalLengthPixels(),
    });
  }

  coordinatesReadout.textContent = `${
    hemisphere(view.latitudeDegrees, "N", "S")
  } · ${hemisphere(view.longitudeDegrees, "E", "W")}`;
  const altitudeKm = Math.max(0, view.distanceM - DISPLAY_RADIUS_M) /
    DISPLAY_RADIUS_M * MOON_SURFACE_MODEL.referenceRadiusM / 1_000;
  altitudeReadout.textContent = altitudeKm >= 1_000
    ? `${(altitudeKm / 1_000).toFixed(1)}k km`
    : `${Math.round(altitudeKm).toLocaleString()} km`;
  const textureZoom = surface.getTileDebugControls().textures
    .effective_target_zoom;
  const readiness = world.getReadiness();
  textureReadout.textContent = imageryProvider && readiness.imagery !== "fallback"
    ? `LROC 100 m · z${textureZoom}/${imageryProvider.maxZoom}`
    : "Bundled 2K fallback";
  zoomInButton.disabled = view.distanceM <= controls.minDistance + 1e-6;
  zoomOutButton.disabled = view.distanceM >= controls.maxDistance - 1e-6;

  if (
    !firstSurfaceShown &&
    readiness.ready
  ) {
    firstSurfaceShown = true;
    loadingState.hidden = true;
  }
}

function setDistance(distanceM: number): void {
  const direction = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(direction.multiplyScalar(THREE.MathUtils.clamp(
    distanceM,
    controls.minDistance,
    controls.maxDistance,
  )));
  controls.update();
  updateSurface();
}

function resetView(): void {
  camera.position.copy(initialDirection).multiplyScalar(INITIAL_DISTANCE_M);
  controls.target.set(0, 0, 0);
  controls.update();
  updateSurface();
}

zoomInButton.addEventListener("click", () => {
  setDistance(currentView().distanceM * 0.72);
});
zoomOutButton.addEventListener("click", () => {
  setDistance(currentView().distanceM / 0.72);
});
element<HTMLButtonElement>("reset-view").addEventListener("click", resetView);
exaggeratedTopography.addEventListener("change", () => {
  lastViewSignature = "";
  updateSurface();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "+" || event.key === "=") {
    setDistance(currentView().distanceM * 0.82);
    event.preventDefault();
  } else if (event.key === "-" || event.key === "_") {
    setDistance(currentView().distanceM / 0.82);
    event.preventDefault();
  } else if (event.key === "0") {
    resetView();
    event.preventDefault();
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  lastViewSignature = "";
});

function render(): void {
  controls.update();
  updateSurface();
  world.processFrame();
  renderer.render(scene, camera);
  animationFrame = requestAnimationFrame(render);
}

updateSurface();
let animationFrame = requestAnimationFrame(render);

window.addEventListener("pagehide", () => {
  cancelAnimationFrame(animationFrame);
  controls.dispose();
  world.dispose();
  renderer.dispose();
}, { once: true });
