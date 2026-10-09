import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { observerHeightForImageryZoom } from "./imagery-core.js";
import {
  LUNAR_DISPLAY_TONE_EXPONENT,
  lunarElevationProvider,
  lunarImageryProvider,
} from "./lunar-configuration.js";
import { MOON_SURFACE_MODEL } from "./surface-model.js";
import { TerrainSurface } from "./terrain-surface.js";
import { tileProxyUrl } from "./tile-proxy.js";
import { orbitalDragRadiansPerPixel } from "./world-navigation.js";

const DISPLAY_RADIUS_M = 2.25;
const ABSOLUTE_MINIMUM_HEIGHT_M = 0.012;
const MAXIMUM_DISTANCE_M = 18;
const MAXIMUM_DRAG_RADIANS_PER_PIXEL = 0.002;
const INITIAL_DISTANCE_M = 5.8;
const INITIAL_LATITUDE_DEGREES = 18;
const INITIAL_LONGITUDE_DEGREES = -24;

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
  const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
  const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
  return new THREE.Vector3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.sin(latitude),
    -Math.cos(latitude) * Math.sin(longitude),
  );
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

const textureLoader = new THREE.TextureLoader();
const imageryProvider = lunarImageryProvider();
const baseTexture = imageryProvider
  ? await textureLoader.loadAsync(
    tileProxyUrl("lunar-imagery", { z: 0, x: 0, y: 0 }),
  ).catch(
    (error: unknown) => {
      console.warn("LROC z0 base tile is unavailable; using bundled fallback:", error);
      return textureLoader.loadAsync(
        `${import.meta.env.BASE_URL}lroc-color-2k.jpg`,
      );
    },
  )
  : await textureLoader.loadAsync(
    `${import.meta.env.BASE_URL}lroc-color-2k.jpg`,
  );
baseTexture.colorSpace = THREE.SRGBColorSpace;
baseTexture.flipY = false;
baseTexture.wrapS = THREE.RepeatWrapping;
baseTexture.wrapT = THREE.ClampToEdgeWrapping;
baseTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
baseTexture.needsUpdate = true;

const maximumNativeZoom = imageryProvider?.maxZoom ?? 2;
const surface = new TerrainSurface({
  renderer,
  baseTexture,
  imageryProvider,
  elevationProvider: lunarElevationProvider(),
  surfaceModel: MOON_SURFACE_MODEL,
  albedoToneExponent: LUNAR_DISPLAY_TONE_EXPONENT,
  initialView: {
    latitudeDegrees: INITIAL_LATITUDE_DEGREES,
    longitudeDegrees: INITIAL_LONGITUDE_DEGREES,
    displayRadiusM: DISPLAY_RADIUS_M,
    terrainMultiplier: 0,
    observerHeightWorldM: INITIAL_DISTANCE_M - DISPLAY_RADIUS_M,
    focalLengthPixels: 1_000,
  },
});
surface.setTileMaxZoom({ target: "both", value: maximumNativeZoom });
surface.group.scale.setScalar(DISPLAY_RADIUS_M);
surface.setSunlightDirection(new THREE.Vector3(4, 2.6, 3));
scene.add(surface.group);

scene.onBeforeRender = (_renderer, _scene, renderCamera): void => {
  surface.updateRenderVisibility(renderCamera);
};

const viewDirection = new THREE.Vector3();
let lastViewSignature = "";
let firstSurfaceShown = false;
const zoomInButton = element<HTMLButtonElement>("zoom-in");
const zoomOutButton = element<HTMLButtonElement>("zoom-out");

function focalLengthPixels(): number {
  return window.innerHeight /
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
  const minimumObserverHeightM = imageryProvider
    ? observerHeightForImageryZoom({
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
    focalLengthPixels(),
    MAXIMUM_DRAG_RADIANS_PER_PIXEL,
  ) * renderer.domElement.clientHeight / (2 * Math.PI);
  const signature = [
    view.latitudeDegrees.toFixed(4),
    view.longitudeDegrees.toFixed(4),
    view.distanceM.toFixed(4),
    window.innerHeight,
  ].join(":");
  if (signature !== lastViewSignature) {
    lastViewSignature = signature;
    surface.update({
      latitudeDegrees: view.latitudeDegrees,
      longitudeDegrees: view.longitudeDegrees,
      displayRadiusM: DISPLAY_RADIUS_M,
      terrainMultiplier: 0,
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
  textureReadout.textContent = imageryProvider
    ? `LROC 100 m · z${textureZoom}/${imageryProvider.maxZoom}`
    : "Bundled 2K fallback";
  zoomInButton.disabled = view.distanceM <= controls.minDistance + 1e-6;
  zoomOutButton.disabled = view.distanceM >= controls.maxDistance - 1e-6;

  if (
    !firstSurfaceShown &&
    (imageryProvider
      ? surface.hasCompleteImagery
      : surface.hasCommittedSurface)
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
  surface.processFrame();
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

updateSurface();
requestAnimationFrame(render);

window.addEventListener("pagehide", () => {
  controls.dispose();
  surface.dispose();
  baseTexture.dispose();
  renderer.dispose();
}, { once: true });
