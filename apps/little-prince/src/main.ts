import "./style.css";

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
import {
  applyLogarithmicScale,
  applyRadialMultiplierRate,
  coordinatesForFrame,
  horizontalWorldMetresForKilometres,
  iberiaWidthForDisplayRadius,
  initialPlanetState,
  radialWorldMetresForKilometres,
  rollContactFrame,
  solvePlanetPose,
  type PlanetState,
} from "./planet-state.js";
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

let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
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

function starField(): THREE.Points {
  let seed = 2847193;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const positions: number[] = [];
  const colours: number[] = [];
  const colour = new THREE.Color();
  for (let index = 0; index < 850; index += 1) {
    const y = random() * 2 - 1;
    const radial = Math.sqrt(1 - y * y);
    const angle = random() * Math.PI * 2;
    positions.push(
      radial * Math.cos(angle) * 520,
      y * 520,
      radial * Math.sin(angle) * 520,
    );
    colour.setHSL(0.55 + random() * 0.08, 0.18, 0.5 + random() * 0.4);
    colours.push(colour.r, colour.g, colour.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(colours, 3),
  );
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.72,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
    }),
  );
}

const stars = starField();
scene.add(stars);

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
const terrain = new TerrainTileRenderer(relief, fallbackTexture);
planetRoot.add(terrain.group);
const aircraftLayer = new AircraftLayer();
planetRoot.add(aircraftLayer.group);

const atmosphere = new AtmosphereLayer();
planetRoot.add(atmosphere.mesh);

let state = initialPlanetState();
let previousFrameMs = performance.now();
let previousXrHead: THREE.Vector2 | null = null;
const headsetFloorPosition = new THREE.Vector2();
const xrHeadPosition = new THREE.Vector3();
const xrViewQuaternion = new THREE.Quaternion();
const desktopTravel = new THREE.Vector2();
const keys = new Set<string>();
const buttonLatch = freshButtonLatch();
let hudVisible = true;
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
  state = initialPlanetState();
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
  const iberiaWidth = iberiaWidthForDisplayRadius(state.displayRadiusM);
  const horizontalMetresPerKilometre =
    horizontalWorldMetresForKilometres(1, state.displayRadiusM);
  const radialMetresPerKilometre =
    radialWorldMetresForKilometres(
      1,
      state.displayRadiusM,
      state.radialMultiplier,
    );
  scaleReadout.textContent =
    `${iberiaWidth < 1
      ? `Iberia ≈ ${Math.round(iberiaWidth * 100)} cm`
      : `Iberia ≈ ${iberiaWidth.toFixed(1)} m`} · ` +
    `1 km = ${formatRoomDistance(horizontalMetresPerKilometre)}`;
  radialReadout.textContent =
    `${state.radialMultiplier.toFixed(1)}× · ` +
    `1 km = ${formatRoomDistance(radialMetresPerKilometre)}`;
  drawWristHud();
}

function formatRoomDistance(metres: number): string {
  if (metres === 0) return "0";
  if (metres < 0.0095) return `${(metres * 1_000).toFixed(1)} mm`;
  if (metres < 1) return `${(metres * 100).toFixed(1)} cm`;
  return `${metres.toFixed(2)} m`;
}

function formatCoordinates(latitude: number, longitude: number): string {
  return (
    `${Math.abs(latitude).toFixed(2)}° ${latitude >= 0 ? "N" : "S"} · ` +
    `${Math.abs(longitude).toFixed(2)}° ${longitude >= 0 ? "E" : "W"}`
  );
}

const wristCanvas = document.createElement("canvas");
wristCanvas.width = 640;
wristCanvas.height = 320;
const wristContextValue = wristCanvas.getContext("2d");
if (!wristContextValue) throw new Error("Canvas rendering is unavailable.");
const wristContext: CanvasRenderingContext2D = wristContextValue;
const wristTexture = new THREE.CanvasTexture(wristCanvas);
wristTexture.colorSpace = THREE.SRGBColorSpace;
const wristPanel = new THREE.Mesh(
  new THREE.PlaneGeometry(0.24, 0.12),
  new THREE.MeshBasicMaterial({
    map: wristTexture,
    transparent: true,
    depthTest: false,
  }),
);
wristPanel.position.set(0, 0.085, -0.11);
wristPanel.rotation.x = -0.72;
wristPanel.renderOrder = 100;

function drawWristHud(): void {
  wristPanel.visible = hudVisible;
  wristContext.clearRect(0, 0, wristCanvas.width, wristCanvas.height);
  wristContext.fillStyle = "rgba(3, 12, 20, 0.88)";
  wristContext.fillRect(0, 0, wristCanvas.width, wristCanvas.height);
  wristContext.strokeStyle = "rgba(121, 215, 239, 0.75)";
  wristContext.lineWidth = 5;
  wristContext.strokeRect(7, 7, wristCanvas.width - 14, wristCanvas.height - 14);
  wristContext.fillStyle = "#76ddf1";
  wristContext.font = "700 34px system-ui";
  wristContext.fillText("LITTLE PLANET", 34, 58);
  wristContext.fillStyle = "#f1f8fb";
  wristContext.font = "600 30px system-ui";
  wristContext.fillText(coordinatesReadout.textContent ?? "", 34, 112);
  const horizontalScale = horizontalWorldMetresForKilometres(
    1,
    state.displayRadiusM,
  );
  const radialScale = radialWorldMetresForKilometres(
    1,
    state.displayRadiusM,
    state.radialMultiplier,
  );
  wristContext.fillText(
    `Planet 1 km = ${formatRoomDistance(horizontalScale)}`,
    34,
    162,
  );
  wristContext.fillText(
    `Radial ${state.radialMultiplier.toFixed(1)}× · ` +
      `1 km = ${formatRoomDistance(radialScale)}`,
    34,
    212,
  );
  wristContext.fillStyle = "#76ddf1";
  wristContext.font = "600 24px system-ui";
  wristContext.fillText(
    `${state.oceanMode === "surface" ? "Ocean" : "Seabed"} · ${
      aircraftEnabled
        ? aircraftReadout.textContent ?? `${aircraftCount} live aircraft`
        : "Aircraft off"
    }`,
    34,
    252,
  );
  wristContext.fillStyle = "#9babb5";
  wristContext.font = "500 19px system-ui";
  wristContext.fillText("A ocean · hold B reset · stick press HUD", 34, 294);
  wristTexture.needsUpdate = true;
}

for (let index = 0; index < 2; index += 1) {
  const controller = renderer.xr.getController(index);
  controller.addEventListener("connected", (event) => {
    const source = (event as THREE.Event & { data?: XRInputSource }).data;
    if (source?.handedness === "right" || index === 1) {
      controller.add(wristPanel);
    }
  });
  scene.add(controller);
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
  if (intent.toggleHud) {
    hudVisible = !hudVisible;
    drawWristHud();
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
    drawWristHud();
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
  drawWristHud();
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
    Date.now(),
    state.displayRadiusM,
    state.radialMultiplier,
  );
  const viewCamera = renderer.xr.isPresenting
    ? renderer.xr.getCamera()
    : camera;
  viewCamera.getWorldPosition(cameraWorldPosition);
  stars.position.copy(cameraWorldPosition);
  renderer.render(scene, camera);
}

updatePresentation();
loadingState.hidden = true;
errorState.hidden = true;
aircraftLayer.visible = false;
setAircraftEnabled(false);
renderer.setAnimationLoop(render);
