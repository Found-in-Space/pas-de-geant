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
import {
  parseAircraftDisplayArguments,
  shouldPollAircraft,
} from "./aircraft-lifecycle.js";
import { AtmosphereLayer } from "./atmosphere.js";
import {
  controllerIntent,
  freshButtonLatch,
  headRelativeTravel,
} from "./controller-input.js";
import { CelestialSphere } from "./celestial-sphere.js";
import {
  parseCelestialVisibilityArguments,
} from "./celestial-visibility.js";
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
  parseKnowledgeSearchArguments,
  searchWeb,
  searchWikipedia,
  type KnowledgeSource,
} from "./external-knowledge.js";
import {
  configuredXyzImageryProvider,
} from "./imagery-provider.js";
import {
  imageryConfiguration,
} from "./imagery-configuration.js";
import {
  MAPTILER_IMAGERY_VARIANT_PARAMETER,
  selectImageryVariant,
} from "./imagery-variants.js";
import {
  applyLogarithmicScale,
  applyRadialMultiplierRate,
  coordinatesForFrame,
  EARTH_MEAN_RADIUS_KM,
  geodeticSurfaceEcefKm,
  horizontalWorldMetresForKilometres,
  initialPlanetState,
  INITIAL_DISPLAY_RADIUS_M,
  radialWorldMetresForKilometres,
  referenceDistanceForDisplayRadius,
  rollContactFrame,
  solvePlanetPose,
  type PlanetState,
  WGS84_A_KM,
  WGS84_B_KM,
} from "./planet-state.js";
import { resolveInitialLocation } from "./initial-location.js";
import {
  AGENT_LOCATION_DETAIL,
  fetchNamedLocationContext,
} from "./location-context.js";
import {
  parseLocationToolArguments,
  RealtimeVoiceAgent,
  type RealtimeAgentStatus,
} from "./realtime-agent.js";
import { TerrainSurface } from "./terrain-surface.js";
import {
  parseTileDeltaZoomCapArguments,
  parseTileMaxZoomArguments,
  parseTilePixelRatioArguments,
  parseTileRecalculationArguments,
  parseTileViewDistanceArguments,
  parseTileViewOverheadArguments,
  type TileDebugControlsReadback,
  type TileDebugTarget,
} from "./tile-debug-controls.js";
import {
  FrameTelemetry,
  summarizeResourceTimings,
} from "./runtime-debug.js";
import {
  fetchSatelliteGroup,
  SATELLITE_REFRESH_INTERVAL_MS,
} from "./satellite-feed.js";
import {
  parseSatelliteVisibilityArguments,
  SATELLITE_GROUPS,
  type SatelliteGroupId,
} from "./satellite-groups.js";
import { SatelliteLayer } from "./satellite-layer.js";
import {
  intersectEllipsoidRay,
  type GeographicPoint,
} from "./view-residency.js";
import {
  geographicTravelFromWorld,
  geographicViewHeadingDegrees,
  normalizeHeadingDegrees,
  parseViewDirectionToolArguments,
  viewHeadingDegreesFromQuaternion,
  worldRotationForViewDirection,
} from "./view-direction.js";

interface PasDeGeantDebugApi {
  help(): Record<string, string>;
  snapshot(): Record<string, unknown>;
  mark(name?: string): Record<string, unknown>;
  marks(): Record<string, Record<string, unknown>>;
  clearMetrics(): void;
  beginBenchmark(options?: {
    latitudeDegrees?: number;
    longitudeDegrees?: number;
    displayRadiusM?: number;
    radialMultiplier?: number;
  }): Record<string, unknown>;
  endBenchmark(): Record<string, unknown>;
  reset(): Record<string, unknown>;
  setLocation(latitudeDegrees: number, longitudeDegrees: number): unknown;
  setScale(displayRadiusM: number): Record<string, unknown>;
  setRadialMultiplier(multiplier: number): Record<string, unknown>;
  setView(view: {
    pitchRadians?: number;
    yawRadians?: number;
  }): Record<string, unknown>;
  setTilePixelRatio(target: TileDebugTarget, ratio: number): unknown;
  setMaxZ(target: TileDebugTarget, zoom: number | null): unknown;
  setDeltaZ(target: TileDebugTarget, zoom: number | null): unknown;
  setViewDistance(target: TileDebugTarget, enabled: boolean): unknown;
  setViewOverhead(percent: number): unknown;
  setTileRecalculation(target: TileDebugTarget, enabled: boolean): unknown;
  setOverlays(options: { terrain?: boolean; textures?: boolean }): unknown;
  setRendering(enabled: boolean): Record<string, unknown>;
  setInputEnabled(enabled: boolean): Record<string, unknown>;
  setFoveation(value: number): Record<string, unknown>;
  setFramebufferScale(value: number): Record<string, unknown>;
  setDesktopPixelRatio(value: number): Record<string, unknown>;
  setLayerVisibility(
    layer: "terrain" | "atmosphere" | "stars" | "aircraft" | "hand-panel",
    visible: boolean,
  ): Record<string, unknown>;
}

declare global {
  interface Window {
    pasDeGeantDebug?: PasDeGeantDebugApi;
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
    __PAS_DE_GEANT_TEST_SET_VIEW_PITCH__?: (pitchRadians: number) => void;
    __PAS_DE_GEANT_TEST_GET_TERRAIN_METRICS__?: () => ReturnType<
      TerrainSurface["getMetrics"]
    >;
  }
}

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}.`);
  return value as T;
};

const sceneRoot = element<HTMLDivElement>("scene-root");
const benchmarkParameters = new URLSearchParams(window.location.search);
const vrSlot = element<HTMLDivElement>("vr-slot");
const loadingState = element<HTMLDivElement>("loading-state");
const errorState = element<HTMLDivElement>("error-state");
const errorMessage = element<HTMLParagraphElement>("error-message");
const coordinatesReadout = element<HTMLElement>("coordinates");
const scaleReadout = element<HTMLElement>("scale-readout");
const radialReadout = element<HTMLElement>("radial-readout");
const aircraftReadout = element<HTMLElement>("aircraft-readout");
const satelliteReadout = element<HTMLElement>("satellite-readout");
const resetButton = element<HTMLButtonElement>("reset-button");
const aircraftToggle = element<HTMLInputElement>("aircraft-toggle");
const aircraftLabelsToggle = element<HTMLInputElement>(
  "aircraft-labels-toggle",
);
const satelliteToggles: Record<SatelliteGroupId, HTMLInputElement> = {
  visual: element<HTMLInputElement>("satellite-visual-toggle"),
  stations: element<HTMLInputElement>("satellite-stations-toggle"),
  "science-education": element<HTMLInputElement>(
    "satellite-science-education-toggle",
  ),
};
const imageryAttribution = element<HTMLElement>("imagery-attribution");
const researchRegion = element<HTMLElement>("research-region");
const researchAnswer = element<HTMLParagraphElement>("research-answer");
const researchSources = element<HTMLUListElement>("research-sources");
const initialLocationPromise = resolveInitialLocation();

function clearResearch(): void {
  researchAnswer.textContent = "";
  researchSources.replaceChildren();
  researchRegion.hidden = true;
}

function showResearch(answer: string, sources: readonly KnowledgeSource[]): void {
  researchAnswer.textContent = answer;
  const links = sources.flatMap((source) => {
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:") return [];
      const anchor = document.createElement("a");
      anchor.href = url.href;
      anchor.textContent = source.title;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      const item = document.createElement("li");
      item.append(anchor);
      return [item];
    } catch {
      return [];
    }
  });
  researchSources.replaceChildren(...links);
  researchRegion.hidden = false;
}

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
renderer.toneMappingExposure = 1.35;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
let xrFramebufferScaleFactor = 1;
renderer.xr.setFramebufferScaleFactor(xrFramebufferScaleFactor);
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
const textureLoader = new THREE.TextureLoader();
textureLoader.load(
  `${import.meta.env.BASE_URL}lroc-color-2k.jpg`,
  (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = Math.min(
      4,
      renderer.capabilities.getMaxAnisotropy(),
    );
    celestialSphere.setMoonTexture(texture);
  },
  undefined,
  (error) => {
    console.warn("LRO Moon texture is unavailable:", error);
  },
);
document.body.dataset.starStatus = "loading";
document.body.dataset.starCount = "0";
void celestialSphere.load().then((result) => {
  document.body.dataset.starStatus = result.status;
  document.body.dataset.starCount = String(result.count);
  if (result.status === "unavailable") {
    console.warn("SkyKit star catalog is unavailable:", result.error);
  }
});

const blueMarbleTexture = await textureLoader.loadAsync(
  `${import.meta.env.BASE_URL}bluemarble-2048.png`,
);
blueMarbleTexture.colorSpace = THREE.SRGBColorSpace;
blueMarbleTexture.flipY = false;
blueMarbleTexture.wrapS = THREE.RepeatWrapping;
blueMarbleTexture.wrapT = THREE.ClampToEdgeWrapping;
blueMarbleTexture.needsUpdate = true;
blueMarbleTexture.anisotropy = Math.min(
  4,
  renderer.capabilities.getMaxAnisotropy(),
);

const baseImageryConfiguration = imageryConfiguration();
const selectedImageryConfiguration = baseImageryConfiguration
  ? selectImageryVariant(
      baseImageryConfiguration,
      benchmarkParameters.get(MAPTILER_IMAGERY_VARIANT_PARAMETER),
    )
  : undefined;
const photographicImageryProvider =
  window.__PAS_DE_GEANT_IMAGERY_PROVIDER__ ??
  configuredXyzImageryProvider(selectedImageryConfiguration);
document.body.dataset.imageryProvider =
  photographicImageryProvider?.id ?? "blue-marble";
document.body.dataset.imageryTileSize = String(
  photographicImageryProvider?.tileSize ?? 0,
);
imageryAttribution.textContent = photographicImageryProvider
  ? ` + ${photographicImageryProvider.attribution}`
  : "";
const initialLocation = await initialLocationPromise;
document.body.dataset.locationSource = initialLocation.source;
let state = initialPlanetState(
  initialLocation.latitudeDegrees,
  initialLocation.longitudeDegrees,
);
const benchmarkScale = Number(benchmarkParameters.get("benchmarkScale"));
if (Number.isFinite(benchmarkScale) && benchmarkScale >= 1) {
  state.displayRadiusM = benchmarkScale;
}
const terrain = new TerrainSurface({
  renderer,
  baseTexture: blueMarbleTexture,
  imageryProvider: photographicImageryProvider,
  initialView: {
    latitudeDegrees: initialLocation.latitudeDegrees,
    longitudeDegrees: initialLocation.longitudeDegrees,
    displayRadiusM: state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    observerHeightWorldM: 1.65,
    focalLengthPixels: 1_000,
    footprint: [],
  },
});
planetRoot.add(terrain.group);
const aircraftLayer = new AircraftLayer();
planetRoot.add(aircraftLayer.group);
const satelliteLayer = new SatelliteLayer();
planetRoot.add(satelliteLayer.group);

const atmosphere = new AtmosphereLayer();
planetRoot.add(atmosphere.mesh);

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
  window.__PAS_DE_GEANT_TEST_SET_VIEW_PITCH__ = (pitchRadians): void => {
    pitch = Math.max(-1.35, Math.min(1.1, pitchRadians));
    camera.rotation.set(pitch, yaw, 0);
    updatePresentation();
  };
  window.__PAS_DE_GEANT_TEST_GET_TERRAIN_METRICS__ = () =>
    terrain.getMetrics();
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
const frameTelemetry = new FrameTelemetry();
let renderingEnabled = true;
let simulationInputEnabled = true;
let lastKnownXrFrameRate: number | undefined;
let previousXrHead: THREE.Vector2 | null = null;
const headsetFloorPosition = new THREE.Vector2();
const xrHeadPosition = new THREE.Vector3();
const xrViewQuaternion = new THREE.Quaternion();
const desktopTravel = new THREE.Vector2();
const geographicTravel = new THREE.Vector2();
const keys = new Set<string>();
const buttonLatch = freshButtonLatch();
const worldRotationQuaternion = new THREE.Quaternion();
const worldRotationPivot = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
let handPanelVisible = true;
let handPanelNorthDirection: HandPanelDirection = { x: 0, y: -1 };
let pointerActive = false;
let pointerX = 0;
let pointerY = 0;
let yaw = 0;
let worldRotationRadians = 0;
const benchmarkPitch = Number(benchmarkParameters.get("benchmarkPitch"));
let pitch = Number.isFinite(benchmarkPitch)
  ? Math.max(-1.35, Math.min(1.1, benchmarkPitch))
  : -0.55;
camera.rotation.set(pitch, yaw, 0);
let aircraftEnabled = false;
let aircraftLabelsEnabled = false;
let vrSessionActive = false;
let aircraftCount = 0;
let aircraftPollTimer: number | undefined;
let aircraftRequest: AbortController | undefined;

interface SatelliteGroupRuntime {
  enabled: boolean;
  count: number;
  fetchedAtMs: number;
  request?: AbortController;
  loadPromise?: Promise<SatelliteGroupControlState>;
  refreshTimer?: number;
  unavailable: boolean;
}

interface SatelliteGroupControlState {
  readonly group: SatelliteGroupId;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly status: "off" | "ready" | "loading" | "loaded" | "unavailable";
  readonly count: number;
}

const satelliteGroups: Record<SatelliteGroupId, SatelliteGroupRuntime> = {
  visual: {
    enabled: false,
    count: 0,
    fetchedAtMs: 0,
    unavailable: false,
  },
  stations: {
    enabled: false,
    count: 0,
    fetchedAtMs: 0,
    unavailable: false,
  },
  "science-education": {
    enabled: false,
    count: 0,
    fetchedAtMs: 0,
    unavailable: false,
  },
};

function resetPlanet(): void {
  state = initialPlanetState(
    initialLocation.latitudeDegrees,
    initialLocation.longitudeDegrees,
  );
  previousXrHead = null;
  updatePresentation();
}

function setUserLocation(
  latitudeDegrees: number,
  longitudeDegrees: number,
): { latitudeDegrees: number; longitudeDegrees: number } {
  state.contact = initialPlanetState(
    latitudeDegrees,
    longitudeDegrees,
  ).contact;
  previousXrHead = null;
  updatePresentation();
  return coordinatesForFrame(state.contact);
}

const viewDirectionQuaternion = new THREE.Quaternion();

function viewWorldHeadingDegrees(): number {
  const viewCamera = renderer.xr.isPresenting
    ? renderer.xr.getCamera()
    : camera;
  viewCamera.updateWorldMatrix(true, false);
  viewCamera.getWorldQuaternion(viewDirectionQuaternion);
  return viewHeadingDegreesFromQuaternion(viewDirectionQuaternion);
}

function viewDirectionState(): Record<string, unknown> {
  const viewWorldHeading = viewWorldHeadingDegrees();
  return {
    heading_degrees: geographicViewHeadingDegrees(
      viewWorldHeading,
      worldRotationRadians,
    ),
    reference: "clockwise from geographic north",
  };
}

function setViewDirection(argumentsValue: unknown): Record<string, unknown> {
  const command = parseViewDirectionToolArguments(argumentsValue);
  const viewWorldHeading = viewWorldHeadingDegrees();
  worldRotationRadians = worldRotationForViewDirection(
    worldRotationRadians,
    viewWorldHeading,
    command,
  );
  updatePresentation();
  return {
    ok: true,
    mode: command.mode,
    requested_degrees: command.degrees,
    ...viewDirectionState(),
  };
}

function setTileOverlayVisible(visible: boolean): void {
  tileOverlayVisible = visible;
  document.body.dataset.detailTileOverlay = String(visible);
  terrain.setTileOverlayVisible(visible);
}

function setTextureTileOverlayVisible(visible: boolean): void {
  textureTileOverlayVisible = visible;
  document.body.dataset.detailTextureTileOverlay = String(visible);
  terrain.setTextureTileOverlayVisible(visible);
}

const terrainEyeWorldPosition = new THREE.Vector3();
const terrainDrawingBufferSize = new THREE.Vector2();
const terrainRayWorldPoint = new THREE.Vector3();
const terrainRayLocalOrigin = new THREE.Vector3();
const terrainRayLocalPoint = new THREE.Vector3();
const terrainRayLocalDirection = new THREE.Vector3();
const terrainSurfacePoint = new THREE.Vector3();
const TERRAIN_EQUATORIAL_RADIUS = WGS84_A_KM / EARTH_MEAN_RADIUS_KM;
const TERRAIN_POLAR_RADIUS = WGS84_B_KM / EARTH_MEAN_RADIUS_KM;
const terrainFootprint: Array<{
  latitudeDegrees: number;
  longitudeDegrees: number;
}> = [];
let terrainFootprintLength = 0;
const TERRAIN_NDC_SAMPLES = [-1, 0, 1] as const;

function appendTerrainFootprint(viewCamera: THREE.Camera): void {
  viewCamera.updateWorldMatrix(true, false);
  viewCamera.getWorldPosition(terrainEyeWorldPosition);
  for (const ndcY of TERRAIN_NDC_SAMPLES) {
    for (const ndcX of TERRAIN_NDC_SAMPLES) {
      terrainRayWorldPoint.set(ndcX, ndcY, 0.5).unproject(viewCamera);
      terrainRayLocalOrigin.copy(terrainEyeWorldPosition);
      planetRoot.worldToLocal(terrainRayLocalOrigin);
      terrainRayLocalPoint.copy(terrainRayWorldPoint);
      planetRoot.worldToLocal(terrainRayLocalPoint);
      terrainRayLocalDirection
        .subVectors(terrainRayLocalPoint, terrainRayLocalOrigin)
        .normalize();
      intersectEllipsoidRay(
        terrainRayLocalOrigin,
        terrainRayLocalDirection,
        TERRAIN_EQUATORIAL_RADIUS,
        TERRAIN_POLAR_RADIUS,
        terrainSurfacePoint,
      );
      const point = terrainFootprint[terrainFootprintLength] ?? {
        latitudeDegrees: 0,
        longitudeDegrees: 0,
      };
      terrainFootprint[terrainFootprintLength++] = point;
      const horizontal = Math.hypot(
        terrainSurfacePoint.x,
        terrainSurfacePoint.z,
      );
      point.latitudeDegrees = THREE.MathUtils.radToDeg(Math.atan2(
        terrainSurfacePoint.y /
          (TERRAIN_POLAR_RADIUS * TERRAIN_POLAR_RADIUS),
        horizontal /
          (TERRAIN_EQUATORIAL_RADIUS * TERRAIN_EQUATORIAL_RADIUS),
      ));
      point.longitudeDegrees = THREE.MathUtils.radToDeg(
        Math.atan2(-terrainSurfacePoint.z, terrainSurfacePoint.x),
      );
    }
  }
}

function terrainViewMetrics(): {
  eyeHeightWorldM: number;
  focalLengthPixels: number;
  footprint: readonly GeographicPoint[];
} {
  const viewCamera = renderer.xr.isPresenting
    ? renderer.xr.getCamera()
    : camera;
  viewCamera.updateWorldMatrix(true, false);
  viewCamera.getWorldPosition(terrainEyeWorldPosition);
  planetRoot.updateWorldMatrix(true, false);
  terrainFootprintLength = 0;
  if (viewCamera instanceof THREE.ArrayCamera) {
    for (const eyeCamera of viewCamera.cameras) appendTerrainFootprint(eyeCamera);
  } else {
    appendTerrainFootprint(viewCamera);
  }
  terrainFootprint.length = terrainFootprintLength;
  // The local-floor reference space measures eye height from world y=0,
  // which is the un-displaced flat base surface used for terrain LOD.
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
    footprint: terrainFootprint,
  };
}

function updatePresentation(): void {
  const coordinates = coordinatesForFrame(state.contact);
  const pose = solvePlanetPose(state, headsetFloorPosition);
  worldRotationQuaternion.setFromAxisAngle(worldUp, worldRotationRadians);
  worldRotationPivot.set(
    headsetFloorPosition.x,
    0,
    headsetFloorPosition.y,
  );
  planetRoot.quaternion
    .copy(pose.earthToWorld)
    .premultiply(worldRotationQuaternion);
  planetRoot.position
    .copy(pose.centre)
    .sub(worldRotationPivot)
    .applyQuaternion(worldRotationQuaternion)
    .add(worldRotationPivot);
  planetRoot.scale.setScalar(state.displayRadiusM);
  const view = terrainViewMetrics();
  document.body.dataset.displayScale = state.displayRadiusM.toFixed(2);
  terrain.update({
    latitudeDegrees: coordinates.latitudeDegrees,
    longitudeDegrees: coordinates.longitudeDegrees,
    displayRadiusM: state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    observerHeightWorldM: view.eyeHeightWorldM,
    focalLengthPixels: view.focalLengthPixels,
    footprint: view.footprint,
  });
  atmosphere.update({
    displayRadiusM: state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    observerHeightWorldM: view.eyeHeightWorldM,
  });
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
      const namedLocation = await fetchNamedLocationContext(
        coordinates.latitudeDegrees,
        coordinates.longitudeDegrees,
        AGENT_LOCATION_DETAIL,
      );
      return {
        latitude_degrees: coordinates.latitudeDegrees,
        longitude_degrees: coordinates.longitudeDegrees,
        coordinate_reference_system: "WGS 84",
        coordinate_source: "live app position under the user’s feet",
        display_scale_factor: state.displayRadiusM,
        location_detail: AGENT_LOCATION_DETAIL,
        named_location_is_approximate: namedLocation !== undefined,
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
    get_view_direction() {
      return viewDirectionState();
    },
    set_view_direction(argumentsValue) {
      return setViewDirection(argumentsValue);
    },
    async set_satellite_group_visibility(argumentsValue) {
      const { group, enabled } =
        parseSatelliteVisibilityArguments(argumentsValue);
      return await setSatelliteGroupEnabled(group, enabled);
    },
    get_celestial_visibility() {
      return celestialSphere.getVisibility();
    },
    set_celestial_visibility(argumentsValue) {
      const { target, enabled } =
        parseCelestialVisibilityArguments(argumentsValue);
      return {
        ok: true,
        target,
        ...celestialSphere.setVisibility(target, enabled),
      };
    },
    async search_wikipedia(argumentsValue) {
      const { query } = parseKnowledgeSearchArguments(argumentsValue);
      clearResearch();
      const result = await searchWikipedia(query);
      showResearch(
        result.results[0]?.summary ?? "No Wikipedia summary was found.",
        result.results,
      );
      return result;
    },
    async search_web(argumentsValue) {
      const { query } = parseKnowledgeSearchArguments(argumentsValue);
      clearResearch();
      const result = await searchWeb(query);
      showResearch(result.answer, result.sources);
      return result;
    },
    get_aircraft_display() {
      return aircraftDisplayState();
    },
    set_aircraft_display(argumentsValue) {
      const display = parseAircraftDisplayArguments(argumentsValue);
      if (display.target === "aircraft") {
        setAircraftEnabled(display.enabled);
      } else {
        setAircraftLabelsEnabled(display.enabled);
      }
      return { ok: true, ...aircraftDisplayState() };
    },
    get_tile_debug_controls() {
      return terrain.getTileDebugControls();
    },
    get_tile_planner_state() {
      return terrain.getTilePlannerState();
    },
    set_tile_pixel_ratio(argumentsValue) {
      return terrain.setTilePixelRatio(
        parseTilePixelRatioArguments(argumentsValue),
      );
    },
    set_tile_max_zoom(argumentsValue) {
      return terrain.setTileMaxZoom(
        parseTileMaxZoomArguments(argumentsValue),
      );
    },
    set_tile_view_distance(argumentsValue) {
      return terrain.setTileViewDistance(
        parseTileViewDistanceArguments(argumentsValue),
      );
    },
    set_tile_view_overhead(argumentsValue) {
      return terrain.setTileViewOverhead(
        parseTileViewOverheadArguments(argumentsValue),
      );
    },
    set_tile_delta_zoom_cap(argumentsValue) {
      return terrain.setTileDeltaZoomCap(
        parseTileDeltaZoomCapArguments(argumentsValue),
      );
    },
    set_tile_recalculation(argumentsValue) {
      return terrain.setTileRecalculation(
        parseTileRecalculationArguments(argumentsValue),
      );
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
        geographicTravelFromWorld(
          displacement,
          worldRotationRadians,
          geographicTravel,
        ),
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
      geographicTravelFromWorld(
        travel,
        worldRotationRadians,
        geographicTravel,
      ),
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
      geographicTravelFromWorld(
        travel,
        worldRotationRadians,
        geographicTravel,
      ),
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
      enabled: aircraftEnabled || aircraftLabelsEnabled,
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
    enabled: aircraftEnabled || aircraftLabelsEnabled,
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

function aircraftDisplayState(): Record<string, unknown> {
  return {
    aircraft_enabled: aircraftEnabled,
    labels_enabled: aircraftLabelsEnabled,
    vr_session_active: vrSessionActive,
    aircraft_count: aircraftCount,
  };
}

function syncAircraftDisplay(): void {
  const displayEnabled = aircraftEnabled || aircraftLabelsEnabled;
  aircraftLayer.symbolsVisible = aircraftEnabled;
  aircraftLayer.labelsVisible = aircraftLabelsEnabled;
  aircraftLayer.visible = displayEnabled && vrSessionActive;
  document.body.dataset.aircraftEnabled = String(aircraftEnabled);
  document.body.dataset.aircraftLabelsEnabled = String(
    aircraftLabelsEnabled,
  );
  if (displayEnabled && vrSessionActive) {
    aircraftReadout.textContent =
      aircraftCount > 0 ? `${aircraftCount} nearby · cached` : "Connecting…";
    scheduleAircraftPoll(0);
  } else if (displayEnabled) {
    stopAircraftPolling();
    aircraftReadout.textContent = "Ready for VR";
  } else {
    stopAircraftPolling();
    aircraftReadout.textContent = "Off · optional";
  }
}

function setAircraftEnabled(enabled: boolean): void {
  aircraftEnabled = enabled;
  aircraftToggle.checked = enabled;
  syncAircraftDisplay();
}

function setAircraftLabelsEnabled(enabled: boolean): void {
  aircraftLabelsEnabled = enabled;
  aircraftLabelsToggle.checked = enabled;
  syncAircraftDisplay();
}

aircraftToggle.addEventListener("change", () => {
  setAircraftEnabled(aircraftToggle.checked);
});
aircraftLabelsToggle.addEventListener("change", () => {
  setAircraftLabelsEnabled(aircraftLabelsToggle.checked);
});

function satelliteGroupControlState(
  group: SatelliteGroupId,
): SatelliteGroupControlState {
  const runtime = satelliteGroups[group];
  let status: SatelliteGroupControlState["status"];
  if (!runtime.enabled) status = "off";
  else if (runtime.request) status = "loading";
  else if (runtime.unavailable) status = "unavailable";
  else if (!vrSessionActive) status = "ready";
  else status = runtime.fetchedAtMs > 0 ? "loaded" : "ready";
  return {
    group,
    enabled: runtime.enabled,
    visible: satelliteLayer.groupVisible(group),
    status,
    count: runtime.count,
  };
}

function updateSatelliteReadout(): void {
  const enabled = SATELLITE_GROUPS.filter(
    ({ id }) => satelliteGroups[id].enabled,
  );
  const loading = enabled.filter(({ id }) => satelliteGroups[id].request);
  const unavailable = enabled.filter(
    ({ id }) => satelliteGroups[id].unavailable,
  );
  const count = enabled.reduce(
    (total, { id }) => total + satelliteGroups[id].count,
    0,
  );
  if (enabled.length === 0) {
    satelliteReadout.textContent = "All groups off";
  } else if (!vrSessionActive) {
    satelliteReadout.textContent =
      `${enabled.length} ${enabled.length === 1 ? "group" : "groups"} · ready for VR`;
  } else if (loading.length > 0) {
    satelliteReadout.textContent = `${loading.length} loading…`;
  } else if (unavailable.length > 0 && count === 0) {
    satelliteReadout.textContent = "Unavailable";
  } else if (unavailable.length > 0) {
    satelliteReadout.textContent = `${count} tracked · stale`;
  } else {
    satelliteReadout.textContent =
      `${count} tracked · ${enabled.length} ${enabled.length === 1 ? "group" : "groups"}`;
  }
  document.body.dataset.satelliteCount = String(count);
  for (const { id } of SATELLITE_GROUPS) {
    document.body.setAttribute(
      `data-satellite-${id}-enabled`,
      String(satelliteGroups[id].enabled),
    );
    document.body.setAttribute(
      `data-satellite-${id}-count`,
      String(satelliteGroups[id].count),
    );
  }
}

function stopSatelliteGroup(group: SatelliteGroupId): void {
  const runtime = satelliteGroups[group];
  if (runtime.refreshTimer !== undefined) {
    window.clearTimeout(runtime.refreshTimer);
    runtime.refreshTimer = undefined;
  }
  runtime.request?.abort();
}

function scheduleSatelliteRefresh(group: SatelliteGroupId): void {
  const runtime = satelliteGroups[group];
  if (
    !runtime.enabled ||
    !vrSessionActive ||
    document.hidden ||
    runtime.request ||
    runtime.unavailable ||
    runtime.fetchedAtMs <= 0
  ) {
    return;
  }
  if (runtime.refreshTimer !== undefined) {
    window.clearTimeout(runtime.refreshTimer);
  }
  const delayMs = Math.max(
    0,
    runtime.fetchedAtMs + SATELLITE_REFRESH_INTERVAL_MS - Date.now(),
  );
  runtime.refreshTimer = window.setTimeout(() => {
    runtime.refreshTimer = undefined;
    void loadSatelliteGroup(group, true);
  }, delayMs);
}

function loadSatelliteGroup(
  group: SatelliteGroupId,
  force = false,
): Promise<SatelliteGroupControlState> {
  const runtime = satelliteGroups[group];
  if (
    !runtime.enabled ||
    !vrSessionActive ||
    document.hidden
  ) {
    updateSatelliteReadout();
    return Promise.resolve(satelliteGroupControlState(group));
  }
  if (runtime.loadPromise) return runtime.loadPromise;
  if (
    !force &&
    runtime.fetchedAtMs > 0 &&
    Date.now() - runtime.fetchedAtMs < SATELLITE_REFRESH_INTERVAL_MS
  ) {
    scheduleSatelliteRefresh(group);
    updateSatelliteReadout();
    return Promise.resolve(satelliteGroupControlState(group));
  }

  const request = new AbortController();
  runtime.request = request;
  runtime.unavailable = false;
  updateSatelliteReadout();
  const promise = (async (): Promise<SatelliteGroupControlState> => {
    try {
      const payload = await fetchSatelliteGroup(group, request.signal);
      if (runtime.request !== request) return satelliteGroupControlState(group);
      runtime.count = satelliteLayer.setSatellites(group, payload.satellites);
      runtime.fetchedAtMs = payload.fetchedAtMs;
      runtime.unavailable = false;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        runtime.unavailable = true;
        console.warn(
          `Satellite ${group} update failed:`,
          error,
        );
      }
    } finally {
      if (runtime.request === request) runtime.request = undefined;
      runtime.loadPromise = undefined;
      scheduleSatelliteRefresh(group);
      updateSatelliteReadout();
      if (
        request.signal.aborted &&
        runtime.enabled &&
        vrSessionActive &&
        !document.hidden
      ) {
        queueMicrotask(() => void loadSatelliteGroup(group));
      }
    }
    return satelliteGroupControlState(group);
  })();
  runtime.loadPromise = promise;
  return promise;
}

async function setSatelliteGroupEnabled(
  group: SatelliteGroupId,
  enabled: boolean,
): Promise<SatelliteGroupControlState> {
  const runtime = satelliteGroups[group];
  runtime.enabled = enabled;
  satelliteToggles[group].checked = enabled;
  satelliteLayer.setGroupVisible(group, enabled && vrSessionActive);
  if (!enabled) {
    stopSatelliteGroup(group);
    updateSatelliteReadout();
    return satelliteGroupControlState(group);
  }
  updateSatelliteReadout();
  return await loadSatelliteGroup(group);
}

for (const { id } of SATELLITE_GROUPS) {
  satelliteToggles[id].addEventListener("change", () => {
    void setSatelliteGroupEnabled(id, satelliteToggles[id].checked);
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAircraftPolling();
    for (const { id } of SATELLITE_GROUPS) stopSatelliteGroup(id);
  } else {
    scheduleAircraftPoll(0);
    for (const { id } of SATELLITE_GROUPS) void loadSatelliteGroup(id);
  }
});

const vrButton = VRButton.createButton(renderer);
vrSlot.append(vrButton);
renderer.xr.addEventListener("sessionstart", () => {
  vrSessionActive = true;
  syncAircraftDisplay();
  for (const { id } of SATELLITE_GROUPS) {
    const enabled = satelliteGroups[id].enabled;
    satelliteLayer.setGroupVisible(id, enabled);
    if (enabled) void loadSatelliteGroup(id);
  }
  updateSatelliteReadout();
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  previousXrHead = null;
  renderer.xr.setFoveation(1);
  const frameRate = renderer.xr.getSession()?.frameRate;
  if (frameRate !== undefined && frameRate > 0) {
    lastKnownXrFrameRate = frameRate;
  }
});
renderer.xr.addEventListener("sessionend", () => {
  vrSessionActive = false;
  voiceAgent.disable();
  handPanel.enabled = false;
  stopAircraftPolling();
  aircraftLayer.visible = false;
  for (const { id } of SATELLITE_GROUPS) {
    stopSatelliteGroup(id);
    satelliteLayer.setGroupVisible(id, false);
  }
  updateSatelliteReadout();
  aircraftReadout.textContent = aircraftEnabled || aircraftLabelsEnabled
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

const debugDrawingBufferSize = new THREE.Vector2();
const debugHeadWorldPosition = new THREE.Vector3();
const debugMarks = new Map<string, Record<string, unknown>>();

interface BenchmarkRestoreState {
  readonly coordinates: {
    readonly latitudeDegrees: number;
    readonly longitudeDegrees: number;
  };
  readonly displayRadiusM: number;
  readonly radialMultiplier: number;
  readonly pitchRadians: number;
  readonly yawRadians: number;
  readonly worldRotationRadians: number;
  readonly tileControls: TileDebugControlsReadback;
  readonly tileOverlayVisible: boolean;
  readonly textureTileOverlayVisible: boolean;
  readonly renderingEnabled: boolean;
  readonly simulationInputEnabled: boolean;
  readonly foveation: number | undefined;
  readonly layers: {
    readonly terrain: boolean;
    readonly atmosphere: boolean;
    readonly stars: boolean;
    readonly aircraft: boolean;
    readonly handPanel: boolean;
  };
}

let benchmarkRestoreState: BenchmarkRestoreState | undefined;

function finiteDebugNumber(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`);
  return value;
}

function debugTileTarget(target: TileDebugTarget): TileDebugTarget {
  if (target !== "terrain" && target !== "textures" && target !== "both") {
    throw new Error("target must be terrain, textures, or both.");
  }
  return target;
}

function debugControlState(): Record<string, unknown> {
  const coordinates = coordinatesForFrame(state.contact);
  return {
    location: coordinates,
    displayRadiusM: state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    view: {
      pitchRadians: pitch,
      yawRadians: yaw,
      worldRotationRadians,
      worldRotationDegrees: normalizeHeadingDegrees(
        worldRotationRadians * 180 / Math.PI,
      ),
    },
    tileControls: terrain.getTileDebugControls(),
    overlays: {
      terrain: tileOverlayVisible,
      textures: textureTileOverlayVisible,
    },
    renderingEnabled,
    simulationInputEnabled,
    benchmarkActive: benchmarkRestoreState !== undefined,
    foveation: renderer.xr.getFoveation() ?? null,
    xrFramebufferScaleFactor,
    desktopPixelRatio: renderer.getPixelRatio(),
    layers: {
      terrain: terrain.group.visible,
      atmosphere: atmosphere.mesh.visible,
      stars: celestialSphere.object3d.visible,
      aircraft: aircraftLayer.group.visible,
      handPanel: handPanelVisible,
    },
  };
}

function debugRendererSnapshot(): Record<string, unknown> {
  renderer.getDrawingBufferSize(debugDrawingBufferSize);
  const gl = renderer.getContext();
  const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const session = renderer.xr.getSession();
  return {
    threeRevision: THREE.REVISION,
    xr: {
      presenting: renderer.xr.isPresenting,
      frameRate: session?.frameRate ?? null,
      lastKnownFrameRate: lastKnownXrFrameRate ?? null,
      supportedFrameRates: session?.supportedFrameRates
        ? Array.from(session.supportedFrameRates)
        : [],
      foveation: renderer.xr.getFoveation() ?? null,
      framebufferScaleFactor: xrFramebufferScaleFactor,
    },
    drawingBuffer: {
      width: debugDrawingBufferSize.x,
      height: debugDrawingBufferSize.y,
      pixelRatio: renderer.getPixelRatio(),
    },
    draw: { ...renderer.info.render },
    memory: {
      ...renderer.info.memory,
      programs: renderer.info.programs?.length ?? 0,
    },
    gpu: {
      vendor: rendererInfo
        ? gl.getParameter(rendererInfo.UNMASKED_VENDOR_WEBGL) as string
        : gl.getParameter(gl.VENDOR) as string,
      renderer: rendererInfo
        ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) as string
        : gl.getParameter(gl.RENDERER) as string,
      timerQueries: gl.getExtension("EXT_disjoint_timer_query_webgl2") !== null,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxArrayTextureLayers: typeof WebGL2RenderingContext !== "undefined" &&
          gl instanceof WebGL2RenderingContext
        ? gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number
        : null,
    },
  };
}

function debugBrowserSnapshot(): Record<string, unknown> {
  const browserPerformance = performance as Performance & {
    memory?: {
      readonly jsHeapSizeLimit: number;
      readonly totalJSHeapSize: number;
      readonly usedJSHeapSize: number;
    };
  };
  const browserNavigator = navigator as Navigator & {
    readonly deviceMemory?: number;
  };
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: browserNavigator.deviceMemory ?? null,
    visibility: document.visibilityState,
    screen: {
      width: screen.width,
      height: screen.height,
      devicePixelRatio: window.devicePixelRatio,
    },
    jsHeap: browserPerformance.memory
      ? {
          limitBytes: browserPerformance.memory.jsHeapSizeLimit,
          totalBytes: browserPerformance.memory.totalJSHeapSize,
          usedBytes: browserPerformance.memory.usedJSHeapSize,
        }
      : null,
  };
}

function debugSnapshot(): Record<string, unknown> {
  const sessionFrameRate = renderer.xr.getSession()?.frameRate;
  if (sessionFrameRate !== undefined && sessionFrameRate > 0) {
    lastKnownXrFrameRate = sessionFrameRate;
  }
  return {
    capturedAt: new Date().toISOString(),
    controls: debugControlState(),
    frame: frameTelemetry.snapshot(
      sessionFrameRate && sessionFrameRate > 0
        ? sessionFrameRate
        : lastKnownXrFrameRate,
    ),
    renderer: debugRendererSnapshot(),
    terrain: terrain.getMetrics(),
    planner: terrain.getTilePlannerState(),
    resourcesByHostLast30Seconds: summarizeResourceTimings(
      performance.getEntriesByType("resource") as PerformanceResourceTiming[],
      performance.now(),
    ),
    browser: debugBrowserSnapshot(),
    imagery: {
      provider: photographicImageryProvider?.id ?? "blue-marble",
      tileSize: photographicImageryProvider?.tileSize ?? 0,
    },
  };
}

function captureBenchmarkRestoreState(): BenchmarkRestoreState {
  return {
    coordinates: coordinatesForFrame(state.contact),
    displayRadiusM: state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    pitchRadians: pitch,
    yawRadians: yaw,
    worldRotationRadians,
    tileControls: terrain.getTileDebugControls(),
    tileOverlayVisible,
    textureTileOverlayVisible,
    renderingEnabled,
    simulationInputEnabled,
    foveation: renderer.xr.getFoveation(),
    layers: {
      terrain: terrain.group.visible,
      atmosphere: atmosphere.mesh.visible,
      stars: celestialSphere.object3d.visible,
      aircraft: aircraftLayer.group.visible,
      handPanel: handPanelVisible,
    },
  };
}

function setSimulationInputEnabled(enabled: boolean): void {
  if (!enabled && renderer.xr.isPresenting) {
    renderer.xr.getCamera().getWorldPosition(debugHeadWorldPosition);
    headsetFloorPosition.set(debugHeadWorldPosition.x, debugHeadWorldPosition.z);
  }
  simulationInputEnabled = enabled;
  previousXrHead = null;
  updatePresentation();
}

function applyTileControlReadback(controls: TileDebugControlsReadback): void {
  terrain.setTileRecalculation({ target: "both", enabled: false });
  terrain.setTilePixelRatio({
    target: "terrain",
    screenPixelsPerSourcePixel:
      controls.terrain.screen_pixels_per_source_pixel,
  });
  terrain.setTilePixelRatio({
    target: "textures",
    screenPixelsPerSourcePixel:
      controls.textures.screen_pixels_per_source_pixel,
  });
  terrain.setTileMaxZoom({
    target: "terrain",
    value: controls.terrain.max_zoom,
  });
  terrain.setTileMaxZoom({
    target: "textures",
    value: controls.textures.max_zoom,
  });
  terrain.setTileViewDistance({
    target: "terrain",
    enabled: controls.terrain.view_distance_enabled,
  });
  terrain.setTileViewDistance({
    target: "textures",
    enabled: controls.textures.view_distance_enabled,
  });
  terrain.setTileDeltaZoomCap({
    target: "terrain",
    value: controls.terrain.delta_zoom_cap,
  });
  terrain.setTileDeltaZoomCap({
    target: "textures",
    value: controls.textures.delta_zoom_cap,
  });
  terrain.setTileViewOverhead(controls.view_overhead_percent);
  terrain.setTileRecalculation({
    target: "terrain",
    enabled: controls.terrain.recalculation_enabled,
  });
  terrain.setTileRecalculation({
    target: "textures",
    enabled: controls.textures.recalculation_enabled,
  });
}

const debugApi: PasDeGeantDebugApi = {
  help() {
    return {
      snapshot: "snapshot() — controls, frames, renderer, tiles, network, browser",
      marks: "mark(name?), marks(), clearMetrics()",
      benchmark: "beginBenchmark(options?), then freeze with setTileRecalculation(\"both\", false) once planner work is zero; endBenchmark() restores the captured session",
      position: "setLocation(lat, lon), setScale(radiusM), setRadialMultiplier(value), setView({pitchRadians?, yawRadians?}), reset()",
      tiles: "setTilePixelRatio(target, ratio), setMaxZ(target, z|null), setDeltaZ(target, z|null), setViewDistance(target, enabled), setViewOverhead(percent), setTileRecalculation(target, enabled)",
      rendering: "setRendering(enabled), setInputEnabled(enabled), setFoveation(0..1), setFramebufferScale(value), setDesktopPixelRatio(value)",
      layers: "setOverlays({terrain?, textures?}), setLayerVisibility(name, visible)",
      targets: 'tile target: "terrain", "textures", or "both"',
    };
  },
  snapshot: debugSnapshot,
  mark(name = "default") {
    const snapshot = debugSnapshot();
    debugMarks.set(name, snapshot);
    return snapshot;
  },
  marks() {
    return Object.fromEntries(debugMarks);
  },
  clearMetrics() {
    frameTelemetry.clear();
    performance.clearResourceTimings();
    debugMarks.clear();
  },
  beginBenchmark(options = {}) {
    const latitudeDegrees = finiteDebugNumber(
      options.latitudeDegrees ?? 43.722952,
      "latitudeDegrees",
    );
    const longitudeDegrees = finiteDebugNumber(
      options.longitudeDegrees ?? 10.396597,
      "longitudeDegrees",
    );
    const displayRadiusM = finiteDebugNumber(
      options.displayRadiusM ?? INITIAL_DISPLAY_RADIUS_M,
      "displayRadiusM",
    );
    const radialMultiplier = finiteDebugNumber(
      options.radialMultiplier ?? 1,
      "radialMultiplier",
    );
    if (displayRadiusM <= 0) {
      throw new Error("displayRadiusM must be positive.");
    }
    if (radialMultiplier < 0) {
      throw new Error("radialMultiplier must be nonnegative.");
    }
    benchmarkRestoreState ??= captureBenchmarkRestoreState();
    setSimulationInputEnabled(false);
    terrain.setTileRecalculation({ target: "both", enabled: false });
    setUserLocation(latitudeDegrees, longitudeDegrees);
    state.displayRadiusM = displayRadiusM;
    state.radialMultiplier = radialMultiplier;
    pitch = 0;
    yaw = 0;
    worldRotationRadians = 0;
    camera.rotation.set(0, 0, 0);
    terrain.setTilePixelRatio({
      target: "terrain",
      screenPixelsPerSourcePixel: 2,
    });
    terrain.setTilePixelRatio({
      target: "textures",
      screenPixelsPerSourcePixel: 1,
    });
    terrain.setTileMaxZoom({ target: "both", value: null });
    terrain.setTileDeltaZoomCap({ target: "both", value: null });
    terrain.setTileViewDistance({ target: "both", enabled: true });
    terrain.setTileViewOverhead(25);
    setTileOverlayVisible(false);
    setTextureTileOverlayVisible(false);
    renderingEnabled = true;
    terrain.group.visible = true;
    celestialSphere.object3d.visible = true;
    aircraftLayer.group.visible = false;
    handPanelVisible = false;
    handPanel.enabled = false;
    renderer.xr.setFoveation(1);
    updatePresentation();
    terrain.setTileRecalculation({ target: "both", enabled: true });
    frameTelemetry.clear();
    performance.clearResourceTimings();
    debugMarks.clear();
    return {
      preset: "fixed-location-defaults",
      ...debugControlState(),
    };
  },
  endBenchmark() {
    const restore = benchmarkRestoreState;
    if (!restore) return debugControlState();
    benchmarkRestoreState = undefined;
    simulationInputEnabled = false;
    terrain.setTileRecalculation({ target: "both", enabled: false });
    setUserLocation(
      restore.coordinates.latitudeDegrees,
      restore.coordinates.longitudeDegrees,
    );
    state.displayRadiusM = restore.displayRadiusM;
    state.radialMultiplier = restore.radialMultiplier;
    pitch = restore.pitchRadians;
    yaw = restore.yawRadians;
    worldRotationRadians = restore.worldRotationRadians;
    camera.rotation.set(pitch, yaw, 0);
    applyTileControlReadback(restore.tileControls);
    setTileOverlayVisible(restore.tileOverlayVisible);
    setTextureTileOverlayVisible(restore.textureTileOverlayVisible);
    renderingEnabled = restore.renderingEnabled;
    terrain.group.visible = restore.layers.terrain;
    atmosphere.mesh.visible = restore.layers.atmosphere;
    celestialSphere.object3d.visible = restore.layers.stars;
    aircraftLayer.group.visible = restore.layers.aircraft;
    handPanelVisible = restore.layers.handPanel;
    if (restore.foveation !== undefined) {
      renderer.xr.setFoveation(restore.foveation);
    }
    setSimulationInputEnabled(restore.simulationInputEnabled);
    frameTelemetry.clear();
    return debugControlState();
  },
  reset() {
    resetPlanet();
    frameTelemetry.clear();
    return debugControlState();
  },
  setLocation(latitudeDegrees, longitudeDegrees) {
    return setUserLocation(
      finiteDebugNumber(latitudeDegrees, "latitudeDegrees"),
      finiteDebugNumber(longitudeDegrees, "longitudeDegrees"),
    );
  },
  setScale(displayRadiusM) {
    const value = finiteDebugNumber(displayRadiusM, "displayRadiusM");
    if (value <= 0) throw new Error("displayRadiusM must be positive.");
    state.displayRadiusM = value;
    updatePresentation();
    return debugControlState();
  },
  setRadialMultiplier(multiplier) {
    const value = finiteDebugNumber(multiplier, "multiplier");
    if (value < 0) throw new Error("multiplier must be nonnegative.");
    state.radialMultiplier = value;
    updatePresentation();
    return debugControlState();
  },
  setView(view) {
    if (view.pitchRadians !== undefined) {
      pitch = finiteDebugNumber(view.pitchRadians, "pitchRadians");
    }
    if (view.yawRadians !== undefined) {
      yaw = finiteDebugNumber(view.yawRadians, "yawRadians");
    }
    camera.rotation.set(pitch, yaw, 0);
    updatePresentation();
    return debugControlState();
  },
  setTilePixelRatio(target, ratio) {
    const value = finiteDebugNumber(ratio, "ratio");
    if (value <= 0) throw new Error("ratio must be positive.");
    return terrain.setTilePixelRatio({
      target: debugTileTarget(target),
      screenPixelsPerSourcePixel: value,
    });
  },
  setMaxZ(target, zoom) {
    if (zoom !== null && (!Number.isInteger(zoom) || zoom < 0)) {
      throw new Error("zoom must be a nonnegative integer or null.");
    }
    return terrain.setTileMaxZoom({ target: debugTileTarget(target), value: zoom });
  },
  setDeltaZ(target, zoom) {
    if (zoom !== null && (!Number.isInteger(zoom) || zoom < 0)) {
      throw new Error("zoom must be a nonnegative integer or null.");
    }
    return terrain.setTileDeltaZoomCap({
      target: debugTileTarget(target),
      value: zoom,
    });
  },
  setViewDistance(target, enabled) {
    return terrain.setTileViewDistance({
      target: debugTileTarget(target),
      enabled,
    });
  },
  setViewOverhead(percent) {
    const value = finiteDebugNumber(percent, "percent");
    if (value < 0) throw new Error("percent must be nonnegative.");
    return terrain.setTileViewOverhead(value);
  },
  setTileRecalculation(target, enabled) {
    return terrain.setTileRecalculation({
      target: debugTileTarget(target),
      enabled,
    });
  },
  setOverlays(options) {
    if (options.terrain !== undefined) {
      setTileOverlayVisible(options.terrain);
    }
    if (options.textures !== undefined) {
      setTextureTileOverlayVisible(options.textures);
    }
    return debugControlState().overlays;
  },
  setRendering(enabled) {
    renderingEnabled = enabled;
    frameTelemetry.clear();
    return debugControlState();
  },
  setInputEnabled(enabled) {
    setSimulationInputEnabled(enabled);
    frameTelemetry.clear();
    return debugControlState();
  },
  setFoveation(value) {
    const foveation = finiteDebugNumber(value, "foveation");
    if (foveation < 0 || foveation > 1) {
      throw new Error("foveation must be between 0 and 1.");
    }
    renderer.xr.setFoveation(foveation);
    frameTelemetry.clear();
    return debugControlState();
  },
  setFramebufferScale(value) {
    const scale = finiteDebugNumber(value, "framebufferScale");
    if (scale <= 0) throw new Error("framebufferScale must be positive.");
    if (renderer.xr.isPresenting) {
      throw new Error("Framebuffer scale can only change outside an XR session. Exit VR, set it, then re-enter VR.");
    }
    xrFramebufferScaleFactor = scale;
    renderer.xr.setFramebufferScaleFactor(scale);
    frameTelemetry.clear();
    return debugControlState();
  },
  setDesktopPixelRatio(value) {
    const ratio = finiteDebugNumber(value, "pixelRatio");
    if (ratio <= 0) throw new Error("pixelRatio must be positive.");
    renderer.setPixelRatio(ratio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    frameTelemetry.clear();
    return debugControlState();
  },
  setLayerVisibility(layer, visible) {
    switch (layer) {
      case "terrain":
        terrain.group.visible = visible;
        break;
      case "atmosphere":
        atmosphere.mesh.visible = visible;
        break;
      case "stars":
        celestialSphere.object3d.visible = visible;
        break;
      case "aircraft":
        aircraftLayer.group.visible = visible;
        break;
      case "hand-panel":
        handPanelVisible = visible;
        if (!visible) handPanel.enabled = false;
        break;
      default:
        throw new Error(`Unknown layer: ${String(layer)}.`);
    }
    frameTelemetry.clear();
    return debugControlState();
  },
};

if (import.meta.env.DEV || benchmarkParameters.get("debug") === "1") {
  window.pasDeGeantDebug = debugApi;
  console.info("Pas de Géant runtime controls: window.pasDeGeantDebug.help()");
}

const cameraWorldPosition = new THREE.Vector3();
const celestialObserverAppEcefKm = new THREE.Vector3();
function render(nowMs: number): void {
  const applicationStartMs = performance.now();
  const xrFrameRate = renderer.xr.getSession()?.frameRate;
  if (xrFrameRate !== undefined && xrFrameRate > 0) {
    lastKnownXrFrameRate = xrFrameRate;
  }
  const utcMilliseconds = Date.now();
  const intervalMs = nowMs - previousFrameMs;
  const deltaSeconds = Math.min(0.05, intervalMs / 1000);
  previousFrameMs = nowMs;
  if (simulationInputEnabled) {
    if (renderer.xr.isPresenting) {
      updatePhysicalWalking();
      updateXrControls(deltaSeconds, nowMs);
    } else {
      updateDesktopControls(deltaSeconds);
    }
  }
  updatePresentation();
  aircraftLayer.update(
    utcMilliseconds,
    state.displayRadiusM,
    state.radialMultiplier,
  );
  satelliteLayer.update(
    utcMilliseconds,
    state.displayRadiusM,
    state.radialMultiplier,
  );
  const viewCamera = renderer.xr.isPresenting
    ? renderer.xr.getCamera()
    : camera;
  viewCamera.getWorldPosition(cameraWorldPosition);
  const observerCoordinates = coordinatesForFrame(state.contact);
  geodeticSurfaceEcefKm(
    observerCoordinates.latitudeDegrees,
    observerCoordinates.longitudeDegrees,
    celestialObserverAppEcefKm,
  ).addScaledVector(
    state.contact.upEcef,
    cameraWorldPosition.y / 1_000,
  );
  celestialSphere.update(
    planetRoot.quaternion,
    cameraWorldPosition,
    utcMilliseconds,
    celestialObserverAppEcefKm,
  );
  updateHandPanel(nowMs);
  if (renderingEnabled) renderer.render(scene, camera);
  frameTelemetry.record(
    nowMs,
    intervalMs,
    performance.now() - applicationStartMs,
    renderingEnabled,
  );
}

window.addEventListener("beforeunload", () => {
  if (benchmarkMetricsTimer !== undefined) {
    window.clearInterval(benchmarkMetricsTimer);
  }
  for (const { id } of SATELLITE_GROUPS) stopSatelliteGroup(id);
  terrain.dispose();
  celestialSphere.dispose();
  handPanel.dispose();
  handPanelRuntime.dispose();
});

const benchmarkMetricsTimer = benchmarkParameters.get("benchmarkMetrics") === "1"
  ? window.setInterval(() => {
      document.body.dataset.terrainMetrics = JSON.stringify(
        terrain.getMetrics(),
      );
    }, 1_000)
  : undefined;

updatePresentation();
setTileOverlayVisible(false);
setTextureTileOverlayVisible(false);
loadingState.hidden = true;
errorState.hidden = true;
aircraftLayer.visible = false;
setAircraftEnabled(false);
setAircraftLabelsEnabled(false);
for (const { id } of SATELLITE_GROUPS) {
  satelliteLayer.setGroupVisible(id, false);
  satelliteToggles[id].checked = false;
}
updateSatelliteReadout();
renderer.setAnimationLoop(render);
