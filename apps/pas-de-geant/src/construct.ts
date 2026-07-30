import "./construct.css";

import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import {
  controllerIntent,
  freshButtonLatch,
  headRelativeTravel,
} from "./controller-input.js";
import {
  CONSTRUCT_LATITUDE_DEGREES,
  CONSTRUCT_LONGITUDE_DEGREES,
  CONSTRUCT_SCALE_FACTORS,
  constructDisplayRadiusM,
  constructScaleFactor,
} from "./construct-core.js";
import { ConstructTerrainRenderer } from "./construct-terrain.js";
import {
  INITIAL_DISPLAY_RADIUS_M,
  applyLogarithmicScale,
  applyRadialMultiplierRate,
  coordinatesForFrame,
  horizontalWorldMetresForKilometres,
  initialPlanetState,
  radialWorldMetresForKilometres,
  rollContactFrame,
  solvePlanetPose,
} from "./planet-state.js";

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}.`);
  return value as T;
};

const sceneRoot = element<HTMLDivElement>("construct-scene");
const vrSlot = element<HTMLDivElement>("construct-vr");
const coordinatesReadout = element<HTMLElement>("construct-coordinates");
const scaleReadout = element<HTMLElement>("construct-scale");
const radialReadout = element<HTMLElement>("construct-radial");
const zoomReadout = element<HTMLElement>("construct-zoom");
const tilesReadout = element<HTMLElement>("construct-tiles");
const oceanReadout = element<HTMLElement>("construct-ocean");
const loadingState = element<HTMLElement>("construct-loading");
const resetButton = element<HTMLButtonElement>("construct-reset");
const oceanButton = element<HTMLButtonElement>("construct-ocean-button");
const presetButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-scale-factor]"),
];
const constructParameters = new URLSearchParams(window.location.search);
const requestedFoveation = Number(
  constructParameters.get("foveation") ?? "0",
);
const xrFoveation = Number.isFinite(requestedFoveation)
  ? Math.max(0, Math.min(1, requestedFoveation))
  : 0;

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.xr.setFramebufferScaleFactor(1);
sceneRoot.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x071018);
const camera = new THREE.PerspectiveCamera(
  62,
  window.innerWidth / window.innerHeight,
  0.05,
  10_000,
);
camera.position.set(0, 1.65, 0);
camera.rotation.order = "YXZ";
let pitch = -0.56;
let yaw = 0;
camera.rotation.set(pitch, yaw, 0);

const planetRoot = new THREE.Group();
scene.add(planetRoot);

const texture = await new THREE.TextureLoader().loadAsync(
  new URL("../bluemarble-2048.png", window.location.href).href,
);
texture.colorSpace = THREE.SRGBColorSpace;
texture.flipY = false;
texture.minFilter = THREE.LinearMipmapLinearFilter;
texture.magFilter = THREE.LinearFilter;
texture.generateMipmaps = true;
texture.anisotropy = Math.min(
  8,
  renderer.capabilities.getMaxAnisotropy(),
);
texture.needsUpdate = true;

const terrain = new ConstructTerrainRenderer(texture);
planetRoot.add(terrain.group);

const initialScaleFactor = constructScaleFactor(
  constructParameters.get("scale"),
);
let state = initialPlanetState(
  CONSTRUCT_LATITUDE_DEGREES,
  CONSTRUCT_LONGITUDE_DEGREES,
);
state.displayRadiusM = constructDisplayRadiusM(initialScaleFactor);
let lodBias = 0;
let oceanSurface = true;
let tileOverlayVisible = false;

const headsetFloorPosition = new THREE.Vector2();
const xrHeadPosition = new THREE.Vector3();
const xrViewQuaternion = new THREE.Quaternion();
const desktopTravel = new THREE.Vector2();
const keys = new Set<string>();
const buttonLatch = freshButtonLatch();
let previousXrHead: THREE.Vector2 | null = null;
let previousFrameMs = performance.now();
let pointerActive = false;
let pointerX = 0;
let pointerY = 0;
let smoothedContactHeightM = 0;
let contactHeightInitialized = false;

function resetConstruct(scaleFactor = initialScaleFactor): void {
  state = initialPlanetState(
    CONSTRUCT_LATITUDE_DEGREES,
    CONSTRUCT_LONGITUDE_DEGREES,
  );
  state.displayRadiusM = constructDisplayRadiusM(scaleFactor);
  lodBias = 0;
  oceanSurface = true;
  contactHeightInitialized = false;
}

function setScalePreset(scaleFactor: number): void {
  resetConstruct(scaleFactor);
  const url = new URL(window.location.href);
  url.searchParams.set("scale", String(scaleFactor));
  window.history.replaceState(null, "", url);
}

function resetGroundLevel(): void {
  const status = terrain.status();
  if (!status.contactHeightAvailable) return;
  smoothedContactHeightM = status.contactHeightM;
  contactHeightInitialized = true;
}

function updatePhysicalWalking(): void {
  const xrCamera = renderer.xr.getCamera();
  xrCamera.getWorldPosition(xrHeadPosition);
  headsetFloorPosition.set(xrHeadPosition.x, xrHeadPosition.z);
  if (previousXrHead) {
    const displacement = headsetFloorPosition.clone().sub(previousXrHead);
    if (displacement.length() < 0.4) {
      state.contact = rollContactFrame(
        state.contact,
        displacement,
        state.displayRadiusM,
      );
    }
  }
  previousXrHead = headsetFloorPosition.clone();
}

function updateXrControls(deltaSeconds: number, nowMs: number): void {
  const session = renderer.xr.getSession();
  if (!session) return;
  const intent = controllerIntent(session, nowMs, buttonLatch);
  renderer.xr.getCamera().getWorldQuaternion(xrViewQuaternion);
  const travel = headRelativeTravel(intent.travel, xrViewQuaternion);
  if (travel.lengthSq() > 1) travel.normalize();
  travel.multiplyScalar((intent.boost ? 4.2 : 1.35) * deltaSeconds);
  if (travel.lengthSq() > 0) {
    state.contact = rollContactFrame(
      state.contact,
      travel,
      state.displayRadiusM,
    );
  }
  state.displayRadiusM = Math.min(
    constructDisplayRadiusM(1000),
    applyLogarithmicScale(
      state.displayRadiusM,
      intent.scaleAxis,
      deltaSeconds,
    ),
  );
  state.radialMultiplier = applyRadialMultiplierRate(
    state.radialMultiplier,
    intent.radialAxis,
    deltaSeconds,
  );
  lodBias = Math.max(
    -3,
    Math.min(3, lodBias + intent.terrainLodBiasDelta),
  );
  if (intent.toggleTileOverlay) {
    tileOverlayVisible = !tileOverlayVisible;
    terrain.setTileOverlayVisible(tileOverlayVisible);
  }
  if (intent.toggleOcean) oceanSurface = !oceanSurface;
  if (intent.reset) resetConstruct(initialScaleFactor);
  if (intent.resetGroundLevel) resetGroundLevel();
}

function updateDesktopControls(deltaSeconds: number): void {
  desktopTravel.set(
    Number(keys.has("KeyD")) - Number(keys.has("KeyA")),
    -(Number(keys.has("KeyW")) - Number(keys.has("KeyS"))),
  );
  if (desktopTravel.lengthSq() > 1) desktopTravel.normalize();
  if (desktopTravel.lengthSq() > 0) {
    const travel = headRelativeTravel(desktopTravel, camera.quaternion)
      .multiplyScalar(
        (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 4.2 : 1.35) *
          deltaSeconds,
      );
    state.contact = rollContactFrame(
      state.contact,
      travel,
      state.displayRadiusM,
    );
  }
  const scaleAxis =
    Number(keys.has("KeyX")) - Number(keys.has("KeyZ"));
  const radialAxis =
    Number(keys.has("KeyV")) - Number(keys.has("KeyC"));
  state.displayRadiusM = Math.min(
    constructDisplayRadiusM(1000),
    applyLogarithmicScale(
      state.displayRadiusM,
      scaleAxis,
      deltaSeconds,
    ),
  );
  state.radialMultiplier = applyRadialMultiplierRate(
    state.radialMultiplier,
    radialAxis,
    deltaSeconds,
  );
}

function formatRoomDistance(metres: number): string {
  if (metres < 0.0095) return `${(metres * 1000).toFixed(1)} mm`;
  if (metres < 1) return `${(metres * 100).toFixed(1)} cm`;
  return `${metres.toFixed(1)} m`;
}

function updatePresentation(deltaSeconds = 0): void {
  const coordinates = coordinatesForFrame(state.contact);
  const pose = solvePlanetPose(state, headsetFloorPosition);
  planetRoot.quaternion.copy(pose.earthToWorld);
  planetRoot.position.copy(pose.centre);
  planetRoot.scale.setScalar(state.displayRadiusM);
  terrain.update({
    latitudeDegrees: coordinates.latitudeDegrees,
    longitudeDegrees: coordinates.longitudeDegrees,
    displayRadiusM: state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    oceanSurface,
    lodBias,
  });
  const status = terrain.status();
  if (status.contactHeightAvailable) {
    if (!contactHeightInitialized) {
      smoothedContactHeightM = status.contactHeightM;
      contactHeightInitialized = true;
    } else if (deltaSeconds > 0) {
      const response = 1 - Math.exp(-deltaSeconds / 8);
      const requestedStep =
        (status.contactHeightM - smoothedContactHeightM) * response;
      const worldMetresPerHeightMetre =
        radialWorldMetresForKilometres(
          0.001,
          state.displayRadiusM,
          state.radialMultiplier,
        );
      const maximumHeightStep =
        worldMetresPerHeightMetre > 1e-9
          ? 0.04 * deltaSeconds / worldMetresPerHeightMetre
          : Infinity;
      smoothedContactHeightM += Math.max(
        -maximumHeightStep,
        Math.min(maximumHeightStep, requestedStep),
      );
    }
  }
  planetRoot.position.y -= radialWorldMetresForKilometres(
    smoothedContactHeightM / 1_000,
    state.displayRadiusM,
    state.radialMultiplier,
  );
  const scaleFactor = state.displayRadiusM / INITIAL_DISPLAY_RADIUS_M;
  coordinatesReadout.textContent =
    `${coordinates.latitudeDegrees.toFixed(3)}° N · ` +
    `${coordinates.longitudeDegrees.toFixed(3)}° E`;
  scaleReadout.textContent =
    `${scaleFactor.toFixed(scaleFactor < 10 ? 2 : 0)}× · ` +
    `1 km = ${formatRoomDistance(
      horizontalWorldMetresForKilometres(1, state.displayRadiusM),
    )}`;
  radialReadout.textContent =
    `${state.radialMultiplier.toFixed(1)}× · ` +
    `1 km = ${formatRoomDistance(
      radialWorldMetresForKilometres(
        1,
        state.displayRadiusM,
        state.radialMultiplier,
      ),
    )}`;
  zoomReadout.textContent =
    `z${status.zoom} · ${status.tileWidthM.toFixed(2)} m/tile`;
  tilesReadout.textContent =
    `${status.rendered}/${status.expected} meshes · ` +
    `${status.vertices.toLocaleString()} vertices`;
  oceanReadout.textContent = oceanSurface ? "Surface" : "Bathymetry";
  oceanButton.textContent = oceanSurface ? "Reveal seabed" : "Restore ocean";
  loadingState.hidden = status.rendered > 0;
  for (const button of presetButtons) {
    const preset = Number(button.dataset.scaleFactor);
    button.dataset.active = String(Math.abs(scaleFactor - preset) < 0.01);
  }
  document.body.dataset.constructReady = String(status.ready);
  document.body.dataset.constructScaleFactor =
    scaleFactor.toFixed(scaleFactor < 10 ? 2 : 0);
  document.body.dataset.constructZoom = String(status.zoom);
  document.body.dataset.constructTileWidth = status.tileWidthM.toFixed(4);
  document.body.dataset.constructMeshCount = String(status.rendered);
  document.body.dataset.constructExpectedMeshes = String(status.expected);
  document.body.dataset.constructRequiredTiles = String(status.required);
  document.body.dataset.constructDecodedTiles = String(status.decoded);
  document.body.dataset.constructUnavailableTiles = String(status.unavailable);
  document.body.dataset.constructVertices = String(status.vertices);
  document.body.dataset.constructMeshBuilds = String(status.meshBuilds);
  document.body.dataset.constructSeamChecks = String(status.seamChecks);
  document.body.dataset.constructSeamPositionError =
    status.seamPositionError.toExponential(3);
  document.body.dataset.constructSeamOffsetError =
    status.seamOffsetErrorM.toExponential(3);
  document.body.dataset.constructContactHeight =
    status.contactHeightM.toFixed(1);
  document.body.dataset.constructTopographySource = "mapterhorn";
  document.body.dataset.constructTextureSource = "blue-marble";
  document.body.dataset.constructLodBias = String(lodBias);
  document.body.dataset.constructTileOverlay =
    String(tileOverlayVisible);
  document.body.dataset.constructXrFoveation = String(xrFoveation);
}

renderer.domElement.addEventListener("pointerdown", (event) => {
  pointerActive = true;
  pointerX = event.clientX;
  pointerY = event.clientY;
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener("pointermove", (event) => {
  if (!pointerActive || renderer.xr.isPresenting) return;
  yaw -= (event.clientX - pointerX) * 0.0035;
  pitch -= (event.clientY - pointerY) * 0.0035;
  pitch = Math.max(-1.35, Math.min(1.1, pitch));
  camera.rotation.set(pitch, yaw, 0);
  pointerX = event.clientX;
  pointerY = event.clientY;
});
renderer.domElement.addEventListener("pointerup", (event) => {
  pointerActive = false;
  if (renderer.domElement.hasPointerCapture(event.pointerId)) {
    renderer.domElement.releasePointerCapture(event.pointerId);
  }
});

window.addEventListener("keydown", (event) => {
  if (event.repeat && ["KeyO", "Backspace"].includes(event.code)) return;
  if (event.code === "KeyO") oceanSurface = !oceanSurface;
  if (event.code === "Backspace") resetConstruct(initialScaleFactor);
  if (
    [
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "KeyZ",
      "KeyX",
      "KeyC",
      "KeyV",
      "ShiftLeft",
      "ShiftRight",
      "KeyO",
      "Backspace",
    ].includes(event.code)
  ) {
    keys.add(event.code);
    event.preventDefault();
  }
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("blur", () => keys.clear());
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
});
window.addEventListener("beforeunload", () => terrain.dispose());

for (const button of presetButtons) {
  button.addEventListener("click", () => {
    setScalePreset(Number(button.dataset.scaleFactor));
  });
}
resetButton.addEventListener("click", () => resetConstruct(initialScaleFactor));
oceanButton.addEventListener("click", () => {
  oceanSurface = !oceanSurface;
});

vrSlot.append(VRButton.createButton(renderer));
renderer.xr.addEventListener("sessionstart", () => {
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  previousXrHead = null;
  renderer.xr.setFoveation(xrFoveation);
});
renderer.xr.addEventListener("sessionend", () => {
  camera.position.set(0, 1.65, 0);
  camera.rotation.set(pitch, yaw, 0);
  headsetFloorPosition.set(0, 0);
  previousXrHead = null;
});

function render(nowMs: number): void {
  const deltaSeconds = Math.min(0.05, (nowMs - previousFrameMs) / 1000);
  previousFrameMs = nowMs;
  if (renderer.xr.isPresenting) {
    updatePhysicalWalking();
    updateXrControls(deltaSeconds, nowMs);
  } else {
    updateDesktopControls(deltaSeconds);
  }
  updatePresentation(deltaSeconds);
  renderer.render(scene, camera);
}

updatePresentation();
renderer.setAnimationLoop(render);
