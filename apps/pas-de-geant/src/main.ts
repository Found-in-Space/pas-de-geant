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
  type HandPanelDirection,
  type HandPanelStatus,
} from "./hand-panel.js";
import { directionOnHandPanel } from "./hand-panel-orientation.js";
import {
  ImageryVirtualTexture,
  configuredXyzImageryProvider,
} from "./imagery.js";
import { imageryConfiguration } from "./imagery-configuration.js";
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
import { resolveInitialLocation } from "./initial-location.js";
import {
  fetchNamedLocationContext,
  locationDetailForDisplayRadius,
} from "./location-context.js";
import { loadReliefDataset } from "./relief.js";
import {
  parseLocationToolArguments,
  RealtimeVoiceAgent,
  type RealtimeAgentStatus,
} from "./realtime-agent.js";
import { TerrainTileRenderer } from "./terrain-tiles.js";

declare global {
  interface Window {
    __PAS_DE_GEANT_ENABLE_TEST_HOOKS__?: boolean;
    __PAS_DE_GEANT_TEST_SET_SCALE__?: (displayRadiusM: number) => void;
    __PAS_DE_GEANT_TEST_SET_TILE_OVERLAY__?: (visible: boolean) => void;
    __PAS_DE_GEANT_TEST_SET_TEXTURE_TILE_OVERLAY__?: (
      visible: boolean,
    ) => void;
    __PAS_DE_GEANT_TEST_SET_LOCATION__?: (
      latitudeDegrees: number,
      longitudeDegrees: number,
    ) => void;
  }
}

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
const aircraftReadout = element<HTMLElement>("aircraft-readout");
const resetButton = element<HTMLButtonElement>("reset-button");
const aircraftToggle = element<HTMLInputElement>("aircraft-toggle");
const imageryAttribution = element<HTMLElement>("imagery-attribution");
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
renderer.toneMappingExposure = 1.35;
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
const realtimeAudioElement = document.createElement("audio");
realtimeAudioElement.autoplay = true;
realtimeAudioElement.setAttribute("playsinline", "");
realtimeAudioElement.hidden = true;
document.body.append(realtimeAudioElement);

function setRealtimeAudioStream(stream: MediaStream | null): void {
  realtimeAudioElement.srcObject = stream;
  if (!stream) {
    realtimeAudioElement.pause();
    document.body.dataset.agentAudio = "off";
    return;
  }
  document.body.dataset.agentAudio = "starting";
  void realtimeAudioElement.play().then(
    () => {
      document.body.dataset.agentAudio = "playing";
    },
    (error: unknown) => {
      document.body.dataset.agentAudio = "blocked";
      console.warn("Realtime audio playback was blocked:", error);
    },
  );
}

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

const blueMarbleTexture = await new THREE.TextureLoader().loadAsync(
  `${import.meta.env.BASE_URL}bluemarble-2048.png`,
);
blueMarbleTexture.colorSpace = THREE.SRGBColorSpace;
blueMarbleTexture.flipY = false;
blueMarbleTexture.needsUpdate = true;
blueMarbleTexture.anisotropy = Math.min(
  4,
  renderer.capabilities.getMaxAnisotropy(),
);

const relief = await loadReliefDataset();
document.body.dataset.reliefFallback = String(relief.fallback);
const photographicImageryProvider =
  window.__PAS_DE_GEANT_IMAGERY_PROVIDER__ ??
  configuredXyzImageryProvider(imageryConfiguration());
imageryAttribution.textContent = photographicImageryProvider
  ? ` + ${photographicImageryProvider.attribution}`
  : "";
const imagery = new ImageryVirtualTexture(
  renderer,
  blueMarbleTexture,
  photographicImageryProvider,
);
const renderingContext = renderer.getContext();
const detailStencilAvailable =
  renderingContext.getParameter(renderingContext.STENCIL_BITS) > 0;
const terrain = new TerrainTileRenderer(
  relief,
  imagery,
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
let groundLevelElevationM = 0;
let tileOverlayVisible = false;
let textureTileOverlayVisible = false;
let realtimeAgentStatus: RealtimeAgentStatus = {
  state: "off",
  detail: "Press A to wake",
};
document.body.dataset.agentStatus = realtimeAgentStatus.state;
if (window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__) {
  window.__PAS_DE_GEANT_TEST_SET_SCALE__ = (displayRadiusM): void => {
    state.displayRadiusM = Math.max(1, displayRadiusM);
    updatePresentation();
  };
  window.__PAS_DE_GEANT_TEST_SET_LOCATION__ = (
    latitudeDegrees,
    longitudeDegrees,
  ): void => {
    setUserLocation(latitudeDegrees, longitudeDegrees);
  };
  window.__PAS_DE_GEANT_TEST_SET_TILE_OVERLAY__ = setTileOverlayVisible;
  window.__PAS_DE_GEANT_TEST_SET_TEXTURE_TILE_OVERLAY__ =
    setTextureTileOverlayVisible;
}
const initialCoordinates = coordinatesForFrame(state.contact);
const initialHandPanelStatus = handPanelStatus(
  initialCoordinates.latitudeDegrees,
  initialCoordinates.longitudeDegrees,
);
const earthMapBitmap: BitmapHandle = {
  kind: "bitmap",
  image: blueMarbleTexture.image,
  width: 2_048,
  height: 1_024,
  revision: 1,
};
const handPanelRuntime = createRuntime({
  root: createHandPanelRoot(
    initialCoordinates,
    earthMapBitmap,
    { x: 0, y: -1 },
    initialHandPanelStatus,
  ),
  surface: HAND_PANEL_SURFACE,
  theme: HAND_PANEL_THEME,
});
const handPanelHostRoot = new THREE.Group();
handPanelHostRoot.name = "hand-panel-host";
scene.add(handPanelHostRoot);
const HAND_PANEL_TILT_RADIANS = -Math.PI * 0.24;
const handPanelDriver = createPoseAnchoredPanelDriver({
  runtime: handPanelRuntime,
  parent: handPanelHostRoot,
  surface: HAND_PANEL_SURFACE,
  panelWidth: 0.32,
  panelHeight: 0.18,
  tiltRadians: HAND_PANEL_TILT_RADIANS,
  offset: { x: 0.04, y: 0.05, z: -0.03 },
  depthTest: false,
  depthWrite: false,
  renderOrder: 100,
  textureQuality: {
    anisotropy: Math.min(4, renderer.capabilities.getMaxAnisotropy()),
  },
});
const handPanel = createThreePanelSession({
  key: "pas-de-geant-earth-map",
  runtime: handPanelRuntime,
  driver: handPanelDriver,
  enabled: false,
});
handPanel.attach();
let handPanelLocationSignature =
  handPanelStateSignature(
    initialCoordinates.latitudeDegrees,
    initialCoordinates.longitudeDegrees,
    { x: 0, y: -1 },
    initialHandPanelStatus,
  );
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
const handPanelVisible = true;
let handPanelNorthDirection: HandPanelDirection = { x: 0, y: -1 };
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
  groundLevelElevationM = 0;
  previousXrHead = null;
  updatePresentation();
}

function resetGroundLevel(): void {
  const coordinates = coordinatesForFrame(state.contact);
  groundLevelElevationM = terrain.sampleSurfaceHeight(
    coordinates.latitudeDegrees,
    coordinates.longitudeDegrees,
  );
}

function setUserLocation(
  latitudeDegrees: number,
  longitudeDegrees: number,
): { latitudeDegrees: number; longitudeDegrees: number } {
  state.contact = initialPlanetState(
    latitudeDegrees,
    longitudeDegrees,
  ).contact;
  groundLevelElevationM = 0;
  previousXrHead = null;
  updatePresentation();
  return coordinatesForFrame(state.contact);
}

function setTileOverlayVisible(visible: boolean): void {
  tileOverlayVisible = visible;
  terrain.setTileOverlayVisible(visible);
}

function setTextureTileOverlayVisible(visible: boolean): void {
  textureTileOverlayVisible = visible;
  terrain.setTextureTileOverlayVisible(visible);
}

const terrainEyeWorldPosition = new THREE.Vector3();
const terrainDrawingBufferSize = new THREE.Vector2();

function terrainViewMetrics(): {
  eyeHeightWorldM: number;
  focalLengthPixels: number;
} {
  const viewCamera = renderer.xr.isPresenting
    ? renderer.xr.getCamera()
    : camera;
  viewCamera.updateWorldMatrix(true, false);
  viewCamera.getWorldPosition(terrainEyeWorldPosition);
  // The local-floor reference space keeps the physical floor at world y=0,
  // independently of the calibrated planet-root elevation.
  const eyeHeightWorldM = Math.max(0.001, terrainEyeWorldPosition.y);
  let focalLengthPixels = 1;
  if (renderer.xr.isPresenting && viewCamera instanceof THREE.ArrayCamera) {
    for (const eyeCamera of viewCamera.cameras) {
      const viewport = (
        eyeCamera as THREE.PerspectiveCamera & { viewport?: THREE.Vector4 }
      ).viewport;
      if (!viewport) continue;
      focalLengthPixels = Math.max(
        focalLengthPixels,
        viewport.w * eyeCamera.projectionMatrix.elements[5]! * 0.5,
      );
    }
  } else {
    renderer.getDrawingBufferSize(terrainDrawingBufferSize);
    focalLengthPixels =
      terrainDrawingBufferSize.y *
      viewCamera.projectionMatrix.elements[5]! *
      0.5;
  }
  return {
    eyeHeightWorldM,
    focalLengthPixels: Math.max(1, focalLengthPixels),
  };
}

function updatePresentation(): void {
  const coordinates = coordinatesForFrame(state.contact);
  const pose = solvePlanetPose(state, headsetFloorPosition);
  planetRoot.quaternion.copy(pose.earthToWorld);
  planetRoot.position.copy(pose.centre);
  planetRoot.scale.setScalar(state.displayRadiusM);
  planetRoot.position.y -= radialWorldMetresForKilometres(
    groundLevelElevationM / 1_000,
    state.displayRadiusM,
    state.radialMultiplier,
  );
  const view = terrainViewMetrics();
  document.body.dataset.displayScale = state.displayRadiusM.toFixed(2);
  document.body.dataset.groundLevelElevation =
    groundLevelElevationM.toFixed(1);
  terrain.update(
    coordinates.latitudeDegrees,
    coordinates.longitudeDegrees,
    state.displayRadiusM,
    state.radialMultiplier,
    view.eyeHeightWorldM,
    view.focalLengthPixels,
  );
  atmosphere.update(state.radialMultiplier);
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
}

function formatRoomDistance(metres: number): string {
  if (metres === 0) return "0";
  if (metres < 0.0095) return `${(metres * 1_000).toFixed(1)} mm`;
  if (metres < 1) return `${(metres * 100).toFixed(1)} cm`;
  return `${metres.toFixed(2)} m`;
}

function handPanelStatus(
  _latitudeDegrees: number,
  _longitudeDegrees: number,
): HandPanelStatus {
  const lod = terrain.getLodStatus();
  return {
    globalScaleFactor: state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    minimumTerrainZoom: lod.minZoom,
    maximumTerrainZoom: lod.maxZoom,
    terrainBudgetLimited: lod.budgetLimited,
    agentState: realtimeAgentStatus.state,
  };
}

function handPanelStateSignature(
  latitudeDegrees: number,
  longitudeDegrees: number,
  northDirection: HandPanelDirection,
  status: HandPanelStatus,
): string {
  const northAngle = Math.atan2(northDirection.y, northDirection.x);
  return [
    latitudeDegrees.toFixed(2),
    longitudeDegrees.toFixed(2),
    northAngle.toFixed(2),
    status.globalScaleFactor.toFixed(2),
    status.radialMultiplier.toFixed(1),
    status.minimumTerrainZoom,
    status.maximumTerrainZoom,
    status.terrainBudgetLimited ? "capped" : "screen",
    status.agentState,
  ].join(":");
}

function syncHandPanelState(
  latitudeDegrees: number,
  longitudeDegrees: number,
  northDirection: HandPanelDirection,
  nowMs: number,
): void {
  if (!renderer.xr.isPresenting || !handPanelVisible) return;
  const status = handPanelStatus(latitudeDegrees, longitudeDegrees);
  const signature = handPanelStateSignature(
    latitudeDegrees,
    longitudeDegrees,
    northDirection,
    status,
  );
  if (signature === handPanelLocationSignature) return;
  if (nowMs - handPanelLastRedrawMs < 50) return;
  handPanelLocationSignature = signature;
  handPanelLastRedrawMs = nowMs;
  handPanelRuntime.setRoot(
    createHandPanelRoot(
      { latitudeDegrees, longitudeDegrees },
      earthMapBitmap,
      northDirection,
      status,
    ),
  );
  handPanelRedrawCount += 1;
  document.body.dataset.handPanelRedrawCount =
    String(handPanelRedrawCount);
}

const voiceAgent = new RealtimeVoiceAgent({
  onStatus(status) {
    realtimeAgentStatus = status;
    document.body.dataset.agentStatus = status.state;
    document.body.dataset.agentDetail = status.detail;
    handPanelLocationSignature = "";
  },
  onRemoteStream: setRealtimeAudioStream,
  tools: {
    async get_user_location() {
      const coordinates = coordinatesForFrame(state.contact);
      const detail = locationDetailForDisplayRadius(state.displayRadiusM);
      const namedLocation = await fetchNamedLocationContext(
        coordinates.latitudeDegrees,
        coordinates.longitudeDegrees,
        detail,
      );
      return {
        latitude_degrees: coordinates.latitudeDegrees,
        longitude_degrees: coordinates.longitudeDegrees,
        display_scale_factor: state.displayRadiusM,
        location_detail: detail,
        named_location: namedLocation ?? null,
      };
    },
    set_user_location(argumentsValue) {
      const location = parseLocationToolArguments(argumentsValue);
      const coordinates = setUserLocation(
        location.latitudeDegrees,
        location.longitudeDegrees,
      );
      return {
        ok: true,
        latitude_degrees: coordinates.latitudeDegrees,
        longitude_degrees: coordinates.longitudeDegrees,
      };
    },
  },
});

const handPanelAnchorPosition = new THREE.Vector3();
const handPanelAnchorQuaternion = new THREE.Quaternion();
const handPanelWorldQuaternion = new THREE.Quaternion();
const handPanelTiltQuaternion = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  HAND_PANEL_TILT_RADIANS,
);
const geographicNorthWorld = new THREE.Vector3();
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
  handPanelWorldQuaternion
    .set(
      anchorPose.orientation.x,
      anchorPose.orientation.y,
      anchorPose.orientation.z,
      anchorPose.orientation.w,
    )
    .multiply(handPanelTiltQuaternion);
  // Project the Earth pole onto the local tangent plane. This is the
  // geographic-north direction at the point currently underfoot.
  geographicNorthWorld
    .set(0, 1, 0)
    .addScaledVector(state.contact.upEcef, -state.contact.upEcef.y);
  if (geographicNorthWorld.lengthSq() < 1e-8) {
    geographicNorthWorld.copy(state.contact.northEcef);
  }
  geographicNorthWorld
    .normalize()
    .applyQuaternion(planetRoot.quaternion);
  handPanelNorthDirection =
    directionOnHandPanel(
      geographicNorthWorld,
      handPanelWorldQuaternion,
    ) ?? handPanelNorthDirection;
  const coordinates = coordinatesForFrame(state.contact);
  syncHandPanelState(
    coordinates.latitudeDegrees,
    coordinates.longitudeDegrees,
    handPanelNorthDirection,
    nowMs,
  );
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
  if (intent.toggleTileOverlay) {
    setTileOverlayVisible(!tileOverlayVisible);
  }
  if (intent.toggleTextureTileOverlay) {
    setTextureTileOverlayVisible(!textureTileOverlayVisible);
  }
  if (intent.toggleAgent) {
    void voiceAgent.toggle();
  }
  if (intent.reset) resetPlanet();
  if (intent.resetGroundLevel) resetGroundLevel();
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
  if (event.repeat && event.code === "Backspace") return;
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
  voiceAgent.disable();
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
