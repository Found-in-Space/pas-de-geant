import "./style.css";

import {
  createRuntime,
  type BitmapHandle,
} from "@found-in-space/touch-os";
import {
  createPoseAnchoredPanelDriver,
  createThreePanelSession,
  type ThreeHostPose,
} from "@found-in-space/touch-os/hosts/three";
import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import {
  AIRCRAFT_POLL_INTERVAL_MS,
  fetchAirplanesLive,
} from "./aircraft-feed.js";
import { AircraftLayer } from "./aircraft-layer.js";
import { shouldPollAircraft } from "./aircraft-lifecycle.js";
import { AtmosphereLayer } from "./atmosphere.js";
import {
  controllerIntent,
  freshButtonLatch,
  headRelativeTravel,
} from "./controller-input.js";
import { CelestialSphere } from "./celestial-sphere.js";
import {
  createHandPanelRoot,
  formatCoordinates,
  HAND_PANEL_SURFACE,
  HAND_PANEL_THEME,
} from "./hand-panel.js";
import {
  applyLogarithmicScale,
  applyRadialMultiplierRate,
  coordinatesForFrame,
  horizontalWorldMetresForKilometres,
  initialPlanetState,
  radialWorldMetresForKilometres,
  referenceDistanceForDisplayRadius,
  rollContactFrame,
  solvePlanetPose,
  type PlanetState,
} from "./planet-state.js";
import { resolveInitialLocation } from "../../shared/initial-location.js";
import { loadReliefDataset } from "./relief.js";
import { TerrainTileRenderer } from "./terrain-tiles.js";

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}.`);
  return value as T;
};

const sceneRoot = element<HTMLDivElement>("scene-root");
const vrSlot = element<HTMLDivElement>("vr-slot");
const loadingState = element<HTMLDivElement>("loading-state");
const errorState = element<HTMLDivElement>("error-state");
const errorMessage = element<HTMLParagraphElement>("error-message");
const coordinatesReadout = element<HTMLElement>("coordinates");
const scaleReadout = element<HTMLElement>("scale-readout");
const radialReadout = element<HTMLElement>("radial-readout");
const oceanReadout = element<HTMLElement>("ocean-readout");
const aircraftReadout = element<HTMLElement>("aircraft-readout");
const oceanButton = element<HTMLButtonElement>("ocean-button");
const resetButton = element<HTMLButtonElement>("reset-button");
const aircraftToggle = element<HTMLInputElement>("aircraft-toggle");
const initialLocationPromise = resolveInitialLocation();

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
    stencil: true,
  });
} catch (error) {
  loadingState.hidden = true;
  errorState.hidden = false;
  errorMessage.textContent =
    error instanceof Error ? error.message : "WebGL is unavailable.";
  throw error;
}
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
scene.background = new THREE.Color(0x01040a);
const camera = new THREE.PerspectiveCamera(
  62,
  window.innerWidth / window.innerHeight,
  0.025,
  1200,
);
camera.position.set(0, 1.65, 0);
camera.rotation.order = "YXZ";
camera.rotation.x = -0.55;

const planetRoot = new THREE.Group();
scene.add(planetRoot);

const celestialSphere = new CelestialSphere();
scene.add(celestialSphere.object3d);
document.body.dataset.starStatus = "loading";
document.body.dataset.starCount = "0";
void celestialSphere.load().then((result) => {
  document.body.dataset.starStatus = result.status;
  document.body.dataset.starCount = String(result.count);
  if (result.status === "unavailable") {
    console.warn("SkyKit star catalog is unavailable:", result.error);
  }
});

const fallbackTexture = await new THREE.TextureLoader().loadAsync(
  `${import.meta.env.BASE_URL}bluemarble-2048.png`,
);
fallbackTexture.colorSpace = THREE.SRGBColorSpace;
fallbackTexture.flipY = false;
fallbackTexture.needsUpdate = true;
fallbackTexture.anisotropy = Math.min(
  4,
  renderer.capabilities.getMaxAnisotropy(),
);

const relief = await loadReliefDataset();
document.body.dataset.reliefFallback = String(relief.fallback);
const renderingContext = renderer.getContext();
const detailStencilAvailable =
  renderingContext.getParameter(renderingContext.STENCIL_BITS) > 0;
const terrain = new TerrainTileRenderer(
  relief,
  fallbackTexture,
  detailStencilAvailable,
);
planetRoot.add(terrain.group);
const aircraftLayer = new AircraftLayer();
planetRoot.add(aircraftLayer.group);

const atmosphere = new AtmosphereLayer();
planetRoot.add(atmosphere.mesh);

const initialLocation = await initialLocationPromise;
document.body.dataset.locationSource = initialLocation.source;
let state = initialPlanetState(
  initialLocation.latitudeDegrees,
  initialLocation.longitudeDegrees,
);
const initialCoordinates = coordinatesForFrame(state.contact);
const earthMapBitmap: BitmapHandle = {
  kind: "bitmap",
  image: fallbackTexture.image,
  width: 2_048,
  height: 1_024,
  revision: 1,
};
const handPanelRuntime = createRuntime({
  root: createHandPanelRoot(initialCoordinates, earthMapBitmap),
  surface: HAND_PANEL_SURFACE,
  theme: HAND_PANEL_THEME,
});
const handPanelHostRoot = new THREE.Group();
handPanelHostRoot.name = "hand-panel-host";
scene.add(handPanelHostRoot);
const handPanelDriver = createPoseAnchoredPanelDriver({
  runtime: handPanelRuntime,
  parent: handPanelHostRoot,
  surface: HAND_PANEL_SURFACE,
  panelWidth: 0.32,
  panelHeight: 0.18,
  tiltRadians: -Math.PI * 0.24,
  offset: { x: 0.04, y: 0.05, z: -0.03 },
  depthTest: false,
  depthWrite: false,
  renderOrder: 100,
  textureQuality: {
    anisotropy: Math.min(4, renderer.capabilities.getMaxAnisotropy()),
  },
});
const handPanel = createThreePanelSession({
  key: "little-planet-earth-map",
  runtime: handPanelRuntime,
  driver: handPanelDriver,
  enabled: false,
});
handPanel.attach();
let handPanelLocationSignature =
  `${initialCoordinates.latitudeDegrees.toFixed(2)}:` +
  initialCoordinates.longitudeDegrees.toFixed(2);
let handPanelLastRedrawMs = -Infinity;
let handPanelRedrawCount = 1;
document.body.dataset.handPanelRedrawCount = String(handPanelRedrawCount);
let previousFrameMs = performance.now();
let previousXrHead: THREE.Vector2 | null = null;
const headsetFloorPosition = new THREE.Vector2();
const xrHeadPosition = new THREE.Vector3();
const xrViewQuaternion = new THREE.Quaternion();
const desktopTravel = new THREE.Vector2();
const keys = new Set<string>();
const buttonLatch = freshButtonLatch();
let handPanelVisible = true;
let pointerActive = false;
let pointerX = 0;
let pointerY = 0;
let yaw = 0;
let pitch = -0.55;
let aircraftEnabled = false;
let vrSessionActive = false;
let aircraftCount = 0;
let aircraftPollTimer: number | undefined;
let aircraftRequest: AbortController | undefined;

function resetPlanet(): void {
  state = initialPlanetState(
    initialLocation.latitudeDegrees,
    initialLocation.longitudeDegrees,
  );
  previousXrHead = null;
  updatePresentation();
}

function toggleOcean(): void {
  state.oceanMode =
    state.oceanMode === "surface" ? "revealed" : "surface";
  updatePresentation();
}

function updatePresentation(): void {
  const coordinates = coordinatesForFrame(state.contact);
  const pose = solvePlanetPose(state, headsetFloorPosition);
  planetRoot.quaternion.copy(pose.earthToWorld);
  planetRoot.position.copy(pose.centre);
  planetRoot.scale.setScalar(state.displayRadiusM);
  terrain.update(
    coordinates.latitudeDegrees,
    coordinates.longitudeDegrees,
    state.displayRadiusM,
    state.radialMultiplier,
    state.oceanMode === "surface",
  );
  atmosphere.update(state.radialMultiplier);
  oceanReadout.textContent =
    state.oceanMode === "surface" ? "Surface" : "Seabed revealed";
  oceanButton.textContent =
    state.oceanMode === "surface" ? "Reveal seabed" : "Restore ocean";
  coordinatesReadout.textContent = formatCoordinates(
    coordinates.latitudeDegrees,
    coordinates.longitudeDegrees,
  );
  const referenceDistance =
    referenceDistanceForDisplayRadius(state.displayRadiusM);
  const horizontalMetresPerKilometre =
    horizontalWorldMetresForKilometres(1, state.displayRadiusM);
  const radialMetresPerKilometre =
    radialWorldMetresForKilometres(
      1,
      state.displayRadiusM,
      state.radialMultiplier,
    );
  scaleReadout.textContent =
    `${referenceDistance < 1
      ? `1,000 km ≈ ${Math.round(referenceDistance * 100)} cm`
      : `1,000 km ≈ ${referenceDistance.toFixed(1)} m`} · ` +
    `1 km = ${formatRoomDistance(horizontalMetresPerKilometre)}`;
  radialReadout.textContent =
    `${state.radialMultiplier.toFixed(1)}× · ` +
    `1 km = ${formatRoomDistance(radialMetresPerKilometre)}`;
  syncHandPanelLocation(
    coordinates.latitudeDegrees,
    coordinates.longitudeDegrees,
  );
}

function formatRoomDistance(metres: number): string {
  if (metres === 0) return "0";
  if (metres < 0.0095) return `${(metres * 1_000).toFixed(1)} mm`;
  if (metres < 1) return `${(metres * 100).toFixed(1)} cm`;
  return `${metres.toFixed(2)} m`;
}

function syncHandPanelLocation(
  latitudeDegrees: number,
  longitudeDegrees: number,
): void {
  if (!renderer.xr.isPresenting || !handPanelVisible) return;
  const signature =
    `${latitudeDegrees.toFixed(2)}:${longitudeDegrees.toFixed(2)}`;
  if (signature === handPanelLocationSignature) return;
  const nowMs = performance.now();
  if (nowMs - handPanelLastRedrawMs < 100) return;
  handPanelLocationSignature = signature;
  handPanelLastRedrawMs = nowMs;
  handPanelRuntime.setRoot(
    createHandPanelRoot(
      { latitudeDegrees, longitudeDegrees },
      earthMapBitmap,
    ),
  );
  handPanelRedrawCount += 1;
  document.body.dataset.handPanelRedrawCount =
    String(handPanelRedrawCount);
}

const handPanelAnchorPosition = new THREE.Vector3();
const handPanelAnchorQuaternion = new THREE.Quaternion();
const xrControllerBindings = [0, 1].map((index) => ({
  controller: renderer.xr.getController(index),
  grip: renderer.xr.getControllerGrip(index),
  connected: false,
  handedness: "none" as XRHandedness,
}));

for (const binding of xrControllerBindings) {
  binding.controller.addEventListener("connected", (event) => {
    const source = (event as THREE.Event & { data?: XRInputSource }).data;
    binding.connected = true;
    binding.handedness = source?.handedness ?? "none";
  });
  binding.controller.addEventListener("disconnected", () => {
    binding.connected = false;
    binding.handedness = "none";
  });
  scene.add(binding.controller);
  scene.add(binding.grip);
}

function resolveHandPanelAnchorPose(): ThreeHostPose | undefined {
  const binding =
    xrControllerBindings.find(
      (candidate) =>
        candidate.connected && candidate.handedness === "left",
    ) ??
    xrControllerBindings.find(
      (candidate) =>
        candidate.connected && candidate.handedness === "none",
    ) ??
    xrControllerBindings.find((candidate) => candidate.connected);
  if (!binding) return undefined;
  binding.grip.getWorldPosition(handPanelAnchorPosition);
  binding.grip.getWorldQuaternion(handPanelAnchorQuaternion);
  return {
    position: {
      x: handPanelAnchorPosition.x,
      y: handPanelAnchorPosition.y,
      z: handPanelAnchorPosition.z,
    },
    orientation: {
      x: handPanelAnchorQuaternion.x,
      y: handPanelAnchorQuaternion.y,
      z: handPanelAnchorQuaternion.z,
      w: handPanelAnchorQuaternion.w,
    },
  };
}

function updateHandPanel(nowMs: number): void {
  if (!renderer.xr.isPresenting || !handPanelVisible) {
    if (handPanel.enabled) handPanel.enabled = false;
    return;
  }
  const anchorPose = resolveHandPanelAnchorPose();
  if (!anchorPose) {
    if (handPanel.enabled) handPanel.enabled = false;
    return;
  }
  handPanel.enabled = true;
  handPanel.update({
    timestamp: nowMs,
    camera: renderer.xr.getCamera(),
    anchorPose,
  });
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
  state.displayRadiusM = applyLogarithmicScale(
    state.displayRadiusM,
    intent.scaleAxis,
    deltaSeconds,
  );
  state.radialMultiplier = applyRadialMultiplierRate(
    state.radialMultiplier,
    intent.radialAxis,
    deltaSeconds,
  );
  if (intent.toggleOcean) toggleOcean();
  if (intent.reset) resetPlanet();
  if (intent.togglePanel) {
    handPanelVisible = !handPanelVisible;
  }
}

function updateDesktopControls(deltaSeconds: number): void {
  const sideways =
    Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
  const forward =
    Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
  desktopTravel.set(sideways, -forward);
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
  state.displayRadiusM = applyLogarithmicScale(
    state.displayRadiusM,
    scaleAxis,
    deltaSeconds,
  );
  state.radialMultiplier = applyRadialMultiplierRate(
    state.radialMultiplier,
    radialAxis,
    deltaSeconds,
  );
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
  if (event.code === "KeyO") toggleOcean();
  if (event.code === "Backspace") resetPlanet();
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
window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});
window.addEventListener("blur", () => keys.clear());

oceanButton.addEventListener("click", toggleOcean);
resetButton.addEventListener("click", resetPlanet);

function stopAircraftPolling(): void {
  if (aircraftPollTimer !== undefined) {
    window.clearTimeout(aircraftPollTimer);
    aircraftPollTimer = undefined;
  }
  aircraftRequest?.abort();
}

function scheduleAircraftPoll(delayMs: number): void {
  if (
    !shouldPollAircraft({
      enabled: aircraftEnabled,
      vrSessionActive,
      documentVisible: !document.hidden,
      requestActive: false,
    })
  ) {
    return;
  }
  if (aircraftPollTimer !== undefined) window.clearTimeout(aircraftPollTimer);
  aircraftPollTimer = window.setTimeout(() => {
    aircraftPollTimer = undefined;
    void pollAircraft();
  }, delayMs);
}

async function pollAircraft(): Promise<void> {
  if (!shouldPollAircraft({
    enabled: aircraftEnabled,
    vrSessionActive,
    documentVisible: !document.hidden,
    requestActive: aircraftRequest !== undefined,
  })) {
    return;
  }
  const coordinates = coordinatesForFrame(state.contact);
  const request = new AbortController();
  aircraftRequest = request;
  try {
    const aircraft = await fetchAirplanesLive(
      coordinates.latitudeDegrees,
      coordinates.longitudeDegrees,
      request.signal,
    );
    aircraftLayer.setAircraft(aircraft);
    aircraftCount = aircraft.length;
    aircraftReadout.textContent = `${aircraftCount} nearby · 30 s`;
    document.body.dataset.aircraftCount = String(aircraftCount);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      console.warn("Live aircraft update failed:", error);
      aircraftReadout.textContent =
        aircraftCount > 0 ? `${aircraftCount} nearby · stale` : "Unavailable";
    }
  } finally {
    if (aircraftRequest === request) aircraftRequest = undefined;
    scheduleAircraftPoll(AIRCRAFT_POLL_INTERVAL_MS);
  }
}

function setAircraftEnabled(enabled: boolean): void {
  aircraftEnabled = enabled;
  aircraftToggle.checked = enabled;
  aircraftLayer.visible = enabled && vrSessionActive;
  if (enabled && vrSessionActive) {
    aircraftReadout.textContent =
      aircraftCount > 0 ? `${aircraftCount} nearby · cached` : "Connecting…";
    scheduleAircraftPoll(0);
  } else if (enabled) {
    stopAircraftPolling();
    aircraftReadout.textContent = "Ready for VR";
  } else {
    stopAircraftPolling();
    aircraftReadout.textContent = "Off · optional";
  }
}

aircraftToggle.addEventListener("change", () => {
  setAircraftEnabled(aircraftToggle.checked);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAircraftPolling();
  } else {
    scheduleAircraftPoll(0);
  }
});

const vrButton = VRButton.createButton(renderer);
vrSlot.append(vrButton);
renderer.xr.addEventListener("sessionstart", () => {
  vrSessionActive = true;
  aircraftLayer.visible = aircraftEnabled;
  if (aircraftEnabled) {
    aircraftReadout.textContent = "Connecting…";
    scheduleAircraftPoll(0);
  }
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  previousXrHead = null;
  renderer.xr.setFoveation(1);
});
renderer.xr.addEventListener("sessionend", () => {
  vrSessionActive = false;
  handPanel.enabled = false;
  stopAircraftPolling();
  aircraftLayer.visible = false;
  aircraftReadout.textContent = aircraftEnabled
    ? "Ready for VR"
    : "Off · optional";
  camera.position.set(0, 1.65, 0);
  camera.rotation.set(pitch, yaw, 0);
  headsetFloorPosition.set(0, 0);
  previousXrHead = null;
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
});

const cameraWorldPosition = new THREE.Vector3();
function render(nowMs: number): void {
  const utcMilliseconds = Date.now();
  const deltaSeconds = Math.min(0.05, (nowMs - previousFrameMs) / 1000);
  previousFrameMs = nowMs;
  if (renderer.xr.isPresenting) {
    updatePhysicalWalking();
    updateXrControls(deltaSeconds, nowMs);
  } else {
    updateDesktopControls(deltaSeconds);
  }
  updatePresentation();
  aircraftLayer.update(
    utcMilliseconds,
    state.displayRadiusM,
    state.radialMultiplier,
  );
  const viewCamera = renderer.xr.isPresenting
    ? renderer.xr.getCamera()
    : camera;
  viewCamera.getWorldPosition(cameraWorldPosition);
  celestialSphere.update(
    planetRoot.quaternion,
    cameraWorldPosition,
    utcMilliseconds,
  );
  updateHandPanel(nowMs);
  renderer.render(scene, camera);
}

window.addEventListener("beforeunload", () => {
  handPanel.dispose();
  handPanelRuntime.dispose();
});

updatePresentation();
loadingState.hidden = true;
errorState.hidden = true;
aircraftLayer.visible = false;
setAircraftEnabled(false);
renderer.setAnimationLoop(render);
