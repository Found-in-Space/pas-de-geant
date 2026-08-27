import {
  createRuntime,
  type BitmapHandle,
  type RuntimeOutput,
} from "@found-in-space/touch-os";
import {
  createPoseAnchoredPanelDriver,
  createThreePanelSession,
  createXrRayPointerSource,
  type ThreeHostPose,
  type ThreePointerPhase,
} from "@found-in-space/touch-os/hosts/three";
import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import {
  AIRCRAFT_SUBSCRIPTION_REFRESH_INTERVAL_MS,
  FlightFollowerClient,
  type FlightFollowerConnectionState,
} from "./aircraft-feed.js";
import { AircraftLayer } from "./aircraft-layer.js";
import {
  parseAircraftDisplayArguments,
  shouldStreamAircraft,
  type AircraftDisplayTarget,
} from "./aircraft-lifecycle.js";
import { AtmosphereLayer } from "./atmosphere.js";
import {
  controllerIntent,
  dominantStickAxes,
  freshButtonLatch,
  headRelativeTravel,
  isHandTrackingInputSource,
  type DominantStickAxis,
} from "./controller-input.js";
import { bodyFixedToRenderQuaternion } from "./body-attitude.js";
import { CelestialSphere } from "./celestial-sphere.js";
import {
  observerProjectedToEarthRadius,
  updateTargetLockedOrbitFrame,
  type EclipseObserverTransform,
} from "./eclipse-observer.js";
import {
  eclipseEarthSurfaceObservation,
  eclipseTopographicSurfaceRadius,
} from "./eclipse-earth-surface.js";
import {
  parseCelestialVisibilityArguments,
} from "./celestial-visibility.js";
import {
  createHandPanelRoot,
  formatCoordinates,
  handPanelNavigationAction,
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
import { proxiedTileConfiguration } from "./tile-proxy.js";
import {
  applyLogarithmicScale,
  applyRadialMultiplierRate,
  contactFrame,
  coordinatesForFrame,
  EARTH_MEAN_RADIUS_KM,
  geodeticSurfaceEcefKm,
  initialPlanetState,
  INITIAL_DISPLAY_RADIUS_M,
  rollContactFrame,
  solvePlanetPose,
  type PlanetState,
} from "./planet-state.js";
import { resolveInitialLocation } from "./initial-location.js";
import {
  greatCircleDistanceKm,
  LocationPinStore,
  parseLocationPin,
  type LocationPin,
  type LocationPinState,
} from "./location-pin.js";
import { LocationPinLayer } from "./location-pin-layer.js";
import {
  AGENT_LOCATION_DETAIL,
  fetchNamedLocationContext,
  lookupLocations,
  parseLocationLookupArguments,
} from "./location-context.js";
import {
  parseLocationToolArguments,
  RealtimeVoiceAgent,
  type RealtimeAgentStatus,
} from "./realtime-agent.js";
import {
  applySupervisorLocationPinMutation,
  applySupervisorNavigationMutation,
  applyVoiceDisplayRadiusMutation,
  applyVoiceRenamePinMutation,
  applyVoiceRemovePinMutation,
  applyVoiceSetPinGuidanceMutation,
  applyVoiceSetPinMutation,
  applyVoiceSetPinVisibilityMutation,
  applyVoiceWarpMutation,
  type CanonicalLocationPinMutations,
  type CanonicalNavigationMutations,
} from "./navigation-mutation-adapters.js";
import {
  sampleAngleTransition,
  sampleScaleTransition,
  sampleWarpTransition,
  type NavigationCoordinates,
  type TimedTransition,
} from "./navigation-transition.js";
import { TerrainSurface } from "./terrain-surface.js";
import { lunarElevationProvider, lunarImageryProvider } from "./lunar-configuration.js";
import { MOON_SURFACE_MODEL } from "./surface-model.js";
import {
  SOLAR_SYSTEM_BODIES,
  bodyPositionJ2000M,
  bodyRotation,
  celestialBody,
  isSolarSystemBodyId,
  type SolarSystemBodyId,
  type Vector3d,
} from "./solar-system.js";
import {
  orbitalAngularStepRadians,
  orbitalLogarithmicValue,
  relativeJ2000MetresToRender,
  roomScaleForDisplayRadius,
  spaceTravelSpeedRoomMPerSecond,
  translatedObserverJ2000M,
  type NavigationMode,
} from "./world-navigation.js";
import {
  parseTileMaxZoomArguments,
  parseTilePixelRatioArguments,
  parseTileRecalculationArguments,
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
  geographicTravelFromWorld,
  geographicViewHeadingDegrees,
  normalizeHeadingDegrees,
  parseViewDirectionToolArguments,
  viewHeadingDegreesFromQuaternion,
  worldRotationForViewDirection,
  type ViewDirectionCommand,
} from "./view-direction.js";
import type {
  SupervisionCommand,
  SupervisionControlState,
  SupervisionNavigationSnapshot,
} from "./supervision-protocol.js";
import type {
  SupervisionClient,
  SupervisionConnectionStatus,
} from "./supervision-client.js";

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
  setTileRecalculation(target: TileDebugTarget, enabled: boolean): unknown;
  setOverlays(options: { terrain?: boolean; textures?: boolean }): unknown;
  setRendering(enabled: boolean): Record<string, unknown>;
  setTerrainRenderCulling(enabled: boolean): Record<string, unknown>;
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
const worldCheck = element<HTMLLIElement>("world-check");
const worldCheckStatus = element<HTMLSpanElement>("world-check-status");
const locationCheck = element<HTMLLIElement>("location-check");
const locationCheckStatus = element<HTMLSpanElement>("location-check-status");
const xrCheck = element<HTMLLIElement>("xr-check");
const xrCheckStatus = element<HTMLSpanElement>("xr-check-status");
const xrRequirements = element<HTMLParagraphElement>("xr-requirements");
const errorState = element<HTMLDivElement>("error-state");
const errorMessage = element<HTMLParagraphElement>("error-message");
const imageryAttribution = element<HTMLElement>("imagery-attribution");
const researchRegion = element<HTMLElement>("research-region");
const researchAnswer = element<HTMLParagraphElement>("research-answer");
const researchSources = element<HTMLUListElement>("research-sources");
const initialLocationPromise = resolveInitialLocation();

type PreflightState = "pending" | "ready" | "failed";

function setPreflightCheck(
  check: HTMLElement,
  status: HTMLElement,
  state: PreflightState,
  message: string,
): void {
  check.dataset.state = state;
  check.setAttribute("aria-busy", String(state === "pending"));
  status.textContent = message;
}

async function refreshXrSupport(): Promise<void> {
  try {
    const supported = await navigator.xr?.isSessionSupported("immersive-vr") ??
      false;
    setPreflightCheck(
      xrCheck,
      xrCheckStatus,
      supported ? "ready" : "failed",
      supported ? "Headset ready" : "Not available in this browser",
    );
    xrRequirements.hidden = supported;
    vrSlot.classList.toggle("is-unavailable", !supported);
  } catch {
    setPreflightCheck(
      xrCheck,
      xrCheckStatus,
      "failed",
      "Could not check XR support",
    );
    xrRequirements.hidden = false;
    vrSlot.classList.add("is-unavailable");
  }
}

void refreshXrSupport();

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
    logarithmicDepthBuffer: true,
  });
} catch (error) {
  setPreflightCheck(
    worldCheck,
    worldCheckStatus,
    "failed",
    "WebGL unavailable",
  );
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
  100_000_000,
);
camera.position.set(0, 1.65, 0);
camera.rotation.order = "YXZ";
camera.rotation.x = -0.55;
const observerRig = new THREE.Group();
observerRig.name = "world-observer-rig";
observerRig.add(camera);
scene.add(observerRig);
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
// Temporarily hide the Sun, Moon, and planet sky objects: their finite render
// distance can put them in front of Earth and make them show through at high zoom.
celestialSphere.setVisibility("all", false);
scene.add(celestialSphere.object3d);
const textureLoader = new THREE.TextureLoader();
const moonBaseTexturePromise = textureLoader.loadAsync(
  `${import.meta.env.BASE_URL}lroc-color-2k.jpg`,
);
void moonBaseTexturePromise.then(
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
const runtimeImageryConfiguration = selectedImageryConfiguration
  ? proxiedTileConfiguration(
      selectedImageryConfiguration,
      import.meta.env.DEV &&
        Boolean(import.meta.env.VITE_IMAGERY_XYZ_TEMPLATE),
      selectedImageryConfiguration === baseImageryConfiguration
        ? "textures-source"
        : "textures",
    )
  : undefined;
const photographicImageryProvider =
  window.__PAS_DE_GEANT_IMAGERY_PROVIDER__ ??
  configuredXyzImageryProvider(runtimeImageryConfiguration);
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
setPreflightCheck(
  locationCheck,
  locationCheckStatus,
  "ready",
  formatCoordinates(
    initialLocation.latitudeDegrees,
    initialLocation.longitudeDegrees,
  ),
);
let state = initialPlanetState(
  initialLocation.latitudeDegrees,
  initialLocation.longitudeDegrees,
);
let warpTransition: TimedTransition<NavigationCoordinates> | undefined;
let scaleTransition: TimedTransition<number> | undefined;
let headingTransition: TimedTransition<number> | undefined;
let navigationMode: NavigationMode = "surface";
let focusBodyId: SolarSystemBodyId = "earth";
let freeObserverJ2000M: Vector3d | undefined;
interface OrbitNavigationState {
  observer: EclipseObserverTransform;
  focusWorldPosition: THREE.Vector3;
  systemFrameQuaternion: THREE.Quaternion;
}
let orbitNavigation: OrbitNavigationState | undefined;
const EARTH_ORBIT_INITIAL_DISPLAY_RADIUS_M = 200;
interface FreeNavigationFrame {
  anchorWorldPosition: THREE.Vector3;
  systemFrameQuaternion: THREE.Quaternion;
}
let freeNavigationFrame: FreeNavigationFrame | undefined;
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
  },
});
planetRoot.add(terrain.group);
const locationPinStore = new LocationPinStore();
const locationPinLayer = new LocationPinLayer((latitudeDegrees, longitudeDegrees) =>
  terrain.sampleElevationMetres(latitudeDegrees, longitudeDegrees)
);
planetRoot.add(locationPinLayer.worldGroup);
scene.add(locationPinLayer.hudGroup);
const moonBaseTexture = (await moonBaseTexturePromise).clone();
moonBaseTexture.colorSpace = THREE.SRGBColorSpace;
moonBaseTexture.flipY = false;
moonBaseTexture.wrapS = THREE.RepeatWrapping;
moonBaseTexture.wrapT = THREE.ClampToEdgeWrapping;
moonBaseTexture.needsUpdate = true;
const moonRoot = new THREE.Group();
moonRoot.name = "moon-root";
scene.add(moonRoot);
const moonTerrain = new TerrainSurface({
  renderer,
  baseTexture: moonBaseTexture,
  imageryProvider: lunarImageryProvider(),
  elevationProvider: lunarElevationProvider(),
  surfaceModel: MOON_SURFACE_MODEL,
  initialView: {
    latitudeDegrees: initialLocation.latitudeDegrees,
    longitudeDegrees: initialLocation.longitudeDegrees,
    displayRadiusM: state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    observerHeightWorldM: 1.65,
    focalLengthPixels: 1_000,
  },
});
moonRoot.add(moonTerrain.group);

const placeholderRoots = new Map<SolarSystemBodyId, THREE.Group>();
for (const body of SOLAR_SYSTEM_BODIES) {
  if (body.id === "earth" || body.id === "moon") continue;
  const root = new THREE.Group();
  root.name = `${body.id}-root`;
  const geometry = new THREE.SphereGeometry(1, 48, 24);
  const material = new THREE.MeshStandardMaterial({
    color: body.placeholderColor,
    roughness: 0.88,
    emissive: body.id === "sun" ? body.placeholderColor : 0x000000,
    emissiveIntensity: body.id === "sun" ? 1 : 0,
  });
  root.add(new THREE.Mesh(geometry, material));
  placeholderRoots.set(body.id, root);
  scene.add(root);
}
scene.add(new THREE.AmbientLight(0x8793a8, 0.65));
scene.onBeforeRender = (_renderer, _scene, renderCamera): void => {
  terrain.updateRenderVisibility(renderCamera);
  moonTerrain.updateRenderVisibility(renderCamera);
};
const aircraftLayer = new AircraftLayer((latitudeDegrees, longitudeDegrees) =>
  terrain.sampleElevationMetres(latitudeDegrees, longitudeDegrees)
);
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
    setDisplayRadius(displayRadiusM);
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
const moonMapBitmap: BitmapHandle = {
  kind: "bitmap",
  image: moonBaseTexture.image,
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
const panelPointerOrigin = new THREE.Vector3();
const panelPointerQuaternion = new THREE.Quaternion();
const panelPointerDirection = new THREE.Vector3();
let panelPointerPressed = false;
const panelPointerSource = createXrRayPointerSource(() => {
  const binding = xrControllerBindings.find(
    (candidate) => candidate.inputSource?.handedness === "right",
  );
  if (!binding?.inputSource) {
    panelPointerPressed = false;
    return undefined;
  }
  binding.controller.getWorldPosition(panelPointerOrigin);
  binding.controller.getWorldQuaternion(panelPointerQuaternion);
  panelPointerDirection.set(0, 0, -1)
    .applyQuaternion(panelPointerQuaternion).normalize();
  const pressed = (binding.inputSource.gamepad?.buttons[0]?.value ?? 0) > 0.55;
  const phase: ThreePointerPhase = pressed && !panelPointerPressed
    ? "down"
    : !pressed && panelPointerPressed ? "up" : "move";
  panelPointerPressed = pressed;
  return {
    pointerId: "world-navigation-right-ray",
    pointerType: "ray" as const,
    phase,
    timestamp: performance.now(),
    sourceId: "right-controller",
    handedness: binding.inputSource.handedness,
    pressure: pressed ? 1 : 0,
    origin: panelPointerOrigin,
    direction: panelPointerDirection,
  };
});
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
  pointerClaimPolicy: "block-on-hit",
  pointerSources: [panelPointerSource],
  textureQuality: {
    anisotropy: Math.min(4, renderer.capabilities.getMaxAnisotropy()),
  },
});
const handPanel = createThreePanelSession({
  key: "pas-de-geant-earth-map",
  runtime: handPanelRuntime,
  driver: handPanelDriver,
  enabled: false,
  outputHandler(output: RuntimeOutput) {
    const action = handPanelNavigationAction(output);
    if (action === "cycle-mode") {
      const modes: NavigationMode[] = ["surface", "orbit", "free"];
      setNavigationMode(
        modes[(modes.indexOf(navigationMode) + 1) % modes.length]!,
      );
    } else if (action === "toggle-earth-moon") {
      setFocusBody(focusBodyId === "earth" ? "moon" : "earth");
    }
  },
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
const spaceTravel = new THREE.Vector3();
const unrotatedSpaceTravel = new THREE.Vector3();
const inverseWorldRotationQuaternion = new THREE.Quaternion();
const geographicTravel = new THREE.Vector2();
const keys = new Set<string>();
const buttonLatch = freshButtonLatch();
let orbitDominantAxis: DominantStickAxis = null;
const worldRotationQuaternion = new THREE.Quaternion();
const worldRotationPivot = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
const XR_TURN_RATE_DEGREES_PER_SECOND = 120;
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
let aircraftRetargetTimer: number | undefined;
let aircraftStreamState: FlightFollowerConnectionState = "stopped";
const aircraftStream = new FlightFollowerClient({
  onTracks(tracks) {
    aircraftLayer.setAircraft(tracks);
    aircraftCount = tracks.length;
    document.body.dataset.aircraftCount = String(aircraftCount);
  },
  onStatus(status) {
    aircraftStreamState = status.state;
    document.body.dataset.aircraftStreamState = status.state;
  },
});

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

function currentViewCamera(): THREE.Camera {
  // WebXRManager's ArrayCamera is not parented to observerRig. Asking it to
  // update its world matrix therefore drops the rig transform and makes orbit
  // altitude accumulate from the tracked-space pose instead of the rendered
  // head pose. The application camera retains that parent relationship and is
  // refreshed from the current XR view at the start of every frame.
  return camera;
}

function commitObserverTransform(transform: EclipseObserverTransform): void {
  const normalized = transform.quaternion.clone().normalize();
  observerRig.position.copy(transform.position);
  observerRig.quaternion.copy(normalized);
  observerRig.scale.set(1, 1, 1);
  observerRig.updateMatrixWorld(true);
  if (orbitNavigation) {
    orbitNavigation.observer = {
      position: transform.position.clone(),
      quaternion: normalized,
    };
  }
}

function resetObserverRig(): void {
  observerRig.position.set(0, 0, 0);
  observerRig.quaternion.identity();
  observerRig.scale.set(1, 1, 1);
  observerRig.updateMatrixWorld(true);
}

function syncHeadsetFloorPosition(): void {
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  const head = viewCamera.getWorldPosition(new THREE.Vector3());
  headsetFloorPosition.set(head.x, head.z);
}

function initializeOrbit(): void {
  freeNavigationFrame = undefined;
  resetObserverRig();
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  const headPosition = new THREE.Vector3();
  const headQuaternion = new THREE.Quaternion();
  viewCamera.getWorldPosition(headPosition);
  viewCamera.getWorldQuaternion(headQuaternion);
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(headQuaternion).normalize();
  const desiredRadial = forward.clone().negate();
  const focusWorldPosition = headPosition.clone().addScaledVector(
    forward,
    state.displayRadiusM * 3,
  );

  const when = new Date();
  const bodyAttitude = bodyFixedToRenderQuaternion(
    bodyRotation(focusBodyId, when),
  );
  const localRadial = focusBodyId === "earth" || focusBodyId === "moon"
    ? state.contact.upEcef.clone()
    : new THREE.Vector3(0, 0, 1);
  const localNorth = focusBodyId === "earth" || focusBodyId === "moon"
    ? state.contact.northEcef.clone()
    : new THREE.Vector3(0, 1, 0);
  const inertialRadial = localRadial.applyQuaternion(bodyAttitude).normalize();
  const alignRadial = new THREE.Quaternion().setFromUnitVectors(
    inertialRadial,
    desiredRadial,
  );
  const alignedNorth = localNorth.applyQuaternion(bodyAttitude)
    .applyQuaternion(alignRadial);
  alignedNorth.addScaledVector(
    desiredRadial,
    -alignedNorth.dot(desiredRadial),
  );
  const desiredUp = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(headQuaternion);
  desiredUp.addScaledVector(desiredRadial, -desiredUp.dot(desiredRadial));
  if (alignedNorth.lengthSq() > 1e-8 && desiredUp.lengthSq() > 1e-8) {
    alignedNorth.normalize();
    desiredUp.normalize();
    const twistRadians = Math.atan2(
      desiredRadial.dot(alignedNorth.clone().cross(desiredUp)),
      alignedNorth.dot(desiredUp),
    );
    alignRadial.premultiply(
      new THREE.Quaternion().setFromAxisAngle(desiredRadial, twistRadians),
    );
  }
  orbitNavigation = {
    observer: {
      position: observerRig.position.clone(),
      quaternion: observerRig.quaternion.clone(),
    },
    focusWorldPosition,
    systemFrameQuaternion: alignRadial.normalize(),
  };
  freeObserverJ2000M = undefined;
}

function resetPlanet(): void {
  warpTransition = undefined;
  scaleTransition = undefined;
  headingTransition = undefined;
  state = initialPlanetState(
    initialLocation.latitudeDegrees,
    initialLocation.longitudeDegrees,
  );
  if (navigationMode === "orbit" && focusBodyId === "earth") {
    state.displayRadiusM = EARTH_ORBIT_INITIAL_DISPLAY_RADIUS_M;
  }
  previousXrHead = null;
  freeObserverJ2000M = undefined;
  if (navigationMode === "free") {
    freeNavigationFrame = undefined;
    resetObserverRig();
    syncHeadsetFloorPosition();
  }
  if (navigationMode === "orbit") initializeOrbit();
  updatePresentation();
}

function setNavigationMode(mode: NavigationMode): void {
  warpTransition = undefined;
  scaleTransition = undefined;
  headingTransition = undefined;
  if (
    mode === "surface" &&
    celestialBody(focusBodyId).surface === null
  ) {
    mode = "orbit";
  }
  const orbitToFree = navigationMode === "orbit" && mode === "free" &&
    orbitNavigation
    ? freeStateFromOrbit(orbitNavigation)
    : undefined;
  navigationMode = mode;
  if (mode === "orbit") {
    if (focusBodyId === "earth") {
      state.displayRadiusM = EARTH_ORBIT_INITIAL_DISPLAY_RADIUS_M;
    }
    freeNavigationFrame = undefined;
    initializeOrbit();
  } else if (mode === "free" && orbitToFree) {
    freeObserverJ2000M = orbitToFree.observerJ2000M;
    freeNavigationFrame = orbitToFree.frame;
    orbitNavigation = undefined;
  } else {
    orbitNavigation = undefined;
    resetObserverRig();
    syncHeadsetFloorPosition();
    freeNavigationFrame = undefined;
    if (mode !== "free") freeObserverJ2000M = undefined;
  }
  previousXrHead = null;
  updatePresentation();
}

function freeStateFromOrbit(orbit: OrbitNavigationState): {
  observerJ2000M: Vector3d;
  frame: FreeNavigationFrame;
} {
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  const headWorld = viewCamera.getWorldPosition(new THREE.Vector3());
  const renderOffset = headWorld.clone().sub(orbit.focusWorldPosition)
    .applyQuaternion(orbit.systemFrameQuaternion.clone().invert());
  const focusPosition = bodyPositionJ2000M(focusBodyId, new Date());
  return {
    observerJ2000M: translatedObserverJ2000M(
      focusPosition,
      renderOffset,
      roomScaleForDisplayRadius(focusBodyId, state.displayRadiusM),
    ),
    frame: {
      anchorWorldPosition: headWorld,
      systemFrameQuaternion: orbit.systemFrameQuaternion.clone(),
    },
  };
}

function setFocusBody(bodyId: SolarSystemBodyId): void {
  warpTransition = undefined;
  scaleTransition = undefined;
  headingTransition = undefined;
  focusBodyId = bodyId;
  if (
    navigationMode === "surface" &&
    celestialBody(bodyId).surface === null
  ) navigationMode = "orbit";
  freeObserverJ2000M = undefined;
  if (navigationMode === "free") freeNavigationFrame = undefined;
  if (navigationMode === "orbit") initializeOrbit();
  previousXrHead = null;
  updatePresentation();
}

function setDisplayRadius(displayRadiusM: number): number {
  if (!Number.isFinite(displayRadiusM) || displayRadiusM <= 0) {
    throw new Error("Display radius must be positive and finite.");
  }
  scaleTransition = undefined;
  state.displayRadiusM = displayRadiusM;
  updatePresentation();
  return state.displayRadiusM;
}

function setRadialMultiplier(radialMultiplier: number): number {
  if (!Number.isFinite(radialMultiplier) || radialMultiplier < 0) {
    throw new Error("Radial multiplier must be nonnegative and finite.");
  }
  state.radialMultiplier = radialMultiplier;
  updatePresentation();
  return state.radialMultiplier;
}

function setUserLocation(
  latitudeDegrees: number,
  longitudeDegrees: number,
): { latitudeDegrees: number; longitudeDegrees: number } {
  warpTransition = undefined;
  state.contact = initialPlanetState(
    latitudeDegrees,
    longitudeDegrees,
  ).contact;
  if (navigationMode === "orbit") initializeOrbit();
  previousXrHead = null;
  updatePresentation();
  return coordinatesForFrame(state.contact);
}

function transitionDuration(time: number | undefined): number {
  if (time === undefined) return 0;
  if (!Number.isFinite(time) || time < 0) {
    throw new Error("Transition time must be a nonnegative finite number.");
  }
  return time;
}

function warpUserLocation(
  latitudeDegrees: number,
  longitudeDegrees: number,
  time?: number,
): { latitudeDegrees: number; longitudeDegrees: number } {
  const durationSeconds = transitionDuration(time);
  if (durationSeconds === 0) {
    return setUserLocation(latitudeDegrees, longitudeDegrees);
  }
  const target = { latitudeDegrees, longitudeDegrees };
  warpTransition = {
    from: coordinatesForFrame(state.contact),
    to: target,
    startedAtMs: performance.now(),
    durationSeconds,
  };
  previousXrHead = null;
  return target;
}

function transitionDisplayRadius(
  displayRadiusM: number,
  time?: number,
): number {
  if (!Number.isFinite(displayRadiusM) || displayRadiusM <= 0) {
    throw new Error("Display radius must be positive and finite.");
  }
  const durationSeconds = transitionDuration(time);
  if (durationSeconds === 0) return setDisplayRadius(displayRadiusM);
  scaleTransition = {
    from: state.displayRadiusM,
    to: displayRadiusM,
    startedAtMs: performance.now(),
    durationSeconds,
  };
  return displayRadiusM;
}

function updateNavigationTransitions(nowMs: number): void {
  if (warpTransition) {
    const sample = sampleWarpTransition(warpTransition, nowMs);
    state.contact = contactFrame(
      sample.value.latitudeDegrees,
      sample.value.longitudeDegrees,
    );
    previousXrHead = null;
    if (sample.complete) warpTransition = undefined;
  }
  if (scaleTransition) {
    const sample = sampleScaleTransition(scaleTransition, nowMs);
    state.displayRadiusM = sample.value;
    if (sample.complete) scaleTransition = undefined;
  }
  if (headingTransition) {
    const sample = sampleAngleTransition(headingTransition, nowMs);
    worldRotationRadians = sample.value;
    if (sample.complete) headingTransition = undefined;
  }
}

const viewDirectionQuaternion = new THREE.Quaternion();

function viewWorldHeadingDegrees(): number {
  const viewCamera = currentViewCamera();
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

function applyViewDirection(command: ViewDirectionCommand): number {
  headingTransition = undefined;
  worldRotationRadians = worldRotationForViewDirection(
    worldRotationRadians,
    viewWorldHeadingDegrees(),
    command,
  );
  updatePresentation();
  return geographicViewHeadingDegrees(
    viewWorldHeadingDegrees(),
    worldRotationRadians,
  );
}

function setHeading(headingDegrees: number): number {
  return applyViewDirection({ mode: "absolute", degrees: headingDegrees });
}

function transitionHeading(headingDegrees: number, time?: number): number {
  const durationSeconds = transitionDuration(time);
  if (durationSeconds === 0) return setHeading(headingDegrees);
  headingTransition = {
    from: worldRotationRadians,
    to: worldRotationForViewDirection(
      worldRotationRadians,
      viewWorldHeadingDegrees(),
      { mode: "absolute", degrees: headingDegrees },
    ),
    startedAtMs: performance.now(),
    durationSeconds,
  };
  return normalizeHeadingDegrees(headingDegrees);
}

function supervisionNavigationState(): SupervisionNavigationSnapshot {
  const coordinates = coordinatesForFrame(state.contact);
  let headingDegrees: number | null = null;
  try {
    headingDegrees = geographicViewHeadingDegrees(
      viewWorldHeadingDegrees(),
      worldRotationRadians,
    );
  } catch {
    // A vertical gaze has no stable horizontal projection.
  }
  return {
    mode: navigationMode,
    focusBody: focusBodyId,
    latitudeDegrees: coordinates.latitudeDegrees,
    longitudeDegrees: coordinates.longitudeDegrees,
    displayRadiusM: state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    headingDegrees,
  };
}

function supervisionControlState(): SupervisionControlState {
  return {
    aircraft: {
      aircraft: aircraftEnabled,
      labels: aircraftLabelsEnabled,
    },
    satellites: {
      brightest: satelliteGroups.visual.enabled,
      space_stations: satelliteGroups.stations.enabled,
      science_education: satelliteGroups["science-education"].enabled,
    },
    eclipse: {
      active: false,
      playing: false,
      eventId: null,
      eventKind: null,
      peakUtc: null,
      contactStartUtc: null,
      contactEndUtc: null,
      atUtc: null,
      playbackRate: null,
    },
  };
}

const canonicalNavigationMutations: CanonicalNavigationMutations = {
  warp: warpUserLocation,
  setDisplayRadius: transitionDisplayRadius,
  setRadialMultiplier,
  setHeading: transitionHeading,
  readState: supervisionNavigationState,
};

function requireEarthSurfacePinSession(): void {
  if (
    !renderer.xr.isPresenting ||
    navigationMode !== "surface" ||
    focusBodyId !== "earth"
  ) {
    throw new Error("Location pins require an immersive Earth surface session.");
  }
}

function setLocationPin(pin: LocationPin): LocationPinState {
  requireEarthSurfacePinSession();
  return locationPinStore.set(pin);
}

function removeLocationPin(pinId: string): LocationPinState {
  requireEarthSurfacePinSession();
  return locationPinStore.remove(pinId);
}

function setLocationPinGuidance(
  pinId: string,
  enabled: boolean,
): LocationPinState {
  requireEarthSurfacePinSession();
  return locationPinStore.setGuidance(pinId, enabled);
}

function setLocationPinVisibility(
  pinId: string,
  visible: boolean,
): LocationPinState {
  requireEarthSurfacePinSession();
  return locationPinStore.setVisibility(pinId, visible);
}

function renameLocationPin(pinId: string, label: string): LocationPinState {
  requireEarthSurfacePinSession();
  return locationPinStore.rename(pinId, label);
}

const canonicalLocationPinMutations: CanonicalLocationPinMutations = {
  setPin: setLocationPin,
  removePin: removeLocationPin,
  setPinVisibility: setLocationPinVisibility,
  renamePin: renameLocationPin,
  setPinGuidance: setLocationPinGuidance,
  readPinState: () => locationPinStore.snapshot(),
};

function applySupervisionCommand(command: SupervisionCommand): void {
  if (navigationMode !== "surface" || focusBodyId !== "earth") {
    throw new Error("Supervision controls currently require Earth surface mode.");
  }
  if (
    command.kind === "setPin" ||
    command.kind === "removePin" ||
    command.kind === "setPinGuidance"
  ) {
    applySupervisorLocationPinMutation(
      command,
      canonicalLocationPinMutations,
    );
  } else if (command.kind === "setAircraftDisplay") {
    setAircraftDisplay(command.target, command.enabled);
  } else if (command.kind === "setSatelliteGroupVisibility") {
    const { group, enabled } = parseSatelliteVisibilityArguments(command);
    void setSatelliteGroupEnabled(group, enabled);
  } else if (
    command.kind === "setEclipsePlayback" ||
    command.kind === "setEclipseTime"
  ) {
    throw new Error(
      "Eclipse controls require the Eclipse Observatory experience.",
    );
  } else {
    applySupervisorNavigationMutation(command, canonicalNavigationMutations);
  }
}

function locationPinVoiceState(): Record<string, unknown> {
  const coordinates = coordinatesForFrame(state.contact);
  const pinState = locationPinStore.catalogSnapshot();
  return {
    guided_pin_ids: pinState.guidedPinIds,
    pins: pinState.pins.map((pin) => ({
      pin_id: pin.pinId,
      label: pin.label,
      latitude_degrees: pin.latitudeDegrees,
      longitude_degrees: pin.longitudeDegrees,
      distance_kilometres: greatCircleDistanceKm(
        coordinates.latitudeDegrees,
        coordinates.longitudeDegrees,
        pin.latitudeDegrees,
        pin.longitudeDegrees,
      ),
      visible: pinState.visiblePinIds.includes(pin.pinId),
      guided: pinState.guidedPinIds.includes(pin.pinId),
    })),
  };
}

function pinIdFromVoiceArguments(argumentsValue: unknown): string {
  if (!argumentsValue || typeof argumentsValue !== "object") {
    throw new Error("Location pin arguments are required.");
  }
  const pinId = (argumentsValue as Record<string, unknown>).pin_id;
  if (typeof pinId !== "string" || !pinId.trim()) {
    throw new Error("Pin ID must be a non-empty string.");
  }
  return pinId.trim();
}

function voiceTransitionTime(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Transition time must be a nonnegative finite number.");
  }
  return value;
}

function pinGuidanceFromVoiceArguments(
  argumentsValue: unknown,
): { pinId: string; enabled: boolean } {
  const pinId = pinIdFromVoiceArguments(argumentsValue);
  const enabled = (argumentsValue as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("Pin guidance enabled must be boolean.");
  }
  return { pinId, enabled };
}

function pinVisibilityFromVoiceArguments(
  argumentsValue: unknown,
): { pinId: string; visible: boolean } {
  const pinId = pinIdFromVoiceArguments(argumentsValue);
  const visible = (argumentsValue as Record<string, unknown>).visible;
  if (typeof visible !== "boolean") {
    throw new Error("Pin visibility must be boolean.");
  }
  return { pinId, visible };
}

function pinRenameFromVoiceArguments(
  argumentsValue: unknown,
): { pinId: string; label: string } {
  const pinId = pinIdFromVoiceArguments(argumentsValue);
  const label = (argumentsValue as Record<string, unknown>).new_label;
  if (typeof label !== "string" || !label.trim()) {
    throw new Error("New pin label must be a non-empty string.");
  }
  return { pinId, label: label.trim() };
}

function setViewDirection(argumentsValue: unknown): Record<string, unknown> {
  const command = parseViewDirectionToolArguments(argumentsValue);
  const headingDegrees = applyViewDirection(command);
  return {
    ok: true,
    mode: command.mode,
    requested_degrees: command.degrees,
    heading_degrees: headingDegrees,
    reference: "clockwise from geographic north",
  };
}

function rotateViewDirection(degrees: number): void {
  headingTransition = undefined;
  if (navigationMode === "free" && freeNavigationFrame) {
    freeNavigationFrame.systemFrameQuaternion.premultiply(
      new THREE.Quaternion().setFromAxisAngle(
        worldUp,
        THREE.MathUtils.degToRad(degrees),
      ),
    );
    return;
  }
  worldRotationRadians = worldRotationForViewDirection(
    worldRotationRadians,
    0,
    { mode: "relative", degrees },
  );
}

function setTileOverlayVisible(visible: boolean): void {
  tileOverlayVisible = visible;
  document.body.dataset.detailTileOverlay = String(visible);
  terrain.setTileOverlayVisible(visible);
  moonTerrain.setTileOverlayVisible(visible);
}

function setTextureTileOverlayVisible(visible: boolean): void {
  textureTileOverlayVisible = visible;
  document.body.dataset.detailTextureTileOverlay = String(visible);
  terrain.setTextureTileOverlayVisible(visible);
  moonTerrain.setTextureTileOverlayVisible(visible);
}

function moveSpaceObserver(renderTravel: THREE.Vector3): void {
  if (navigationMode !== "free") return;
  const focus = celestialBody(focusBodyId);
  const focusPosition = bodyPositionJ2000M(focusBodyId, new Date());
  freeObserverJ2000M ??= systemObserverForFocus(
    focusPosition,
    focus.referenceRadiusM,
  );
  const roomScale = roomScaleForDisplayRadius(focusBodyId, state.displayRadiusM);
  inverseWorldRotationQuaternion.copy(
    freeNavigationFrame?.systemFrameQuaternion ?? worldRotationQuaternion,
  ).invert();
  unrotatedSpaceTravel.copy(renderTravel)
    .applyQuaternion(inverseWorldRotationQuaternion);
  freeObserverJ2000M = translatedObserverJ2000M(
    freeObserverJ2000M,
    unrotatedSpaceTravel,
    roomScale,
  );
}

function focusDistanceRoomM(): number {
  if (navigationMode === "orbit" && orbitNavigation) {
    const viewCamera = currentViewCamera();
    viewCamera.updateWorldMatrix(true, false);
    return viewCamera.getWorldPosition(new THREE.Vector3())
      .distanceTo(orbitNavigation.focusWorldPosition);
  }
  if (!freeObserverJ2000M) return state.displayRadiusM * 3;
  const focusPosition = bodyPositionJ2000M(focusBodyId, new Date());
  const roomScale = roomScaleForDisplayRadius(focusBodyId, state.displayRadiusM);
  return Math.hypot(
    freeObserverJ2000M.x - focusPosition.x,
    freeObserverJ2000M.y - focusPosition.y,
    freeObserverJ2000M.z - focusPosition.z,
  ) * roomScale;
}

const terrainEyeWorldPosition = new THREE.Vector3();
const terrainDrawingBufferSize = new THREE.Vector2();
const surfaceEast = new THREE.Vector3();
const surfaceUp = new THREE.Vector3();
const surfaceSouth = new THREE.Vector3();
const surfaceBasis = new THREE.Matrix4();
const surfaceQuaternion = new THREE.Quaternion();
const surfacePoint = new THREE.Vector3();
const systemBodyAttitudeQuaternion = new THREE.Quaternion();

function terrainViewMetrics(): {
  eyeHeightWorldM: number;
  focalLengthPixels: number;
} {
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  viewCamera.getWorldPosition(terrainEyeWorldPosition);
  // The local-floor reference space measures eye height from world y=0,
  // which is the un-displaced flat base surface used for terrain LOD.
  const eyeHeightWorldM = Math.max(0.001, terrainEyeWorldPosition.y);
  let focalLengthPixels = 1;
  if (renderer.xr.isPresenting) {
    const xrCamera = renderer.xr.getCamera();
    for (const eyeCamera of xrCamera.cameras) {
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

interface BodySurfaceView {
  latitudeDegrees: number;
  longitudeDegrees: number;
  observerHeightWorldM: number;
  displayRadiusM: number;
}

function bodySurfaceView(
  bodyId: "earth" | "moon",
  root: THREE.Object3D,
): BodySurfaceView {
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  root.updateWorldMatrix(true, false);
  const headLocal = viewCamera.getWorldPosition(new THREE.Vector3());
  root.worldToLocal(headLocal);
  const displayRadiusM = root.getWorldScale(new THREE.Vector3()).x;
  if (bodyId === "earth") {
    const observation = eclipseEarthSurfaceObservation(
      headLocal,
      displayRadiusM,
    );
    return {
      latitudeDegrees: observation.latitudeDegrees,
      longitudeDegrees: observation.longitudeDegrees,
      observerHeightWorldM: Math.max(0.001, observation.headDistanceWorldM),
      displayRadiusM,
    };
  }
  const distance = Math.max(Number.EPSILON, headLocal.length());
  return {
    latitudeDegrees: THREE.MathUtils.radToDeg(Math.asin(
      THREE.MathUtils.clamp(headLocal.y / distance, -1, 1),
    )),
    longitudeDegrees: THREE.MathUtils.radToDeg(
      Math.atan2(-headLocal.z, headLocal.x),
    ),
    observerHeightWorldM: Math.max(0.001, (distance - 1) * displayRadiusM),
    displayRadiusM,
  };
}

function enforceOrbitSurfaceFloor(): void {
  if (navigationMode !== "orbit" || !orbitNavigation) return;
  const root = focusBodyId === "earth"
    ? planetRoot
    : focusBodyId === "moon" ? moonRoot : placeholderRoots.get(focusBodyId);
  if (!root) return;
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  root.updateWorldMatrix(true, false);
  const headWorld = viewCamera.getWorldPosition(new THREE.Vector3());
  const centreWorld = root.getWorldPosition(new THREE.Vector3());
  const displayRadiusM = root.getWorldScale(new THREE.Vector3()).x;
  let normalizedFloorRadius = 1;
  if (focusBodyId === "earth") {
    const headLocal = root.worldToLocal(headWorld.clone());
    const observation = eclipseEarthSurfaceObservation(headLocal, displayRadiusM);
    normalizedFloorRadius = eclipseTopographicSurfaceRadius(
      observation,
      terrain.sampleElevationMetres(
        observation.latitudeDegrees,
        observation.longitudeDegrees,
      ) * state.radialMultiplier,
    );
  } else if (focusBodyId === "moon") {
    const surface = bodySurfaceView("moon", root);
    normalizedFloorRadius += moonTerrain.sampleElevationMetres(
      surface.latitudeDegrees,
      surface.longitudeDegrees,
    ) * state.radialMultiplier / celestialBody("moon").referenceRadiusM;
  }
  const floorDistance = normalizedFloorRadius * displayRadiusM;
  if (headWorld.distanceTo(centreWorld) >= floorDistance) return;
  commitObserverTransform(observerProjectedToEarthRadius(
    orbitNavigation.observer,
    headWorld,
    centreWorld,
    floorDistance,
  ));
}

function applySphericalSurfacePose(
  root: THREE.Object3D,
  latitudeDegrees: number,
  longitudeDegrees: number,
  displayRadiusM: number,
): void {
  const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
  const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
  surfaceUp.set(
    Math.cos(latitude) * Math.cos(longitude),
    Math.sin(latitude),
    -Math.cos(latitude) * Math.sin(longitude),
  );
  surfaceEast.set(-Math.sin(longitude), 0, -Math.cos(longitude));
  surfaceSouth.crossVectors(surfaceEast, surfaceUp).normalize();
  surfaceBasis.makeBasis(surfaceEast, surfaceUp, surfaceSouth).transpose();
  surfaceQuaternion.setFromRotationMatrix(surfaceBasis);
  root.quaternion.copy(surfaceQuaternion);
  surfacePoint.copy(surfaceUp).multiplyScalar(displayRadiusM)
    .applyQuaternion(surfaceQuaternion);
  root.position.set(headsetFloorPosition.x, 0, headsetFloorPosition.y)
    .sub(surfacePoint);
  root.scale.setScalar(displayRadiusM);
}

function systemObserverForFocus(
  focusPosition: Vector3d,
  focusRadiusM: number,
): Vector3d {
  return {
    x: focusPosition.x,
    y: focusPosition.y - focusRadiusM * 3,
    z: focusPosition.z,
  };
}

function updateSystemPresentation(): void {
  const when = new Date();
  const focusBody = celestialBody(focusBodyId);
  const focusPosition = bodyPositionJ2000M(focusBodyId, when);
  const roomScale = roomScaleForDisplayRadius(
    focusBodyId,
    state.displayRadiusM,
  );
  if (navigationMode === "orbit" && !orbitNavigation) initializeOrbit();
  if (navigationMode === "free" && !freeNavigationFrame) {
    const viewCamera = currentViewCamera();
    viewCamera.updateWorldMatrix(true, false);
    freeNavigationFrame = {
      anchorWorldPosition: viewCamera.getWorldPosition(new THREE.Vector3()),
      systemFrameQuaternion: worldRotationQuaternion.clone(),
    };
  }
  const observer = navigationMode === "free"
    ? (freeObserverJ2000M ??= systemObserverForFocus(
        focusPosition,
        focusBody.referenceRadiusM,
      ))
    : systemObserverForFocus(focusPosition, focusBody.referenceRadiusM);
  camera.far = Math.max(1_200, roomScale * 10_000_000_000_000);
  camera.updateProjectionMatrix();
  const place = (bodyId: SolarSystemBodyId, root: THREE.Object3D): void => {
    const body = celestialBody(bodyId);
    const bodyPosition = bodyPositionJ2000M(bodyId, when);
    const origin = navigationMode === "orbit" ? focusPosition : observer;
    const rendered = relativeJ2000MetresToRender({
      x: bodyPosition.x - origin.x,
      y: bodyPosition.y - origin.y,
      z: bodyPosition.z - origin.z,
    }, roomScale);
    const attitude = bodyFixedToRenderQuaternion(
      bodyRotation(bodyId, when),
      systemBodyAttitudeQuaternion,
    );
    if (navigationMode === "orbit" && orbitNavigation) {
      root.position.set(rendered.x, rendered.y, rendered.z)
        .applyQuaternion(orbitNavigation.systemFrameQuaternion)
        .add(orbitNavigation.focusWorldPosition);
      root.quaternion.copy(orbitNavigation.systemFrameQuaternion)
        .multiply(attitude);
    } else if (freeNavigationFrame) {
      root.position.set(rendered.x, rendered.y, rendered.z)
        .applyQuaternion(freeNavigationFrame.systemFrameQuaternion)
        .add(freeNavigationFrame.anchorWorldPosition);
      root.quaternion.copy(freeNavigationFrame.systemFrameQuaternion)
        .multiply(attitude);
    } else {
      root.position.set(rendered.x, rendered.y + 1.65, rendered.z);
      root.position.sub(worldRotationPivot)
        .applyQuaternion(worldRotationQuaternion)
        .add(worldRotationPivot);
      root.quaternion.copy(worldRotationQuaternion).multiply(attitude);
    }
    root.scale.setScalar(body.referenceRadiusM * roomScale);
    root.visible = true;
  };
  place("earth", planetRoot);
  place("moon", moonRoot);
  for (const [bodyId, root] of placeholderRoots) place(bodyId, root);
  document.body.dataset.roomScale = String(roomScale);
}

function updatePresentation(): void {
  let coordinates = coordinatesForFrame(state.contact);
  worldRotationQuaternion.setFromAxisAngle(worldUp, worldRotationRadians);
  worldRotationPivot.set(
    headsetFloorPosition.x,
    0,
    headsetFloorPosition.y,
  );
  document.body.dataset.navigationMode = navigationMode;
  document.body.dataset.focusBody = focusBodyId;
  if (navigationMode !== "surface") {
    updateSystemPresentation();
    enforceOrbitSurfaceFloor();
  } else {
    camera.far = 1_200;
    camera.updateProjectionMatrix();
    for (const root of placeholderRoots.values()) root.visible = false;
    if (focusBodyId === "moon") {
      planetRoot.visible = false;
      moonRoot.visible = true;
      applySphericalSurfacePose(
        moonRoot,
        coordinates.latitudeDegrees,
        coordinates.longitudeDegrees,
        state.displayRadiusM,
      );
    } else {
      planetRoot.visible = true;
      moonRoot.visible = false;
    }
  }
  const pose = solvePlanetPose(state, headsetFloorPosition);
  if (navigationMode === "surface" && focusBodyId === "earth") {
    planetRoot.quaternion
      .copy(pose.earthToWorld)
      .premultiply(worldRotationQuaternion);
    planetRoot.position
      .copy(pose.centre)
      .sub(worldRotationPivot)
      .applyQuaternion(worldRotationQuaternion)
      .add(worldRotationPivot);
    planetRoot.scale.setScalar(state.displayRadiusM);
  } else if (navigationMode === "surface" && focusBodyId === "moon") {
    moonRoot.quaternion.premultiply(worldRotationQuaternion);
    moonRoot.position
      .sub(worldRotationPivot)
      .applyQuaternion(worldRotationQuaternion)
      .add(worldRotationPivot);
  }
  const view = terrainViewMetrics();
  const earthOrbitalView = navigationMode === "orbit"
    ? bodySurfaceView("earth", planetRoot)
    : undefined;
  const moonOrbitalView = navigationMode === "orbit"
    ? bodySurfaceView("moon", moonRoot)
    : undefined;
  const focusedOrbitalView = focusBodyId === "earth"
    ? earthOrbitalView
    : focusBodyId === "moon" ? moonOrbitalView : undefined;
  if (focusedOrbitalView) {
    state.contact = contactFrame(
      focusedOrbitalView.latitudeDegrees,
      focusedOrbitalView.longitudeDegrees,
    );
    coordinates = {
      latitudeDegrees: focusedOrbitalView.latitudeDegrees,
      longitudeDegrees: focusedOrbitalView.longitudeDegrees,
    };
  }
  document.body.dataset.displayScale = state.displayRadiusM.toFixed(2);
  terrain.update({
    latitudeDegrees:
      earthOrbitalView?.latitudeDegrees ?? coordinates.latitudeDegrees,
    longitudeDegrees:
      earthOrbitalView?.longitudeDegrees ?? coordinates.longitudeDegrees,
    displayRadiusM: earthOrbitalView?.displayRadiusM ?? state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    observerHeightWorldM:
      earthOrbitalView?.observerHeightWorldM ?? view.eyeHeightWorldM,
    focalLengthPixels: view.focalLengthPixels,
  });
  moonTerrain.update({
    latitudeDegrees:
      moonOrbitalView?.latitudeDegrees ?? coordinates.latitudeDegrees,
    longitudeDegrees:
      moonOrbitalView?.longitudeDegrees ?? coordinates.longitudeDegrees,
    displayRadiusM: moonOrbitalView?.displayRadiusM ?? state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    observerHeightWorldM:
      moonOrbitalView?.observerHeightWorldM ?? view.eyeHeightWorldM,
    focalLengthPixels: view.focalLengthPixels,
    projection: "geographic",
  });
  atmosphere.update({
    displayRadiusM: earthOrbitalView?.displayRadiusM ?? state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    observerHeightWorldM:
      earthOrbitalView?.observerHeightWorldM ?? view.eyeHeightWorldM,
  });
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
    navigationMode,
    focusBody: celestialBody(focusBodyId).name,
    focusDistanceBodyRadii: navigationMode === "orbit"
      ? focusDistanceRoomM() / state.displayRadiusM
      : undefined,
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
    status.navigationMode,
    status.focusBody,
    status.focusDistanceBodyRadii?.toFixed(2),
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
      focusBodyId === "moon" ? moonMapBitmap : earthMapBitmap,
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
    get_navigation_state() {
      const orbitDistanceRoomM = navigationMode === "orbit"
        ? focusDistanceRoomM()
        : null;
      return {
        mode: navigationMode,
        focus_body: focusBodyId,
        display_radius_metres: state.displayRadiusM,
        radial_multiplier: state.radialMultiplier,
        focus_distance_metres: orbitDistanceRoomM,
        focus_distance_body_radii: orbitDistanceRoomM === null
          ? null
          : orbitDistanceRoomM / state.displayRadiusM,
      };
    },
    set_navigation(argumentsValue) {
      if (!argumentsValue || typeof argumentsValue !== "object") {
        throw new Error("Navigation arguments are required.");
      }
      const values = argumentsValue as Record<string, unknown>;
      if (values.focus_body !== undefined) {
        if (
          typeof values.focus_body !== "string" ||
          !isSolarSystemBodyId(values.focus_body)
        ) throw new Error("Unknown Solar System body.");
        setFocusBody(values.focus_body);
      }
      if (values.mode !== undefined) {
        if (
          values.mode !== "surface" &&
          values.mode !== "orbit" &&
          values.mode !== "free"
        ) throw new Error("Mode must be surface, orbit, or free.");
        setNavigationMode(values.mode);
      }
      const time = voiceTransitionTime(values.time);
      if (time !== undefined && values.display_radius_metres === undefined) {
        throw new Error(
          "Transition time requires a displayed radius in this tool.",
        );
      }
      if (typeof values.display_radius_metres === "number") {
        applyVoiceDisplayRadiusMutation(
          values.display_radius_metres,
          canonicalNavigationMutations,
          time,
        );
      }
      return {
        ok: true,
        mode: navigationMode,
        focus_body: focusBodyId,
        display_radius_metres: state.displayRadiusM,
        target_display_radius_metres:
          typeof values.display_radius_metres === "number"
            ? values.display_radius_metres
            : state.displayRadiusM,
        transition_time_seconds: time ?? 0,
      };
    },
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
        display_radius_metres: state.displayRadiusM,
        location_detail: AGENT_LOCATION_DETAIL,
        named_location_is_approximate: namedLocation !== undefined,
        named_location: namedLocation ?? null,
      };
    },
    set_user_location(argumentsValue) {
      const location = parseLocationToolArguments(argumentsValue);
      const resultingState = applyVoiceWarpMutation(
        location,
        canonicalNavigationMutations,
      );
      return {
        ok: true,
        latitude_degrees: resultingState.latitudeDegrees,
        longitude_degrees: resultingState.longitudeDegrees,
        target_latitude_degrees: location.latitudeDegrees,
        target_longitude_degrees: location.longitudeDegrees,
        transition_time_seconds: location.time ?? 0,
      };
    },
    async lookup_location(argumentsValue) {
      const { query } = parseLocationLookupArguments(argumentsValue);
      return await lookupLocations(query);
    },
    get_location_pins() {
      return locationPinVoiceState();
    },
    add_location_pin(argumentsValue) {
      if (!argumentsValue || typeof argumentsValue !== "object") {
        throw new Error("Location pin arguments are required.");
      }
      const values = argumentsValue as Record<string, unknown>;
      const pin = parseLocationPin({
        pinId: crypto.randomUUID(),
        label: values.label,
        latitudeDegrees: values.latitude_degrees,
        longitudeDegrees: values.longitude_degrees,
      });
      applyVoiceSetPinMutation(pin, canonicalLocationPinMutations);
      return { ok: true, pin_id: pin.pinId, ...locationPinVoiceState() };
    },
    remove_location_pin(argumentsValue) {
      applyVoiceRemovePinMutation(
        pinIdFromVoiceArguments(argumentsValue),
        canonicalLocationPinMutations,
      );
      return { ok: true, ...locationPinVoiceState() };
    },
    set_location_pin_visibility(argumentsValue) {
      const { pinId, visible } = pinVisibilityFromVoiceArguments(argumentsValue);
      applyVoiceSetPinVisibilityMutation(
        pinId,
        visible,
        canonicalLocationPinMutations,
      );
      return { ok: true, ...locationPinVoiceState() };
    },
    rename_location_pin(argumentsValue) {
      const { pinId, label } = pinRenameFromVoiceArguments(argumentsValue);
      applyVoiceRenamePinMutation(pinId, label, canonicalLocationPinMutations);
      return { ok: true, pin_id: pinId, ...locationPinVoiceState() };
    },
    set_location_pin_guidance(argumentsValue) {
      const { pinId, enabled } = pinGuidanceFromVoiceArguments(argumentsValue);
      applyVoiceSetPinGuidanceMutation(
        pinId,
        enabled,
        canonicalLocationPinMutations,
      );
      return { ok: true, ...locationPinVoiceState() };
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
      return setAircraftDisplay(display.target, display.enabled);
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
  controllerConnected: false,
  handedness: "none" as XRHandedness,
  inputSource: undefined as XRInputSource | undefined,
}));

for (const binding of xrControllerBindings) {
  binding.controller.addEventListener("connected", (event) => {
    const source = (event as THREE.Event & { data?: XRInputSource }).data;
    binding.controllerConnected =
      source !== undefined && !isHandTrackingInputSource(source);
    binding.handedness = binding.controllerConnected
      ? (source?.handedness ?? "none")
      : "none";
    binding.inputSource = binding.controllerConnected ? source : undefined;
  });
  binding.controller.addEventListener("disconnected", () => {
    binding.controllerConnected = false;
    binding.handedness = "none";
    binding.inputSource = undefined;
  });
  observerRig.add(binding.controller);
  observerRig.add(binding.grip);
}

function resolveHandPanelAnchorPose(): ThreeHostPose | undefined {
  const binding =
    xrControllerBindings.find(
      (candidate) =>
        candidate.controllerConnected && candidate.handedness === "left",
    ) ??
    xrControllerBindings.find(
      (candidate) =>
        candidate.controllerConnected && candidate.handedness === "none",
    ) ??
    xrControllerBindings.find((candidate) => candidate.controllerConnected);
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
    .applyQuaternion(
      focusBodyId === "moon" ? moonRoot.quaternion : planetRoot.quaternion,
    );
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
  currentViewCamera().getWorldPosition(xrHeadPosition);
  headsetFloorPosition.set(xrHeadPosition.x, xrHeadPosition.z);
  if (previousXrHead && navigationMode === "surface") {
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
  if (navigationMode !== "orbit" && intent.turnAxis !== 0) {
    rotateViewDirection(
      intent.turnAxis * XR_TURN_RATE_DEGREES_PER_SECOND * deltaSeconds,
    );
  }
  currentViewCamera().getWorldQuaternion(xrViewQuaternion);
  if (navigationMode === "orbit") {
    updateOrbitControls(
      intent.orbit.x,
      intent.orbit.y,
      intent.radialAxis,
      intent.scaleAxis,
      intent.boost,
      deltaSeconds,
    );
  }
  const travel = headRelativeTravel(intent.travel, xrViewQuaternion);
  if (travel.lengthSq() > 1) travel.normalize();
  if (navigationMode === "surface") {
    travel.multiplyScalar((intent.boost ? 4.2 : 1.35) * deltaSeconds);
  }
  if (navigationMode !== "orbit" && travel.lengthSq() > 0) {
    if (navigationMode === "surface") {
      state.contact = rollContactFrame(
        state.contact,
        geographicTravelFromWorld(
          travel,
          worldRotationRadians,
          geographicTravel,
        ),
        state.displayRadiusM,
      );
    } else {
      spaceTravel.set(intent.travel.x, 0, intent.travel.y)
        .applyQuaternion(xrViewQuaternion);
      if (spaceTravel.lengthSq() > 1) spaceTravel.normalize();
      spaceTravel.multiplyScalar(
        spaceTravelSpeedRoomMPerSecond(
          "free",
          state.displayRadiusM,
          focusDistanceRoomM(),
          intent.boost,
        ) * deltaSeconds,
      );
      moveSpaceObserver(spaceTravel);
    }
  }
  if (navigationMode !== "orbit") {
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
  }
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

function orbitSystemFrameByRadians(
  horizontalRadians: number,
  verticalRadians: number,
): void {
  if (!orbitNavigation) return;
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  const headPosition = new THREE.Vector3();
  const headQuaternion = new THREE.Quaternion();
  viewCamera.getWorldPosition(headPosition);
  viewCamera.getWorldQuaternion(headQuaternion);
  orbitNavigation.systemFrameQuaternion.copy(updateTargetLockedOrbitFrame(
    orbitNavigation.systemFrameQuaternion,
    headPosition,
    headQuaternion,
    orbitNavigation.focusWorldPosition,
    horizontalRadians,
    verticalRadians,
  ));
}

function updateOrbitControls(
  orbitX: number,
  orbitY: number,
  altitudeAxis: number,
  scaleAxis: number,
  boosted: boolean,
  deltaSeconds: number,
): void {
  if (!orbitNavigation) return;
  orbitSystemFrameByRadians(
    orbitalAngularStepRadians(orbitX, deltaSeconds, boosted),
    orbitalAngularStepRadians(orbitY, deltaSeconds, boosted),
  );
  const dominant = dominantStickAxes(
    altitudeAxis,
    scaleAxis,
    orbitDominantAxis,
  );
  orbitDominantAxis = dominant.latched;
  if (dominant.horizontal !== 0) {
    const viewCamera = currentViewCamera();
    viewCamera.updateWorldMatrix(true, false);
    const headPosition = viewCamera.getWorldPosition(new THREE.Vector3());
    const desiredDistance = orbitalLogarithmicValue(
      headPosition.distanceTo(orbitNavigation.focusWorldPosition),
      dominant.horizontal,
      deltaSeconds,
      boosted,
    );
    commitObserverTransform(observerProjectedToEarthRadius(
      orbitNavigation.observer,
      headPosition,
      orbitNavigation.focusWorldPosition,
      desiredDistance,
    ));
  }
  if (dominant.vertical !== 0) {
    state.displayRadiusM = orbitalLogarithmicValue(
      state.displayRadiusM,
      dominant.vertical,
      deltaSeconds,
      boosted,
    );
  }
}

function updateDesktopControls(deltaSeconds: number): void {
  const sideways =
    Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
  const forward =
    Number(keys.has("KeyW")) - Number(keys.has("KeyS"));
  desktopTravel.set(sideways, -forward);
  if (desktopTravel.lengthSq() > 1) desktopTravel.normalize();
  if (navigationMode === "orbit") {
    const boosted = keys.has("ShiftLeft") || keys.has("ShiftRight");
    updateOrbitControls(
      sideways,
      forward,
      Number(keys.has("KeyV")) - Number(keys.has("KeyC")),
      Number(keys.has("KeyX")) - Number(keys.has("KeyZ")),
      boosted,
      deltaSeconds,
    );
    return;
  }
  if (desktopTravel.lengthSq() > 0) {
    const boosted = keys.has("ShiftLeft") || keys.has("ShiftRight");
    const travel = headRelativeTravel(desktopTravel, camera.quaternion);
    if (navigationMode === "surface") {
      travel.multiplyScalar((boosted ? 4.2 : 1.35) * deltaSeconds);
      state.contact = rollContactFrame(
        state.contact,
        geographicTravelFromWorld(
          travel,
          worldRotationRadians,
          geographicTravel,
        ),
        state.displayRadiusM,
      );
    } else {
      spaceTravel.set(desktopTravel.x, 0, desktopTravel.y)
        .applyQuaternion(camera.quaternion);
      if (spaceTravel.lengthSq() > 1) spaceTravel.normalize();
      spaceTravel.multiplyScalar(
        spaceTravelSpeedRoomMPerSecond(
          "free",
          state.displayRadiusM,
          focusDistanceRoomM(),
          boosted,
        ) * deltaSeconds,
      );
      moveSpaceObserver(spaceTravel);
    }
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
  if (navigationMode === "orbit") {
    orbitSystemFrameByRadians(
      -(event.clientX - pointerX) * 0.002,
      (event.clientY - pointerY) * 0.002,
    );
    pointerX = event.clientX;
    pointerY = event.clientY;
    return;
  }
  yaw -= (event.clientX - pointerX) * 0.0035;
  pitch -= (event.clientY - pointerY) * 0.0035;
  pitch = Math.max(-1.35, Math.min(1.1, pitch));
  camera.rotation.set(pitch, yaw, 0);
  pointerX = event.clientX;
  pointerY = event.clientY;
});
renderer.domElement.addEventListener("wheel", (event) => {
  if (renderer.xr.isPresenting || navigationMode !== "orbit") return;
  event.preventDefault();
  updateOrbitControls(
    0,
    0,
    Math.max(-1, Math.min(1, event.deltaY * 0.01)),
    0,
    false,
    0.05,
  );
}, { passive: false });
renderer.domElement.addEventListener("pointerup", (event) => {
  pointerActive = false;
  if (renderer.domElement.hasPointerCapture(event.pointerId)) {
    renderer.domElement.releasePointerCapture(event.pointerId);
  }
});

window.addEventListener("keydown", (event) => {
  if (event.repeat && event.code === "Backspace") return;
  if (event.code === "Backspace") resetPlanet();
  if (!event.repeat && event.code === "KeyM") {
    const modes: NavigationMode[] = ["surface", "orbit", "free"];
    setNavigationMode(modes[(modes.indexOf(navigationMode) + 1) % modes.length]!);
  }
  if (!event.repeat && event.code === "KeyN") {
    setFocusBody(focusBodyId === "earth" ? "moon" : "earth");
  }
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
      "KeyM",
      "KeyN",
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

function aircraftStreamAllowed(): boolean {
  return shouldStreamAircraft({
    enabled: aircraftEnabled || aircraftLabelsEnabled,
    vrSessionActive,
    documentVisible: !document.hidden,
  });
}

function stopAircraftStream(): void {
  if (aircraftRetargetTimer !== undefined) {
    window.clearTimeout(aircraftRetargetTimer);
    aircraftRetargetTimer = undefined;
  }
  aircraftStream.stop();
}

function scheduleAircraftRetarget(): void {
  if (!aircraftStreamAllowed()) return;
  if (aircraftRetargetTimer !== undefined) {
    window.clearTimeout(aircraftRetargetTimer);
  }
  aircraftRetargetTimer = window.setTimeout(() => {
    aircraftRetargetTimer = undefined;
    const coordinates = coordinatesForFrame(state.contact);
    aircraftStream.setCenter(coordinates);
    scheduleAircraftRetarget();
  }, AIRCRAFT_SUBSCRIPTION_REFRESH_INTERVAL_MS);
}

function aircraftDisplayState(): Record<string, unknown> {
  return {
    aircraft_enabled: aircraftEnabled,
    labels_enabled: aircraftLabelsEnabled,
    vr_session_active: vrSessionActive,
    aircraft_count: aircraftCount,
    stream_state: aircraftStreamState,
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
  if (aircraftStreamAllowed()) {
    aircraftStream.start(coordinatesForFrame(state.contact));
    scheduleAircraftRetarget();
  } else {
    stopAircraftStream();
  }
}

function setAircraftEnabled(enabled: boolean): void {
  aircraftEnabled = enabled;
  syncAircraftDisplay();
}

function setAircraftLabelsEnabled(enabled: boolean): void {
  aircraftLabelsEnabled = enabled;
  syncAircraftDisplay();
}

function setAircraftDisplay(
  target: AircraftDisplayTarget,
  enabled: boolean,
): Record<string, unknown> {
  if (target === "aircraft") setAircraftEnabled(enabled);
  else setAircraftLabelsEnabled(enabled);
  return { ok: true, ...aircraftDisplayState() };
}

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
  const count = enabled.reduce(
    (total, { id }) => total + satelliteGroups[id].count,
    0,
  );
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
  satelliteLayer.setGroupVisible(group, enabled && vrSessionActive);
  if (!enabled) {
    stopSatelliteGroup(group);
    updateSatelliteReadout();
    return satelliteGroupControlState(group);
  }
  updateSatelliteReadout();
  return await loadSatelliteGroup(group);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAircraftStream();
    for (const { id } of SATELLITE_GROUPS) stopSatelliteGroup(id);
  } else {
    syncAircraftDisplay();
    for (const { id } of SATELLITE_GROUPS) void loadSatelliteGroup(id);
  }
});

let supervisionClient: SupervisionClient | undefined;
let supervisionClientModule: Promise<typeof import("./supervision-client.js")> |
  undefined;
let supervisionSessionGeneration = 0;
const supervisionSessionLabel = benchmarkParameters.get("sessionLabel")?.trim() ||
  undefined;

function setSupervisionStatus(status: SupervisionConnectionStatus): void {
  document.body.dataset.supervisionStatus = status;
}

async function startSupervisionSession(): Promise<void> {
  if (!import.meta.env.DEV) return;
  const generation = ++supervisionSessionGeneration;
  try {
    supervisionClientModule ??= import("./supervision-client.js");
    const { SupervisionClient: Client } = await supervisionClientModule;
    if (generation !== supervisionSessionGeneration || !renderer.xr.isPresenting) {
      return;
    }
    supervisionClient ??= new Client({
      readState: supervisionNavigationState,
      readControlState: supervisionControlState,
      readPinState: () => locationPinStore.snapshot(),
      applyCommand: applySupervisionCommand,
      onStatus: setSupervisionStatus,
    });
    supervisionClient.start(supervisionSessionLabel);
  } catch (error) {
    document.body.dataset.supervisionStatus = "unavailable";
    console.debug(
      "Development supervision is unavailable; continuing without it.",
      error,
    );
  }
}

function stopSupervisionSession(): void {
  supervisionSessionGeneration += 1;
  supervisionClient?.stop();
}

const vrButton = VRButton.createButton(renderer);
vrSlot.append(vrButton);
renderer.xr.addEventListener("sessionstart", () => {
  document.body.classList.add("xr-presenting");
  locationPinStore.clear();
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
  if (navigationMode === "orbit") orbitNavigation = undefined;
  previousXrHead = null;
  renderer.xr.setFoveation(1);
  const frameRate = renderer.xr.getSession()?.frameRate;
  if (frameRate !== undefined && frameRate > 0) {
    lastKnownXrFrameRate = frameRate;
  }
  void startSupervisionSession();
});
renderer.xr.addEventListener("sessionend", () => {
  document.body.classList.remove("xr-presenting");
  stopSupervisionSession();
  locationPinStore.clear();
  vrSessionActive = false;
  voiceAgent.disable();
  handPanel.enabled = false;
  stopAircraftStream();
  aircraftLayer.visible = false;
  for (const { id } of SATELLITE_GROUPS) {
    stopSatelliteGroup(id);
    satelliteLayer.setGroupVisible(id, false);
  }
  updateSatelliteReadout();
  camera.position.set(0, 1.65, 0);
  camera.rotation.set(pitch, yaw, 0);
  if (navigationMode === "orbit") orbitNavigation = undefined;
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
  readonly terrainRenderCullingEnabled: boolean;
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
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  const debugObserverPosition = viewCamera.getWorldPosition(new THREE.Vector3());
  const orbitDistanceM = orbitNavigation
    ? debugObserverPosition.distanceTo(orbitNavigation.focusWorldPosition)
    : null;
  return {
    location: coordinates,
    navigation: {
      mode: navigationMode,
      focusBody: focusBodyId,
      focusDistanceRoomM: orbitDistanceM,
      focusDistanceBodyRadii: orbitDistanceM === null
        ? null
        : orbitDistanceM / state.displayRadiusM,
      observerRig: {
        position: observerRig.position.toArray(),
        quaternion: observerRig.quaternion.toArray(),
        scale: observerRig.scale.toArray(),
      },
      focusWorldPosition: orbitNavigation?.focusWorldPosition.toArray() ?? null,
    },
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
    terrainRenderCullingEnabled: terrain.renderCullingEnabled,
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
    terrainRenderCullingEnabled: terrain.renderCullingEnabled,
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
    currentViewCamera().getWorldPosition(debugHeadWorldPosition);
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
      tiles: "setTilePixelRatio(target, ratio), setMaxZ(target, z|null), setTileRecalculation(target, enabled)",
      rendering: "setRendering(enabled), setInputEnabled(enabled), setFoveation(0..1), setFramebufferScale(value), setDesktopPixelRatio(value)",
      terrainRenderCulling: "setTerrainRenderCulling(enabled) — same-build render-only visibility A/B",
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
    terrain.clearRenderVisibilityMetrics();
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
    headingTransition = undefined;
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
    setTileOverlayVisible(false);
    setTextureTileOverlayVisible(false);
    terrain.setRenderCullingEnabled(true);
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
    terrain.clearRenderVisibilityMetrics();
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
    headingTransition = undefined;
    camera.rotation.set(pitch, yaw, 0);
    applyTileControlReadback(restore.tileControls);
    setTileOverlayVisible(restore.tileOverlayVisible);
    setTextureTileOverlayVisible(restore.textureTileOverlayVisible);
    renderingEnabled = restore.renderingEnabled;
    terrain.setRenderCullingEnabled(restore.terrainRenderCullingEnabled);
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
    terrain.clearRenderVisibilityMetrics();
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
    setDisplayRadius(value);
    return debugControlState();
  },
  setRadialMultiplier(multiplier) {
    const value = finiteDebugNumber(multiplier, "multiplier");
    setRadialMultiplier(value);
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
  setTerrainRenderCulling(enabled) {
    terrain.setRenderCullingEnabled(enabled);
    frameTelemetry.clear();
    terrain.clearRenderVisibilityMetrics();
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
const earthWorldScale = new THREE.Vector3();
function render(nowMs: number): void {
  const applicationStartMs = performance.now();
  const xrFrameRate = renderer.xr.getSession()?.frameRate;
  if (xrFrameRate !== undefined && xrFrameRate > 0) {
    lastKnownXrFrameRate = xrFrameRate;
  }
  if (renderer.xr.isPresenting) renderer.xr.updateCamera(camera);
  const utcMilliseconds = Date.now();
  const intervalMs = nowMs - previousFrameMs;
  const deltaSeconds = Math.min(0.05, intervalMs / 1000);
  previousFrameMs = nowMs;
  updateNavigationTransitions(nowMs);
  if (simulationInputEnabled) {
    if (renderer.xr.isPresenting) {
      updatePhysicalWalking();
      updateXrControls(deltaSeconds, nowMs);
    } else {
      updateDesktopControls(deltaSeconds);
    }
  }
  updatePresentation();
  const pinCoordinates = coordinatesForFrame(state.contact);
  locationPinLayer.update({
    pinState: locationPinStore.snapshot(),
    camera: currentViewCamera(),
    earthRoot: planetRoot,
    userLatitudeDegrees: pinCoordinates.latitudeDegrees,
    userLongitudeDegrees: pinCoordinates.longitudeDegrees,
    displayRadiusM: state.displayRadiusM,
    radialMultiplier: state.radialMultiplier,
    visible: renderer.xr.isPresenting &&
      navigationMode === "surface" && focusBodyId === "earth",
  });
  supervisionClient?.update(nowMs);
  const earthDisplayRadiusM = navigationMode === "surface"
    ? state.displayRadiusM
    : planetRoot.getWorldScale(earthWorldScale).x;
  aircraftLayer.update(
    utcMilliseconds,
    earthDisplayRadiusM,
    state.radialMultiplier,
  );
  satelliteLayer.update(
    utcMilliseconds,
    earthDisplayRadiusM,
    state.radialMultiplier,
  );
  const viewCamera = currentViewCamera();
  viewCamera.getWorldPosition(cameraWorldPosition);
  if (navigationMode === "orbit") {
    celestialObserverAppEcefKm.copy(cameraWorldPosition);
    planetRoot.worldToLocal(celestialObserverAppEcefKm);
    celestialObserverAppEcefKm.multiplyScalar(EARTH_MEAN_RADIUS_KM);
  } else {
    const observerCoordinates = coordinatesForFrame(state.contact);
    geodeticSurfaceEcefKm(
      observerCoordinates.latitudeDegrees,
      observerCoordinates.longitudeDegrees,
      celestialObserverAppEcefKm,
    ).addScaledVector(
      state.contact.upEcef,
      cameraWorldPosition.y / 1_000,
    );
  }
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
  stopSupervisionSession();
  if (benchmarkMetricsTimer !== undefined) {
    window.clearInterval(benchmarkMetricsTimer);
  }
  stopAircraftStream();
  for (const { id } of SATELLITE_GROUPS) stopSatelliteGroup(id);
  terrain.dispose();
  locationPinLayer.dispose();
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
setPreflightCheck(worldCheck, worldCheckStatus, "ready", "World ready");
errorState.hidden = true;
aircraftLayer.visible = false;
setAircraftEnabled(false);
setAircraftLabelsEnabled(false);
for (const { id } of SATELLITE_GROUPS) {
  satelliteLayer.setGroupVisible(id, false);
}
updateSatelliteReadout();
renderer.setAnimationLoop(render);
