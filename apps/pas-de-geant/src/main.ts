import {
  createRuntime,
  type BitmapHandle,
  type RuntimeOutput,
} from "@found-in-space/touch-os";
import {
  createPoseAnchoredPanelDriver,
  createThreePanelSession,
  createXrRayPointerSource,
  type PointerPresenter,
  type ThreeHostPose,
  type ThreePointerPhase,
} from "@found-in-space/touch-os/hosts/three";
import type { EclipseSummary } from "@found-in-space/shadowline";
import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import {
  AIRCRAFT_SUBSCRIPTION_REFRESH_INTERVAL_MS,
  FlightFollowerClient,
  type FlightFollowerConnectionState,
} from "./aircraft-feed.js";
import { AircraftLayer } from "./aircraft-layer.js";
import {
  parseAmazonForestOutlineVisibilityArguments,
  type AmazonForestOutlineControlState,
} from "./amazon-forest-outline-control.js";
import { AmazonForestOutlineLayer } from "./amazon-forest-outline-layer.js";
import { AmazonForestOutlineStore } from "./amazon-forest-outline-state.js";
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
import { bodyFixedToRenderQuaternion } from "@found-in-space/worlds/body-attitude";
import {
  appEcefToRenderJ2000Quaternion,
  CelestialSphere,
  equatorialJ2000ToAppEcefQuaternion,
} from "./celestial-sphere.js";
import {
  EARTH_TO_GAIA_JOURNEY_ID,
  JourneyRunner,
  PARSEC_METRES,
  renderedBodyOpacity,
  STELLAR_METRES_PER_PARSEC,
  sampleEarthToGaiaTimeline,
  type EarthToGaiaTimelineContext,
  type EarthToGaiaTimelineSample,
  type JourneyVector3,
} from "./earth-to-gaia-journey.js";
import {
  observerProjectedToBodyRadius,
  observerTranslatedForHeadPosition,
  updateTargetLockedOrbitFrame,
  type EclipseObserverTransform,
} from "./eclipse-observer.js";
import {
  eclipseEarthSurfaceObservation,
  eclipseTopographicSurfaceRadius,
} from "./eclipse-earth-surface.js";
import { RetainedShadowCones } from "./eclipse-rendering.js";
import { eclipseYearFromEventId } from "./eclipse-tools.js";
import { EclipseWorkerClient } from "./eclipse-worker-client.js";
import type { EclipseContactRange } from "./eclipse-types.js";
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
} from "@found-in-space/worlds/imagery-provider";
import {
  imageryConfiguration,
} from "./imagery-configuration.js";
import {
  MAPTILER_IMAGERY_VARIANT_PARAMETER,
} from "./imagery-variants.js";
import { earthElevationMaximumZoom, elevationSourceOptions } from "./elevation-configuration.js";
import { loadSessionConfiguration } from "./session-config.js";
import { monitorTileSourceFailures } from "./tile-source-status.js";
import {
  applyTerrainMultiplierRate,
  contactFrame,
  coordinatesForFrame,
  EARTH_MEAN_RADIUS_KM,
  geodeticSurfaceEcefKm,
  initialPlanetState,
  rollContactFrame,
  solveBodySurfacePose,
  type ContactFrame,
  type PlanetState,
} from "@found-in-space/worlds/planet-state";
import { resolveInitialWorldLocation } from "./initial-location.js";
import { worldLaunchFromQuery } from "./world-launch.js";
import { observeBodySurface, type BodySurfaceView } from "./body-surface-view.js";
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
import { createGeantVoiceAgent, type RealtimeAgentStatus } from './voice-agent.js';
import { parseLocationToolArguments } from './voice-location-tools.js';
import {
  applySupervisorLocationPinMutation,
  applySupervisorNavigationMutation,
  applyVoiceScaleDenominatorMutation,
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
import { createWorldRuntime, type WorldRuntime } from "@found-in-space/worlds";
import type { TerrainSurface } from "@found-in-space/worlds/terrain-surface";
import { lunarSurfaceSource } from "./lunar-configuration.js";
import { earthBaseTextureUrl } from "./world-assets.js";
import { EARTH_SURFACE_MODEL } from "@found-in-space/worlds/surface-model";
import { ElevationTileProvider } from "@found-in-space/worlds/elevation-tile-provider";
import { createElevationTileProvider } from "@found-in-space/worlds/image-tile-provider";
import {
  SOLAR_SYSTEM_BODIES,
  bodyPositionJ2000M,
  bodyRotation,
  celestialBody,
  isSolarSystemBodyId,
  type SolarSystemBodyId,
  type Vector3d,
} from "@found-in-space/worlds/solar-system";
import {
  calculateSolarShadowGeometry,
  solarShadowConeLengthM,
} from "./solar-shadow-geometry.js";
import {
  displayRadiusForScale,
  orbitalAngularStepRadians,
  orbitalDragRadiansPerPixel,
  orbitalLogarithmicValue,
  relativeJ2000MetresToRender,
  spaceTravelSpeedHeadsetMPerSecond,
  translatedObserverJ2000M,
  type NavigationMode,
} from "@found-in-space/worlds/world-navigation";
import {
  DEFAULT_SCALE_DENOMINATOR,
  headsetScaleFactorForDenominatorChange,
  headsetMetresForPhysicalMetres,
  physicalMetresForHeadsetMetres,
  scaleDenominatorAfterInput,
  validScaleDenominator,
} from "@found-in-space/worlds/world-scale";
import {
  parseTileMaxZoomArguments,
  parseTilePixelRatioArguments,
  parseTileRecalculationArguments,
  type TileDebugControlsReadback,
  type TileDebugTarget,
} from "@found-in-space/worlds/tile-debug-controls";
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
import { SpatialStarPass } from "./spatial-star-pass.js";
import {
  j2000ObserverAtWorldPoint,
  j2000ToWorldQuaternion,
  trackingRoomOffsetWorld,
} from "@found-in-space/worlds/stellar-coordinate-frame";
import {
  anchoredSimulationClock,
  realtimeSimulationClock,
  simulationClockSnapshot,
  simulationTimeMs,
  type SimulationClockState,
} from "./simulation-clock.js";
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

interface WorldEclipseSelection {
  readonly event: EclipseSummary;
  readonly contacts: EclipseContactRange;
}

interface WorldExperienceState extends PlanetState {
  simulationClock: SimulationClockState;
  eclipse: WorldEclipseSelection | null;
}

interface PasDeGeantDebugApi {
  help(): Record<string, string>;
  snapshot(): Record<string, unknown>;
  mark(name?: string): Record<string, unknown>;
  marks(): Record<string, Record<string, unknown>>;
  clearMetrics(): void;
  beginBenchmark(options?: {
    latitudeDegrees?: number;
    longitudeDegrees?: number;
    scaleDenominator?: number;
    terrainMultiplier?: number;
  }): Record<string, unknown>;
  endBenchmark(): Record<string, unknown>;
  reset(): Record<string, unknown>;
  setLocation(latitudeDegrees: number, longitudeDegrees: number): unknown;
  setScaleDenominator(scaleDenominator: number): Record<string, unknown>;
  setTerrainMultiplier(multiplier: number): Record<string, unknown>;
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
    __PAS_DE_GEANT_TEST_SET_SCALE_DENOMINATOR__?: (
      scaleDenominator: number,
    ) => void;
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

const sessionConfiguration = await loadSessionConfiguration();
const sceneRoot = element<HTMLDivElement>("scene-root");
const benchmarkParameters = new URLSearchParams(window.location.search);
const worldLaunch = worldLaunchFromQuery(benchmarkParameters);
const initialFocusBodyId = worldLaunch.body;
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
const terrainCredit = element<HTMLElement>("terrain-credit");
const imageryCredit = element<HTMLElement>("imagery-credit");
const earthTerrainCredit = terrainCredit.innerHTML;
const earthImageryCredit = imageryCredit.innerHTML;
const researchRegion = element<HTMLElement>("research-region");
const researchAnswer = element<HTMLParagraphElement>("research-answer");
const researchSources = element<HTMLUListElement>("research-sources");
const initialLocationPromise = worldLaunch.location ? Promise.resolve(worldLaunch.location) : resolveInitialWorldLocation(initialFocusBodyId);
if (initialFocusBodyId === "moon") {
  document.title = "Walk on the Moon — Pas de Géant";
  element<HTMLElement>("preflight-title").textContent = "Walk on the Moon";
  worldCheck.querySelector("strong")!.textContent = "Lunar surface";
  locationCheckStatus.textContent = "Choosing lunar starting point";
  if (worldLaunch.label) {
    document.title = `${worldLaunch.label} — Pas de Géant`;
    element<HTMLElement>("preflight-title").textContent = `${worldLaunch.label} · 1:${worldLaunch.scaleDenominator}`;
  }
}

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
renderer.autoClear = false;
renderer.setClearColor(0x01040a, 1);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
let xrFramebufferScaleFactor = 1;
renderer.xr.setFramebufferScaleFactor(xrFramebufferScaleFactor);
sceneRoot.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = null;
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
const planetRoot = new THREE.Group();
scene.add(planetRoot);

// CelestialSphere now retains only finite-body ephemeris and visibility state;
// SpatialStarPass owns the one catalogue-star render path.
const celestialSphere = new CelestialSphere();
celestialSphere.setVisibility("moon", false);
celestialSphere.setVisibility("planets", false);
scene.add(celestialSphere.object3d);
const textureLoader = new THREE.TextureLoader();
const worldRuntimes: WorldRuntime[] = [];
const lunarSurfacePromise = lunarSurfaceSource(renderer, sessionConfiguration, { preview: worldLaunch.lunarPreview });
void lunarSurfacePromise.then(
  (source) => {
    const texture = source.baseTexture.clone();
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = true;
    celestialSphere.setMoonTexture(texture);
  },
  (error) => console.warn("LRO Moon texture is unavailable:", error),
);
const blueMarbleTexture = await textureLoader.loadAsync(earthBaseTextureUrl);
blueMarbleTexture.colorSpace = THREE.SRGBColorSpace;
blueMarbleTexture.flipY = false;
blueMarbleTexture.wrapS = THREE.RepeatWrapping;
blueMarbleTexture.wrapT = THREE.ClampToEdgeWrapping;
blueMarbleTexture.needsUpdate = true;
blueMarbleTexture.anisotropy = Math.min(
  4,
  renderer.capabilities.getMaxAnisotropy(),
);
const journeyEarthGlobeMaterial = new THREE.MeshBasicMaterial({
  map: blueMarbleTexture,
  transparent: true,
  opacity: 1,
});
const journeyEarthGlobe = new THREE.Mesh(
  new THREE.SphereGeometry(1, 96, 64),
  journeyEarthGlobeMaterial,
);
journeyEarthGlobe.name = "earth-to-gaia-whole-earth";
journeyEarthGlobe.visible = false;
scene.add(journeyEarthGlobe);

const selectedImageryConfiguration = imageryConfiguration(
  sessionConfiguration, benchmarkParameters.get(MAPTILER_IMAGERY_VARIANT_PARAMETER),
);
const photographicImageryProvider =
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
setPreflightCheck(
  locationCheck,
  locationCheckStatus,
  "ready",
  formatCoordinates(
    initialLocation.latitudeDegrees,
    initialLocation.longitudeDegrees,
  ),
);
let state: WorldExperienceState = {
  ...initialPlanetState(
    initialLocation.latitudeDegrees,
    initialLocation.longitudeDegrees,
  ),
  simulationClock: realtimeSimulationClock(),
  eclipse: null,
};
const spatialStarPass = new SpatialStarPass();
document.body.dataset.starStatus = "loading";
document.body.dataset.starCount = "0";
const initialBodyJ2000M = bodyPositionJ2000M(
  initialFocusBodyId,
  new Date(simulationTimeMs(state.simulationClock)),
);
void spatialStarPass.load(vectorMetresToParsecs(initialBodyJ2000M)).then(
  () => {
    const snapshot = spatialStarPass.getSnapshot();
    document.body.dataset.starStatus = snapshot.status;
    document.body.dataset.starCount = String(snapshot.starCount);
  },
  (error: unknown) => {
    document.body.dataset.starStatus = "failed";
    console.warn("SkyKit spatial star catalog is unavailable:", error);
  },
);
let warpTransition: TimedTransition<NavigationCoordinates> | undefined;
let scaleTransition: TimedTransition<number> | undefined;
let headingTransition: TimedTransition<number> | undefined;
let navigationMode: NavigationMode = "surface";
let focusBodyId: SolarSystemBodyId = initialFocusBodyId;
const launchScaleDenominator = worldLaunch.scaleDenominator ?? DEFAULT_SCALE_DENOMINATOR;
let scaleDenominator = launchScaleDenominator;
let freeObserverJ2000M: Vector3d | undefined;
let navigationRealm: "solar_system" | "stellar" = "solar_system";
let activeJourneySample: EarthToGaiaTimelineSample | null = null;
let journeyTrackingAnchorWorld = new THREE.Vector3();
let journeyTrackingOriginLocal = new THREE.Vector3();
const journeyRoomOffsetWorld = new THREE.Vector3();
const observerRigWorldQuaternion = new THREE.Quaternion();
let journeyJ2000ToWorld = new THREE.Quaternion();
interface OrbitNavigationState {
  observer: EclipseObserverTransform;
  /** Authoritative J2000 observer position in physical metres. */
  observerSystemPositionM: Vector3d;
  focusWorldPosition: THREE.Vector3;
  systemFrameQuaternion: THREE.Quaternion;
}
let orbitNavigation: OrbitNavigationState | undefined;
interface FreeNavigationFrame {
  anchorWorldPosition: THREE.Vector3;
  systemFrameQuaternion: THREE.Quaternion;
}
let freeNavigationFrame: FreeNavigationFrame | undefined;
const benchmarkScaleDenominator = Number(
  benchmarkParameters.get("benchmarkScaleDenominator"),
);
if (worldLaunch.scaleDenominator === undefined && Number.isFinite(benchmarkScaleDenominator) && benchmarkScaleDenominator > 0) {
  scaleDenominator = benchmarkScaleDenominator;
}

function focusedDisplayRadiusM(): number {
  return displayRadiusForScale(focusBodyId, scaleDenominator);
}

function vectorMetresToParsecs(value: Vector3d): JourneyVector3 {
  return {
    x: value.x / PARSEC_METRES,
    y: value.y / PARSEC_METRES,
    z: value.z / PARSEC_METRES,
  };
}

function vectorParsecsToMetres(value: JourneyVector3): Vector3d {
  return {
    x: value.x * PARSEC_METRES,
    y: value.y * PARSEC_METRES,
    z: value.z * PARSEC_METRES,
  };
}

function authoredStellarObserverJ2000M(): Vector3d {
  if (navigationMode === "free" && freeObserverJ2000M) {
    return freeObserverJ2000M;
  }
  if (navigationMode === "orbit" && orbitNavigation) {
    return orbitNavigation.observerSystemPositionM;
  }
  return bodyPositionJ2000M(focusBodyId, presentationDate());
}
const earthWorld = createWorldRuntime({
  body: celestialBody("earth"),
  root: planetRoot,
  renderer,
  surface: {
    baseTexture: blueMarbleTexture,
    imageryProvider: photographicImageryProvider,
    surfaceModel: EARTH_SURFACE_MODEL,
    elevationProvider: new ElevationTileProvider(createElevationTileProvider(
      EARTH_SURFACE_MODEL.elevationMetadata,
      earthElevationMaximumZoom(sessionConfiguration, EARTH_SURFACE_MODEL.elevationMetadata.maxSourceZoom),
      elevationSourceOptions(sessionConfiguration),
    )),
  },
  initialView: {
    latitudeDegrees: initialLocation.latitudeDegrees,
    longitudeDegrees: initialLocation.longitudeDegrees,
    displayRadiusM: displayRadiusForScale("earth", scaleDenominator),
    terrainMultiplier: state.terrainMultiplier,
    observerHeightWorldM: 1.65,
    focalLengthPixels: 1_000,
  },
});
const terrain = earthWorld.surface;
worldRuntimes.push(earthWorld);
const amazonForestOutlines = new AmazonForestOutlineLayer(
  import.meta.env.VITE_AMAZON_FOREST_MANIFEST_URL?.trim() ||
    "https://data.foundin.space/3592e66d-2b29-4e4b-97d0-7fc1d3e9e4f8/manifest.json",
  terrain,
);
const amazonForestOutlineStore = new AmazonForestOutlineStore(
  amazonForestOutlines,
);

function amazonForestOutlineControlState(): AmazonForestOutlineControlState {
  return amazonForestOutlineStore.snapshot();
}

function amazonForestOutlineVoiceState(): Record<string, unknown> {
  const controlState = amazonForestOutlineControlState();
  return {
    available_years: controlState.availableYears,
    visible_years: controlState.visibleYears,
  };
}

amazonForestOutlineStore.subscribe(({ visibleYears }) => {
  document.body.dataset.amazonForestOutline = visibleYears.join(",") || "off";
});
void amazonForestOutlineStore.load().catch((error) => {
  document.body.dataset.amazonForestOutline = "unavailable";
  console.warn("Amazon forest outline manifest is unavailable:", error);
});

function setAmazonForestYearVisibility(
  year: number,
  visible: boolean,
): Promise<AmazonForestOutlineControlState> {
  return amazonForestOutlineStore.setYearVisibility(year, visible);
}
const locationPinStore = new LocationPinStore();
const locationPinLayer = new LocationPinLayer((latitudeDegrees, longitudeDegrees) =>
  terrain.sampleElevationMetres(latitudeDegrees, longitudeDegrees)
);
planetRoot.add(locationPinLayer.worldGroup);
scene.add(locationPinLayer.hudGroup);
const moonSource = await lunarSurfacePromise;
const moonBaseTexture = moonSource.baseTexture;
const moonWorld = createWorldRuntime({
  body: celestialBody("moon"),
  renderer,
  surface: moonSource,
  initialView: {
    latitudeDegrees: initialLocation.latitudeDegrees,
    longitudeDegrees: initialLocation.longitudeDegrees,
    displayRadiusM: displayRadiusForScale("moon", scaleDenominator),
    terrainMultiplier: state.terrainMultiplier,
    observerHeightWorldM: 1.65,
    focalLengthPixels: 1_000,
  },
});
const moonRoot = moonWorld.object3d;
const moonTerrain = moonWorld.surface;
worldRuntimes.push(moonWorld);
scene.add(moonRoot);

function focusedTerrain(): TerrainSurface {
  return focusBodyId === "moon" ? moonTerrain : terrain;
}

let creditedBodyId: SolarSystemBodyId | undefined;
function updateWorldCredits(): void {
  if (creditedBodyId === focusBodyId) return;
  creditedBodyId = focusBodyId;
  const provider = focusBodyId === "moon" ? moonSource.imageryProvider : photographicImageryProvider;
  document.body.dataset.imageryProvider = provider?.id ??
    (focusBodyId === "moon" ? "lroc-color-2k" : "blue-marble");
  document.body.dataset.imageryTileSize = String(provider?.tileSize ?? 0);
  if (focusBodyId === "moon") {
    terrainCredit.textContent = sessionConfiguration.bindings.moonElevation
      ? "Terrain: NASA LRO / LOLA"
      : "Terrain: lunar reference sphere · no elevation data";
    imageryCredit.textContent = `Imagery: ${provider?.attribution ?? "NASA LRO / LROC"}`;
  } else {
    terrainCredit.innerHTML = earthTerrainCredit;
    imageryCredit.innerHTML = earthImageryCredit;
    if (photographicImageryProvider) {
      element<HTMLElement>("imagery-attribution").textContent = ` + ${photographicImageryProvider.attribution}`;
    }
  }
}

const placeholderRoots = new Map<SolarSystemBodyId, THREE.Group>();
for (const body of SOLAR_SYSTEM_BODIES) {
  if (body.id === "earth" || body.id === "moon") continue;
  const world = createWorldRuntime({
    body,
    renderer,
    initialView: {
      latitudeDegrees: 0, longitudeDegrees: 0,
      displayRadiusM: displayRadiusForScale(body.id, scaleDenominator),
      terrainMultiplier: 1, observerHeightWorldM: 1.65, focalLengthPixels: 1_000,
    },
  });
  worldRuntimes.push(world);
  placeholderRoots.set(body.id, world.object3d);
  scene.add(world.object3d);
}
const shadowCones = new RetainedShadowCones();
shadowCones.group.visible = false;
scene.add(shadowCones.group);
scene.add(new THREE.AmbientLight(0x8793a8, 0.65));
scene.onBeforeRender = (_renderer, _scene, renderCamera): void => {
  for (const world of worldRuntimes) world.beforeRender(renderCamera);
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
let eclipseConesVisible = false;
let lastShadowConeUpdateSecond = Number.NEGATIVE_INFINITY;
let realtimeAgentStatus: RealtimeAgentStatus = {
  state: "off",
  detail: "Press A to wake",
};
document.body.dataset.agentStatus = realtimeAgentStatus.state;
if (window.__PAS_DE_GEANT_ENABLE_TEST_HOOKS__) {
  window.__PAS_DE_GEANT_TEST_SET_SCALE_DENOMINATOR__ = (
    denominator,
  ): void => {
    setScaleDenominator(denominator);
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
    focusedTerrain().getMetrics();
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
    focusBodyId === "moon" ? moonMapBitmap : earthMapBitmap,
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
const panelPointerEnd = new THREE.Vector3();
let panelPointerPressed = false;
const panelPointerRayGeometry = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(),
  new THREE.Vector3(0, 0, -1),
]);
const panelPointerRayMaterial = new THREE.LineBasicMaterial({
  color: 0x76ddf1,
  transparent: true,
  opacity: 0.82,
  depthTest: false,
  depthWrite: false,
});
const panelPointerRay = new THREE.Line(
  panelPointerRayGeometry,
  panelPointerRayMaterial,
);
panelPointerRay.frustumCulled = false;
panelPointerRay.renderOrder = 101;
panelPointerRay.visible = false;
scene.add(panelPointerRay);
const panelPointerReticle = new THREE.Mesh(
  new THREE.RingGeometry(0.006, 0.011, 24),
  new THREE.MeshBasicMaterial({
    color: 0xb7f5ff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
);
panelPointerReticle.renderOrder = 102;
panelPointerReticle.visible = false;
scene.add(panelPointerReticle);

function hidePanelPointerVisual(): void {
  panelPointerRay.visible = false;
  panelPointerReticle.visible = false;
}

const panelPointerPresenter: PointerPresenter = {
  update(state) {
    if (!state.active && !state.hit) {
      hidePanelPointerVisual();
      return;
    }
    const rayLength = state.hit?.length ?? 1.5;
    panelPointerEnd.copy(panelPointerOrigin).addScaledVector(
      panelPointerDirection,
      rayLength,
    );
    const positions = panelPointerRayGeometry.getAttribute("position");
    positions.setXYZ(
      0,
      panelPointerOrigin.x,
      panelPointerOrigin.y,
      panelPointerOrigin.z,
    );
    positions.setXYZ(
      1,
      panelPointerEnd.x,
      panelPointerEnd.y,
      panelPointerEnd.z,
    );
    positions.needsUpdate = true;
    panelPointerRayGeometry.computeBoundingSphere();
    panelPointerRayMaterial.color.set(
      panelPointerPressed ? 0xf7d36f : state.hit ? 0x8cf7d0 : 0x76ddf1,
    );
    panelPointerRay.visible = true;
    panelPointerReticle.visible = state.hit !== null;
    if (state.hit) {
      panelPointerReticle.position.copy(panelPointerEnd);
      panelPointerReticle.quaternion.copy(panelPointerQuaternion);
      (panelPointerReticle.material as THREE.MeshBasicMaterial).color.set(
        panelPointerPressed ? 0xf7d36f : 0xb7f5ff,
      );
    }
  },
  dispose() {
    scene.remove(panelPointerRay, panelPointerReticle);
    panelPointerRayGeometry.dispose();
    panelPointerRayMaterial.dispose();
    panelPointerReticle.geometry.dispose();
    (panelPointerReticle.material as THREE.Material).dispose();
  },
};

const panelPointerSource = createXrRayPointerSource(() => {
  const binding = xrControllerBindings.find(
    (candidate) => candidate.inputSource?.handedness === "right",
  );
  if (!binding?.inputSource) {
    panelPointerPressed = false;
    hidePanelPointerVisual();
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
  panelWidth: 0.24,
  panelHeight: 0.3,
  tiltRadians: HAND_PANEL_TILT_RADIANS,
  offset: { x: 0.04, y: 0.08, z: -0.03 },
  depthTest: false,
  depthWrite: false,
  renderOrder: 100,
  pointerClaimPolicy: "block-on-hit",
  pointerSources: [panelPointerSource],
  pointerPresenter: panelPointerPresenter,
  ownsPointerPresenter: true,
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
    if (journeyRunner.isLocked()) return;
    const action = handPanelNavigationAction(output);
    if (action === "cycle-mode") {
      const modes: NavigationMode[] = ["surface", "orbit", "free"];
      setNavigationMode(
        modes[(modes.indexOf(navigationMode) + 1) % modes.length]!,
      );
    } else if (action === "toggle-earth-moon") {
      setFocusBody(focusBodyId === "earth" ? "moon" : "earth");
    } else if (action === "toggle-eclipse-cones") {
      setEclipseConesVisible(!eclipseConesVisible);
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

function orbitObserverSystemPosition(
  orbit: OrbitNavigationState,
  denominator = scaleDenominator,
): Vector3d {
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  const headWorld = viewCamera.getWorldPosition(new THREE.Vector3());
  const renderOffset = headWorld.clone().sub(orbit.focusWorldPosition)
    .applyQuaternion(orbit.systemFrameQuaternion.clone().invert());
  return translatedObserverJ2000M(
    bodyPositionJ2000M(focusBodyId, presentationDate()),
    renderOffset,
    denominator,
  );
}

function syncOrbitObserverSystemPosition(): void {
  if (!orbitNavigation) return;
  orbitNavigation.observerSystemPositionM = orbitObserverSystemPosition(
    orbitNavigation,
  );
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
    syncOrbitObserverSystemPosition();
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

function presentationDate(): Date {
  return new Date(simulationTimeMs(state.simulationClock));
}

function initializeOrbit(when = presentationDate()): void {
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
    focusedDisplayRadiusM() * 3,
  );

  const bodyAttitude = bodyAttitudeJ2000(focusBodyId, when);
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
    observerSystemPositionM: { x: 0, y: 0, z: 0 },
    focusWorldPosition,
    systemFrameQuaternion: alignRadial.normalize(),
  };
  syncOrbitObserverSystemPosition();
  freeObserverJ2000M = undefined;
}

function resetPlanet(): void {
  warpTransition = undefined;
  scaleTransition = undefined;
  headingTransition = undefined;
  state = {
    ...initialPlanetState(
      initialLocation.latitudeDegrees,
      initialLocation.longitudeDegrees,
    ),
    simulationClock: state.simulationClock,
    eclipse: state.eclipse,
  };
  scaleDenominator = launchScaleDenominator;
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
  return {
    observerJ2000M: { ...orbit.observerSystemPositionM },
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

function commitScaleDenominator(nextScaleDenominator: number): number {
  nextScaleDenominator = validScaleDenominator(nextScaleDenominator);
  if (navigationMode === "orbit" && orbitNavigation) {
    const previousScaleDenominator = scaleDenominator;
    const viewCamera = currentViewCamera();
    viewCamera.updateWorldMatrix(true, false);
    const headPosition = viewCamera.getWorldPosition(new THREE.Vector3());
    const desiredHeadPosition = headPosition.clone()
      .sub(orbitNavigation.focusWorldPosition)
      .multiplyScalar(headsetScaleFactorForDenominatorChange(
        previousScaleDenominator,
        nextScaleDenominator,
      ))
      .add(orbitNavigation.focusWorldPosition);
    scaleDenominator = nextScaleDenominator;
    commitObserverTransform(observerTranslatedForHeadPosition(
      orbitNavigation.observer,
      headPosition,
      desiredHeadPosition,
    ));
  } else scaleDenominator = nextScaleDenominator;
  return scaleDenominator;
}

function setScaleDenominator(nextScaleDenominator: number): number {
  scaleTransition = undefined;
  commitScaleDenominator(nextScaleDenominator);
  updatePresentation();
  return scaleDenominator;
}

function setTerrainMultiplier(terrainMultiplier: number): number {
  if (!Number.isFinite(terrainMultiplier) || terrainMultiplier < 0) {
    throw new Error("Terrain multiplier must be nonnegative and finite.");
  }
  state.terrainMultiplier = terrainMultiplier;
  updatePresentation();
  return state.terrainMultiplier;
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

function transitionScaleDenominator(
  nextScaleDenominator: number,
  time?: number,
): number {
  validScaleDenominator(nextScaleDenominator);
  const durationSeconds = transitionDuration(time);
  if (durationSeconds === 0) return setScaleDenominator(nextScaleDenominator);
  scaleTransition = {
    from: scaleDenominator,
    to: nextScaleDenominator,
    startedAtMs: performance.now(),
    durationSeconds,
  };
  return nextScaleDenominator;
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
    commitScaleDenominator(sample.value);
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
  const observerJ2000Pc = activeJourneySample
    ? activeJourneySample.catalogObserverJ2000Pc
    : vectorMetresToParsecs(authoredStellarObserverJ2000M());
  const stellar = navigationRealm === "stellar" || activeJourneySample !== null
    ? {
        observerJ2000Pc,
        metresPerParsec: STELLAR_METRES_PER_PARSEC,
        roomTranslationBlend: activeJourneySample?.roomTranslationBlend ??
          (navigationRealm === "stellar" ? 1 : 0),
      }
    : null;
  return {
    realm: navigationRealm,
    mode: navigationMode,
    focusBody: focusBodyId,
    latitudeDegrees: coordinates.latitudeDegrees,
    longitudeDegrees: coordinates.longitudeDegrees,
    scaleDenominator,
    terrainMultiplier: state.terrainMultiplier,
    headingDegrees,
    stellar,
  };
}

function supervisionControlState(): SupervisionControlState {
  const nowMs = Date.now();
  const clock = simulationClockSnapshot(state.simulationClock, nowMs);
  const eclipse = state.eclipse;
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
    amazonForestOutlines: amazonForestOutlineControlState(),
    clock: {
      atUtc: new Date(clock.atMs).toISOString(),
      anchorWallUtc: new Date(clock.anchorWallTimeMs).toISOString(),
      offsetMs: clock.offsetMs,
      scale: clock.scale,
    },
    eclipse: {
      experience: "world",
      simulationActive: eclipse !== null,
      conesVisible: eclipseConesVisible,
      eventId: eclipse?.event.id ?? null,
      eventKind: eclipse?.event.kind ?? null,
      peakUtc: eclipse?.event.peakUtc ?? null,
      contactStartUtc: eclipse?.contacts.startUtc ?? null,
      contactEndUtc: eclipse?.contacts.endUtc ?? null,
    },
    journey: journeyRunner.getState(),
  };
}

const canonicalNavigationMutations: CanonicalNavigationMutations = {
  warp: warpUserLocation,
  setScaleDenominator: transitionScaleDenominator,
  setTerrainMultiplier,
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

interface EarthToGaiaSnapshot {
  readonly capturedAtMs: number;
  readonly contact: ContactFrame;
  readonly terrainMultiplier: number;
  readonly scaleDenominator: number;
  readonly worldRotationRadians: number;
  readonly simulationClock: SimulationClockState;
  readonly eclipse: WorldEclipseSelection | null;
  readonly eclipseConesVisible: boolean;
  readonly simulationInputEnabled: boolean;
  readonly frozenTimeMs: number;
  readonly gazeWorld: THREE.Vector3;
  readonly headWorld: THREE.Vector3;
  readonly earthCenterWorld: THREE.Vector3;
  readonly systemFrameQuaternion: THREE.Quaternion;
  readonly j2000ToWorld: THREE.Quaternion;
  readonly trackingOriginLocal: THREE.Vector3;
  readonly tileLoadingSuspended: {
    readonly earth: boolean;
    readonly moon: boolean;
  };
  readonly transitions: {
    readonly warp: TimedTransition<NavigationCoordinates> | undefined;
    readonly scale: TimedTransition<number> | undefined;
    readonly heading: TimedTransition<number> | undefined;
  };
  readonly layerVisibility: {
    readonly planet: boolean;
    readonly moon: boolean;
    readonly placeholders: ReadonlyMap<SolarSystemBodyId, boolean>;
    readonly shadowCones: boolean;
    readonly celestialBodies: boolean;
    readonly stars: boolean;
  };
}

interface EarthToGaiaPreparation {
  readonly context: EarthToGaiaTimelineContext;
  readonly headWorld: THREE.Vector3;
  readonly startObserverJ2000M: Vector3d;
  readonly systemFrameQuaternion: THREE.Quaternion;
  readonly j2000ToWorld: THREE.Quaternion;
  readonly trackingOriginLocal: THREE.Vector3;
}

interface JourneyMaterialState {
  readonly opacity: number;
  readonly transparent: boolean;
  readonly depthWrite: boolean;
}

const journeyMaterialStates = new Map<THREE.Material, JourneyMaterialState>();
const JOURNEY_EARTH_GLOBE_HANDOFF_RADIUS_M = 2;

function cloneContactFrame(frame: ContactFrame): ContactFrame {
  return {
    upEcef: frame.upEcef.clone(),
    eastEcef: frame.eastEcef.clone(),
    northEcef: frame.northEcef.clone(),
  };
}

function captureEarthToGaiaSnapshot(): EarthToGaiaSnapshot {
  if (navigationMode !== "surface" || focusBodyId !== "earth") {
    throw new Error("Start the Earth-to-Gaia journey from the Earth surface.");
  }
  updatePresentation(presentationDate());
  const frame = lastSystemPresentationFrame;
  if (!frame) throw new Error("The Solar System frame is not ready.");
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  const headWorld = viewCamera.getWorldPosition(new THREE.Vector3());
  const gazeWorld = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(viewCamera.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();
  const j2000ToWorld = j2000ToWorldQuaternion(
    frame.systemFrameQuaternion,
  );
  return {
    capturedAtMs: performance.now(),
    contact: cloneContactFrame(state.contact),
    terrainMultiplier: state.terrainMultiplier,
    scaleDenominator,
    worldRotationRadians,
    simulationClock: { ...state.simulationClock },
    eclipse: state.eclipse,
    eclipseConesVisible,
    simulationInputEnabled,
    frozenTimeMs: simulationTimeMs(state.simulationClock),
    gazeWorld,
    headWorld,
    earthCenterWorld: planetRoot.getWorldPosition(new THREE.Vector3()),
    systemFrameQuaternion: frame.systemFrameQuaternion.clone(),
    j2000ToWorld,
    trackingOriginLocal: viewCamera.position.clone(),
    tileLoadingSuspended: {
      earth: terrain.isLoadingSuspended,
      moon: moonTerrain.isLoadingSuspended,
    },
    transitions: {
      warp: warpTransition ? { ...warpTransition } : undefined,
      scale: scaleTransition ? { ...scaleTransition } : undefined,
      heading: headingTransition ? { ...headingTransition } : undefined,
    },
    layerVisibility: {
      planet: planetRoot.visible,
      moon: moonRoot.visible,
      placeholders: new Map(
        [...placeholderRoots].map(([bodyId, root]) => [bodyId, root.visible]),
      ),
      shadowCones: shadowCones.group.visible,
      celestialBodies: celestialSphere.object3d.visible,
      stars: spatialStarPass.scene.visible,
    },
  };
}

async function prepareEarthToGaiaJourney(
  snapshot: EarthToGaiaSnapshot,
  signal: AbortSignal,
): Promise<EarthToGaiaPreparation> {
  // Preflight is visually stationary even when the journey was requested
  // during an authored transition. Restoration resumes it from this instant.
  terrain.setLoadingSuspended(true);
  moonTerrain.setLoadingSuspended(true);
  warpTransition = undefined;
  scaleTransition = undefined;
  headingTransition = undefined;
  const when = new Date(snapshot.frozenTimeMs);
  const earthCenterJ2000M = bodyPositionJ2000M("earth", when);
  const startObserverM = j2000ObserverAtWorldPoint(
    earthCenterJ2000M,
    snapshot.earthCenterWorld,
    snapshot.headWorld,
    snapshot.systemFrameQuaternion,
    snapshot.scaleDenominator,
  );
  const startObserverPc = vectorMetresToParsecs(startObserverM);
  const inverseFrame = snapshot.j2000ToWorld.clone().invert();
  const gazeJ2000 = snapshot.gazeWorld.clone()
    .applyQuaternion(inverseFrame)
    .normalize();
  const destinationDirectionJ2000 = gazeJ2000.multiplyScalar(-1);
  const sunPositionM = bodyPositionJ2000M("sun", when);
  const solarOverviewScaleDenominator = Math.max(
    ...SOLAR_SYSTEM_BODIES.map((body) => {
      const position = bodyPositionJ2000M(body.id, when);
      return Math.hypot(
        position.x - sunPositionM.x,
        position.y - sunPositionM.y,
        position.z - sunPositionM.z,
      ) + body.referenceRadiusM;
    }),
  ) / 4;
  const context: EarthToGaiaTimelineContext = {
    startScaleDenominator: snapshot.scaleDenominator,
    startObserverJ2000Pc: startObserverPc,
    earthCenterJ2000Pc: vectorMetresToParsecs(earthCenterJ2000M),
    solarOverviewScaleDenominator,
    catalogObserverJ2000Pc: startObserverPc,
    destinationDirectionJ2000,
  };
  await spatialStarPass.load(startObserverPc, signal);
  return {
    context,
    headWorld: snapshot.headWorld.clone(),
    startObserverJ2000M: { ...startObserverM },
    systemFrameQuaternion: snapshot.systemFrameQuaternion.clone(),
    j2000ToWorld: snapshot.j2000ToWorld.clone(),
    trackingOriginLocal: snapshot.trackingOriginLocal.clone(),
  };
}

function beginEarthToGaiaJourney(
  snapshot: EarthToGaiaSnapshot,
  preparation: EarthToGaiaPreparation,
): void {
  warpTransition = undefined;
  scaleTransition = undefined;
  headingTransition = undefined;
  state.simulationClock = anchoredSimulationClock(snapshot.frozenTimeMs, 0);
  journeyTrackingOriginLocal.copy(preparation.trackingOriginLocal);
  journeyJ2000ToWorld.copy(preparation.j2000ToWorld);
  spatialStarPass.scene.visible = true;
  journeyEarthGlobe.visible = false;
  navigationRealm = "solar_system";
  activeJourneySample = null;
  navigationMode = "free";
  focusBodyId = "earth";
  orbitNavigation = undefined;
  freeObserverJ2000M = { ...preparation.startObserverJ2000M };
  freeNavigationFrame = {
    anchorWorldPosition: preparation.headWorld.clone(),
    systemFrameQuaternion: preparation.systemFrameQuaternion.clone(),
  };
  previousXrHead = null;
}

function updateJourneyUniversalFrame(
  sample: EarthToGaiaTimelineSample,
  preparation: EarthToGaiaPreparation,
): void {
  if (!freeNavigationFrame) return;
  freeObserverJ2000M = vectorParsecsToMetres(sample.observerJ2000Pc);
  freeNavigationFrame.systemFrameQuaternion.copy(
    preparation.systemFrameQuaternion,
  );
  freeNavigationFrame.anchorWorldPosition.copy(preparation.headWorld);
}

function applyEarthToGaiaSample(
  sample: EarthToGaiaTimelineSample,
  _snapshot: EarthToGaiaSnapshot,
  preparation: EarthToGaiaPreparation,
): void {
  activeJourneySample = sample;
  navigationRealm = sample.realm;
  commitScaleDenominator(sample.scaleDenominator);
  updateJourneyUniversalFrame(sample, preparation);
  document.body.dataset.journeyPhase = sample.phase;
  document.body.dataset.journeyProgress = String(sample.progress);
}

function restoreJourneyMaterials(): void {
  for (const [material, original] of journeyMaterialStates) {
    material.opacity = original.opacity;
    material.transparent = original.transparent;
    material.depthWrite = original.depthWrite;
    material.needsUpdate = true;
  }
  journeyMaterialStates.clear();
}

function setObjectOpacity(root: THREE.Object3D, opacity: number): void {
  const value = THREE.MathUtils.clamp(opacity, 0, 1);
  root.traverse((object) => {
    const candidate = object as THREE.Object3D & {
      material?: THREE.Material | THREE.Material[];
    };
    const materials = Array.isArray(candidate.material)
      ? candidate.material
      : candidate.material ? [candidate.material] : [];
    for (const material of materials) {
      let original = journeyMaterialStates.get(material);
      if (!original) {
        original = {
          opacity: material.opacity,
          transparent: material.transparent,
          depthWrite: material.depthWrite,
        };
        journeyMaterialStates.set(material, original);
      }
      material.opacity = original.opacity * value;
      material.transparent = original.transparent || value < 0.999;
      material.depthWrite = original.depthWrite && value >= 0.999;
      material.needsUpdate = true;
    }
  });
  root.visible = value > 0.001;
}

function applyJourneyVisualOpacity(): void {
  const sample = activeJourneySample;
  if (!sample) return;
  const earthRadiusM = displayRadiusForScale("earth", scaleDenominator);
  const earthOpacity = renderedBodyOpacity(earthRadiusM * 2);
  const useEarthGlobe = earthRadiusM < JOURNEY_EARTH_GLOBE_HANDOFF_RADIUS_M;
  planetRoot.visible = !useEarthGlobe && earthOpacity > 0.001;
  journeyEarthGlobe.position.copy(planetRoot.position);
  journeyEarthGlobe.quaternion.copy(planetRoot.quaternion);
  journeyEarthGlobe.scale.copy(planetRoot.scale);
  journeyEarthGlobeMaterial.opacity = earthOpacity;
  journeyEarthGlobeMaterial.depthWrite =
    journeyEarthGlobeMaterial.opacity >= 0.999;
  journeyEarthGlobe.visible = useEarthGlobe && earthOpacity > 0.001;
  setObjectOpacity(
    moonRoot,
    renderedBodyOpacity(
      displayRadiusForScale("moon", scaleDenominator) * 2,
    ),
  );
  for (const [bodyId, root] of placeholderRoots) {
    setObjectOpacity(
      root,
      bodyId === "sun"
        ? sample.physicalSunOpacity
        : renderedBodyOpacity(
          displayRadiusForScale(bodyId, scaleDenominator) * 2,
        ),
    );
  }
  setObjectOpacity(celestialSphere.object3d, 0);
  setObjectOpacity(shadowCones.group, earthOpacity);
}

function restoreEarthToGaiaSnapshot(snapshot: EarthToGaiaSnapshot): void {
  restoreJourneyMaterials();
  journeyEarthGlobe.visible = false;
  journeyEarthGlobeMaterial.opacity = 1;
  journeyEarthGlobeMaterial.depthWrite = true;
  activeJourneySample = null;
  navigationRealm = "solar_system";
  navigationMode = "surface";
  focusBodyId = "earth";
  state.contact = cloneContactFrame(snapshot.contact);
  state.terrainMultiplier = snapshot.terrainMultiplier;
  state.simulationClock = { ...snapshot.simulationClock };
  state.eclipse = snapshot.eclipse;
  scaleDenominator = snapshot.scaleDenominator;
  worldRotationRadians = snapshot.worldRotationRadians;
  const pausedDurationMs = performance.now() - snapshot.capturedAtMs;
  warpTransition = snapshot.transitions.warp
    ? {
        ...snapshot.transitions.warp,
        startedAtMs: snapshot.transitions.warp.startedAtMs + pausedDurationMs,
      }
    : undefined;
  scaleTransition = snapshot.transitions.scale
    ? {
        ...snapshot.transitions.scale,
        startedAtMs: snapshot.transitions.scale.startedAtMs + pausedDurationMs,
      }
    : undefined;
  headingTransition = snapshot.transitions.heading
    ? {
        ...snapshot.transitions.heading,
        startedAtMs: snapshot.transitions.heading.startedAtMs + pausedDurationMs,
      }
    : undefined;
  simulationInputEnabled = snapshot.simulationInputEnabled;
  syncEclipseConesVisible(snapshot.eclipseConesVisible);
  orbitNavigation = undefined;
  freeObserverJ2000M = undefined;
  freeNavigationFrame = undefined;
  resetObserverRig();
  syncHeadsetFloorPosition();
  previousXrHead = null;
  planetRoot.visible = snapshot.layerVisibility.planet;
  moonRoot.visible = snapshot.layerVisibility.moon;
  for (const [bodyId, visible] of snapshot.layerVisibility.placeholders) {
    placeholderRoots.get(bodyId)!.visible = visible;
  }
  shadowCones.group.visible = snapshot.layerVisibility.shadowCones;
  celestialSphere.object3d.visible = snapshot.layerVisibility.celestialBodies;
  spatialStarPass.scene.visible = snapshot.layerVisibility.stars;
  document.body.dataset.journeyPhase = "idle";
  document.body.dataset.journeyProgress = "0";
  updatePresentation();
  terrain.setLoadingSuspended(snapshot.tileLoadingSuspended.earth);
  moonTerrain.setLoadingSuspended(snapshot.tileLoadingSuspended.moon);
}

const journeyRunner = new JourneyRunner<
  EarthToGaiaSnapshot,
  EarthToGaiaPreparation
>({
  hooks: {
    capture: captureEarthToGaiaSnapshot,
    prepare: prepareEarthToGaiaJourney,
    begin: beginEarthToGaiaJourney,
    apply: applyEarthToGaiaSample,
    restore: restoreEarthToGaiaSnapshot,
    stateChanged(journeyState) {
      document.body.dataset.journeyStatus = journeyState.status;
      document.body.dataset.journeyPhase = journeyState.phase;
      document.body.dataset.journeyProgress = String(journeyState.progress);
    },
  },
  context: (preparation) => preparation.context,
});

function startEarthToGaiaJourney(): ReturnType<typeof journeyRunner.getState> {
  const current = journeyRunner.getState();
  if (
    current.status === "preparing" ||
    current.status === "running" ||
    current.status === "paused"
  ) {
    throw new Error("The Earth-to-Gaia journey is already active.");
  }
  const completion = journeyRunner.start();
  const immediateState = journeyRunner.getState();
  void completion.catch((error: unknown) => {
    console.warn("The Earth-to-Gaia journey could not start:", error);
  });
  return immediateState;
}

function requireJourneyUnlocked(): void {
  if (journeyRunner.isLocked()) {
    throw new Error("Stop the Earth-to-Gaia journey before changing this control.");
  }
}

function resetExperience(): void {
  if (journeyRunner.isLocked() || journeyRunner.getState().status === "failed") {
    journeyRunner.cancel(true);
    restoreJourneyMaterials();
    activeJourneySample = null;
    journeyEarthGlobe.visible = false;
    journeyEarthGlobeMaterial.opacity = 1;
    journeyEarthGlobeMaterial.depthWrite = true;
    navigationRealm = "solar_system";
    navigationMode = "surface";
    focusBodyId = "earth";
    orbitNavigation = undefined;
    freeObserverJ2000M = undefined;
    freeNavigationFrame = undefined;
    resetObserverRig();
  }
  resetPlanet();
}

let eclipseWorker: EclipseWorkerClient | undefined;
let eclipseSelectionSequence = 0;

async function selectSupervisedEclipse(eventId: string): Promise<void> {
  const year = eclipseYearFromEventId(eventId);
  if (year === null) throw new Error("Unrecognized solar eclipse event ID.");
  eclipseSelectionSequence += 1;
  const sequence = eclipseSelectionSequence;
  eclipseWorker ??= new EclipseWorkerClient();
  const events = await eclipseWorker.events(
    `${String(year).padStart(4, "0")}-01-01T00:00:00Z`,
    `${String(year + 1).padStart(4, "0")}-01-01T00:00:00Z`,
  );
  const eclipseEvent = events.find(({ id }) => id === eventId);
  if (!eclipseEvent) throw new Error(`Shadowline did not verify ${eventId}.`);
  const contacts = await eclipseWorker.contacts(eclipseEvent);
  if (sequence !== eclipseSelectionSequence) return;
  state.eclipse = { event: eclipseEvent, contacts };
  state.simulationClock = anchoredSimulationClock(
    Date.parse(contacts.startUtc),
    0,
  );
  syncEclipseConesVisible(true);
  updatePresentation(presentationDate());
}

function updateSupervisedEclipseTime(): void {
  lastShadowConeUpdateSecond = Number.NEGATIVE_INFINITY;
  updatePresentation(presentationDate());
}

async function applySupervisionCommand(command: SupervisionCommand): Promise<void> {
  if (command.kind === "startJourney") {
    startEarthToGaiaJourney();
    return;
  }
  if (command.kind === "pauseJourney") {
    journeyRunner.pause();
    return;
  }
  if (command.kind === "resumeJourney") {
    journeyRunner.resume();
    return;
  }
  if (command.kind === "stopJourney") {
    journeyRunner.stop();
    return;
  }
  requireJourneyUnlocked();
  if (command.kind === "setAmazonForestYearVisibility") {
    if (focusBodyId !== "earth") {
      throw new Error("Amazon forest outlines require Earth to be selected.");
    }
    await setAmazonForestYearVisibility(command.year, command.visible);
    return;
  }
  if (command.kind === "selectEclipseEvent") {
    await selectSupervisedEclipse(command.eventId);
    return;
  }
  if (command.kind === "returnToLiveTime") {
    eclipseSelectionSequence += 1;
    state.eclipse = null;
    state.simulationClock = realtimeSimulationClock();
    updateSupervisedEclipseTime();
    return;
  }
  if (command.kind === "setEclipseConeVisibility") {
    setEclipseConesVisible(command.visible);
    return;
  }
  if (command.kind === "setSimulationClock") {
    const wallTimeMs = Date.now();
    state.simulationClock = command.mode === "realtime"
      ? realtimeSimulationClock(wallTimeMs)
      : anchoredSimulationClock(
          command.atUtc === undefined
            ? simulationTimeMs(state.simulationClock, wallTimeMs)
            : Date.parse(command.atUtc),
          command.scale,
          wallTimeMs,
    );
    updateSupervisedEclipseTime();
    return;
  }
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

function syncEclipseConesVisible(visible: boolean): void {
  eclipseConesVisible = visible;
  shadowCones.group.visible = visible;
  lastShadowConeUpdateSecond = Number.NEGATIVE_INFINITY;
  document.body.dataset.eclipseCones = visible ? "visible" : "hidden";
  handPanelLocationSignature = "";
}

function setEclipseConesVisible(visible: boolean): void {
  syncEclipseConesVisible(visible);
}

function moveSpaceObserver(renderTravel: THREE.Vector3): void {
  if (navigationMode !== "free") return;
  const focus = celestialBody(focusBodyId);
  const focusPosition = bodyPositionJ2000M(focusBodyId, presentationDate());
  freeObserverJ2000M ??= systemObserverForFocus(
    focusPosition,
    focus.referenceRadiusM,
  );
  inverseWorldRotationQuaternion.copy(
    freeNavigationFrame?.systemFrameQuaternion ?? worldRotationQuaternion,
  ).invert();
  unrotatedSpaceTravel.copy(renderTravel)
    .applyQuaternion(inverseWorldRotationQuaternion);
  freeObserverJ2000M = translatedObserverJ2000M(
    freeObserverJ2000M,
    unrotatedSpaceTravel,
    scaleDenominator,
  );
}

function focusDistanceHeadsetM(): number {
  if (navigationMode === "orbit" && orbitNavigation) {
    const viewCamera = currentViewCamera();
    viewCamera.updateWorldMatrix(true, false);
    return viewCamera.getWorldPosition(new THREE.Vector3())
      .distanceTo(orbitNavigation.focusWorldPosition);
  }
  if (!freeObserverJ2000M) return focusedDisplayRadiusM() * 3;
  const focusPosition = bodyPositionJ2000M(focusBodyId, presentationDate());
  return headsetMetresForPhysicalMetres(Math.hypot(
    freeObserverJ2000M.x - focusPosition.x,
    freeObserverJ2000M.y - focusPosition.y,
    freeObserverJ2000M.z - focusPosition.z,
  ), scaleDenominator);
}

const terrainEyeWorldPosition = new THREE.Vector3();
const terrainDrawingBufferSize = new THREE.Vector2();
const systemBodyAttitudeQuaternion = new THREE.Quaternion();

function bodyAttitudeJ2000(
  bodyId: SolarSystemBodyId,
  when: Date,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  if (bodyId === "earth") {
    return target.copy(appEcefToRenderJ2000Quaternion(when));
  }
  return bodyFixedToRenderQuaternion(bodyRotation(bodyId, when), target);
}

function terrainViewMetrics(): {
  eyeHeightWorldM: number;
  focalLengthPixels: number;
} {
  const viewCamera = currentViewCamera();
  viewCamera.updateWorldMatrix(true, false);
  viewCamera.getWorldPosition(terrainEyeWorldPosition);
  // Measure the posed surface, so LOD follows the same elevation as rendering.
  const eyeHeightWorldM = navigationMode === "surface"
    ? bodySurfaceView(
        focusBodyId === "moon" ? "moon" : "earth",
        focusBodyId === "moon" ? moonRoot : planetRoot,
      ).observerHeightWorldM
    : Math.max(0.001, terrainEyeWorldPosition.y);
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

function bodySurfaceView(
  bodyId: "earth" | "moon",
  root: THREE.Object3D,
): BodySurfaceView {
  return observeBodySurface({
    bodyId, root, camera: currentViewCamera(),
    surface: bodyId === "moon" ? moonTerrain : terrain,
    terrainMultiplier: state.terrainMultiplier,
  });
}

function focusSurfaceAltitudePhysicalM(): number | undefined {
  if (navigationMode !== "orbit" || !orbitNavigation) return undefined;
  if (focusBodyId === "earth") {
    return physicalMetresForHeadsetMetres(
      bodySurfaceView("earth", planetRoot).observerHeightWorldM,
      scaleDenominator,
    );
  }
  if (focusBodyId === "moon") {
    return physicalMetresForHeadsetMetres(
      bodySurfaceView("moon", moonRoot).observerHeightWorldM,
      scaleDenominator,
    );
  }
  return Math.max(
    0,
    physicalMetresForHeadsetMetres(
      focusDistanceHeadsetM(),
      scaleDenominator,
    ) - celestialBody(focusBodyId).referenceRadiusM,
  );
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
    const earthReferenceRadiusM = celestialBody("earth").referenceRadiusM;
    const observation = eclipseEarthSurfaceObservation(
      headLocal.multiplyScalar(earthReferenceRadiusM),
    );
    normalizedFloorRadius = eclipseTopographicSurfaceRadius(
      observation,
      terrain.sampleElevationMetres(
        observation.latitudeDegrees,
        observation.longitudeDegrees,
      ) * state.terrainMultiplier,
    ) / earthReferenceRadiusM;
  } else if (focusBodyId === "moon") {
    const surface = bodySurfaceView("moon", root);
    normalizedFloorRadius += moonTerrain.sampleElevationMetres(
      surface.latitudeDegrees,
      surface.longitudeDegrees,
    ) * state.terrainMultiplier / celestialBody("moon").referenceRadiusM;
  }
  const floorDistance = normalizedFloorRadius * displayRadiusM;
  if (headWorld.distanceTo(centreWorld) >= floorDistance) return;
  commitObserverTransform(observerProjectedToBodyRadius(
    orbitNavigation.observer,
    headWorld,
    centreWorld,
    floorDistance,
  ));
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

interface SystemPresentationFrame {
  originJ2000M: Vector3d;
  originWorldPosition: THREE.Vector3;
  systemFrameQuaternion: THREE.Quaternion;
}

let lastSystemPresentationFrame: SystemPresentationFrame | undefined;

function placeBodyInSystemFrame(
  bodyId: SolarSystemBodyId,
  root: THREE.Object3D,
  when: Date,
  frame: SystemPresentationFrame,
): void {
  const bodyPosition = bodyPositionJ2000M(bodyId, when);
  const rendered = relativeJ2000MetresToRender({
    x: bodyPosition.x - frame.originJ2000M.x,
    y: bodyPosition.y - frame.originJ2000M.y,
    z: bodyPosition.z - frame.originJ2000M.z,
  }, scaleDenominator);
  const attitude = bodyAttitudeJ2000(
    bodyId,
    when,
    systemBodyAttitudeQuaternion,
  );
  root.position.set(rendered.x, rendered.y, rendered.z)
    .applyQuaternion(frame.systemFrameQuaternion)
    .add(frame.originWorldPosition);
  root.quaternion.copy(frame.systemFrameQuaternion).multiply(attitude);
  root.scale.setScalar(displayRadiusForScale(bodyId, scaleDenominator));
  root.visible = bodyId !== "sun" ||
    celestialSphere.getVisibility().sun_enabled;
}

function updateSystemPresentation(when: Date): SystemPresentationFrame {
  const focusBody = celestialBody(focusBodyId);
  const focusPosition = bodyPositionJ2000M(focusBodyId, when);
  if (navigationMode === "orbit" && !orbitNavigation) initializeOrbit(when);
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
  camera.far = Math.max(
    1_200,
    headsetMetresForPhysicalMetres(10_000_000_000_000, scaleDenominator),
  );
  camera.updateProjectionMatrix();
  const frame: SystemPresentationFrame = navigationMode === "orbit" &&
      orbitNavigation
    ? {
        originJ2000M: focusPosition,
        originWorldPosition: orbitNavigation.focusWorldPosition,
        systemFrameQuaternion: orbitNavigation.systemFrameQuaternion,
      }
    : freeNavigationFrame
      ? {
          originJ2000M: observer,
          originWorldPosition: freeNavigationFrame.anchorWorldPosition,
          systemFrameQuaternion: freeNavigationFrame.systemFrameQuaternion,
        }
      : {
          originJ2000M: observer,
          originWorldPosition: new THREE.Vector3(0, 1.65, 0),
          systemFrameQuaternion: worldRotationQuaternion,
        };
  placeBodyInSystemFrame("earth", planetRoot, when, frame);
  placeBodyInSystemFrame("moon", moonRoot, when, frame);
  for (const [bodyId, root] of placeholderRoots) {
    placeBodyInSystemFrame(bodyId, root, when, frame);
  }
  return frame;
}

function updateSurfaceSystemPresentation(
  when: Date,
  pose: ReturnType<typeof solveBodySurfacePose>,
): SystemPresentationFrame {
  for (const root of placeholderRoots.values()) root.visible = false;
  planetRoot.visible = true;
  moonRoot.visible = true;
  const focusRoot = focusBodyId === "moon" ? moonRoot : planetRoot;
  focusRoot.quaternion.copy(pose.bodyToWorld).premultiply(worldRotationQuaternion);
  focusRoot.position.copy(pose.centre)
    .sub(worldRotationPivot)
    .applyQuaternion(worldRotationQuaternion)
    .add(worldRotationPivot);
  focusRoot.scale.setScalar(focusedDisplayRadiusM());
  const focusAttitude = bodyAttitudeJ2000(focusBodyId, when);
  const frame: SystemPresentationFrame = {
    originJ2000M: bodyPositionJ2000M(focusBodyId, when),
    originWorldPosition: focusRoot.position.clone(),
    systemFrameQuaternion: focusRoot.quaternion.clone()
      .multiply(focusAttitude.invert())
      .normalize(),
  };
  if (focusBodyId === "moon") {
    placeBodyInSystemFrame("earth", planetRoot, when, frame);
  } else {
    placeBodyInSystemFrame("moon", moonRoot, when, frame);
  }
  const sunRoot = placeholderRoots.get("sun")!;
  placeBodyInSystemFrame("sun", sunRoot, when, frame);

  const farthestPhysicalM = Math.max(
    ...(["earth", "moon", "sun"] as const).map((bodyId) => {
      const position = bodyPositionJ2000M(bodyId, when);
      const distanceFromFocusM = Math.hypot(
        position.x - frame.originJ2000M.x,
        position.y - frame.originJ2000M.y,
        position.z - frame.originJ2000M.z,
      );
      return distanceFromFocusM + celestialBody(bodyId).referenceRadiusM;
    }),
  );
  camera.far = Math.max(
    1_200,
    headsetMetresForPhysicalMetres(farthestPhysicalM, scaleDenominator) * 1.05,
  );
  camera.updateProjectionMatrix();
  return frame;
}

const sunWorldPosition = new THREE.Vector3();
const earthWorldPosition = new THREE.Vector3();
const moonWorldPosition = new THREE.Vector3();
const sunlightDirection = new THREE.Vector3();
const shadowMoonPosition = new THREE.Vector3();
const shadowAxis = new THREE.Vector3();
const coneToEarthFixed = new THREE.Matrix4();

function updateSolarLighting(): void {
  placeholderRoots.get("sun")!.getWorldPosition(sunWorldPosition);
  planetRoot.getWorldPosition(earthWorldPosition);
  moonRoot.getWorldPosition(moonWorldPosition);
  terrain.setSunlightDirection(
    sunlightDirection.copy(sunWorldPosition).sub(earthWorldPosition),
  );
  moonTerrain.setSunlightDirection(
    sunlightDirection.copy(sunWorldPosition).sub(moonWorldPosition),
  );
}

function updateShadowConePresentation(
  when: Date,
  frame: SystemPresentationFrame,
): void {
  shadowCones.group.visible = eclipseConesVisible;
  shadowCones.group.position.copy(planetRoot.position);
  shadowCones.group.quaternion.copy(frame.systemFrameQuaternion);
  shadowCones.group.scale.setScalar(1 / scaleDenominator);
  if (!eclipseConesVisible) return;
  const second = Math.floor(when.getTime() / 1_000);
  if (second === lastShadowConeUpdateSecond) return;
  lastShadowConeUpdateSecond = second;
  const geometry = calculateSolarShadowGeometry(when);
  const moonPosition = relativeJ2000MetresToRender(
    geometry.moonFromEarthJ2000M,
    1,
  );
  const direction = relativeJ2000MetresToRender(
    geometry.shadowDirectionJ2000,
    1,
  );
  shadowMoonPosition.set(moonPosition.x, moonPosition.y, moonPosition.z);
  shadowAxis.set(direction.x, direction.y, direction.z).normalize();
  coneToEarthFixed.makeRotationFromQuaternion(
    equatorialJ2000ToAppEcefQuaternion(when),
  );
  shadowCones.update({
    moonPosition: shadowMoonPosition,
    shadowAxis,
    physicalLengthM: solarShadowConeLengthM(geometry),
    centralConeSlope: geometry.centralConeSlope,
    penumbraConeSlope: geometry.penumbraConeSlope,
    coneToEarthFixed,
  });
  document.body.dataset.eclipseConeTime = geometry.atUtc;
  document.body.dataset.eclipseAxisMissKm = String(
    geometry.axisMissDistanceM / 1_000,
  );
  document.body.dataset.eclipseCentralRadiusKm = String(
    geometry.centralConeRadiusAtEarthPlaneM / 1_000,
  );
}

function updatePresentation(when = presentationDate()): void {
  let coordinates = coordinatesForFrame(state.contact);
  worldRotationQuaternion.setFromAxisAngle(worldUp, worldRotationRadians);
  worldRotationPivot.set(
    headsetFloorPosition.x,
    0,
    headsetFloorPosition.y,
  );
  document.body.dataset.navigationMode = navigationMode;
  document.body.dataset.focusBody = focusBodyId;
  updateWorldCredits();
  const earthDisplayRadiusM = displayRadiusForScale("earth", scaleDenominator);
  const moonDisplayRadiusM = displayRadiusForScale("moon", scaleDenominator);
  let systemFrame: SystemPresentationFrame;
  if (navigationMode !== "surface") {
    systemFrame = updateSystemPresentation(when);
    enforceOrbitSurfaceFloor();
  } else {
    systemFrame = updateSurfaceSystemPresentation(
      when,
      solveBodySurfacePose(
        state, headsetFloorPosition, focusedDisplayRadiusM(),
        focusBodyId === "moon" ? moonWorld.surfaceModel : earthWorld.surfaceModel,
        focusedTerrain().sampleElevationMetres(
          coordinates.latitudeDegrees, coordinates.longitudeDegrees,
        ),
      ),
    );
  }
  lastSystemPresentationFrame = systemFrame;
  updateSolarLighting();
  updateShadowConePresentation(when, systemFrame);
  const view = terrainViewMetrics();
  const earthOrbitalView = navigationMode !== "surface" || focusBodyId !== "earth"
    ? bodySurfaceView("earth", planetRoot)
    : undefined;
  const moonOrbitalView = navigationMode !== "surface" || focusBodyId !== "moon"
    ? bodySurfaceView("moon", moonRoot)
    : undefined;
  const focusedOrbitalView = navigationMode === "orbit"
    ? focusBodyId === "earth"
      ? earthOrbitalView
      : focusBodyId === "moon" ? moonOrbitalView : undefined
    : undefined;
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
  document.body.dataset.scaleDenominator = String(scaleDenominator);
  earthWorld.update({
    latitudeDegrees:
      earthOrbitalView?.latitudeDegrees ?? coordinates.latitudeDegrees,
    longitudeDegrees:
      earthOrbitalView?.longitudeDegrees ?? coordinates.longitudeDegrees,
    displayRadiusM: earthOrbitalView?.displayRadiusM ?? earthDisplayRadiusM,
    terrainMultiplier: state.terrainMultiplier,
    observerHeightWorldM:
      earthOrbitalView?.observerHeightWorldM ?? view.eyeHeightWorldM,
    focalLengthPixels: view.focalLengthPixels,
  });
  moonWorld.update({
    latitudeDegrees:
      moonOrbitalView?.latitudeDegrees ?? coordinates.latitudeDegrees,
    longitudeDegrees:
      moonOrbitalView?.longitudeDegrees ?? coordinates.longitudeDegrees,
    displayRadiusM: moonOrbitalView?.displayRadiusM ?? moonDisplayRadiusM,
    terrainMultiplier: state.terrainMultiplier,
    observerHeightWorldM:
      moonOrbitalView?.observerHeightWorldM ?? view.eyeHeightWorldM,
    focalLengthPixels: view.focalLengthPixels,
  });
  atmosphere.update({
    displayRadiusM: earthOrbitalView?.displayRadiusM ?? earthDisplayRadiusM,
    observerHeightWorldM:
      earthOrbitalView?.observerHeightWorldM ?? view.eyeHeightWorldM,
  });
}

function handPanelStatus(
  _latitudeDegrees: number,
  _longitudeDegrees: number,
): HandPanelStatus {
  const lod = focusedTerrain().getLodStatus();
  return {
    scaleDenominator,
    terrainMultiplier: state.terrainMultiplier,
    minimumTerrainZoom: lod.minZoom,
    maximumTerrainZoom: lod.maxZoom,
    terrainBudgetLimited: lod.budgetLimited,
    agentState: realtimeAgentStatus.state,
    navigationMode,
    focusBody: celestialBody(focusBodyId).name,
    eclipseConesVisible,
    focusAltitudePhysicalM: focusSurfaceAltitudePhysicalM(),
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
    status.scaleDenominator.toFixed(3),
    status.terrainMultiplier.toFixed(1),
    status.minimumTerrainZoom,
    status.maximumTerrainZoom,
    status.terrainBudgetLimited ? "capped" : "screen",
    status.agentState,
    status.navigationMode,
    status.focusBody,
    status.eclipseConesVisible ? "cones" : "no-cones",
    status.focusAltitudePhysicalM?.toFixed(0),
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

const voiceAgent = createGeantVoiceAgent({
  onStatus(status) {
    realtimeAgentStatus = status;
    document.body.dataset.agentStatus = status.state;
    document.body.dataset.agentDetail = status.detail;
    handPanelLocationSignature = "";
  },
  onAudioState(state) { document.body.dataset.agentAudio = state; },
  tools: {
    get_navigation_state() {
      const orbitDistanceHeadsetM = navigationMode === "orbit"
        ? focusDistanceHeadsetM()
        : null;
      return {
        realm: navigationRealm,
        mode: navigationMode,
        focus_body: focusBodyId,
        scale_denominator: scaleDenominator,
        terrain_multiplier: state.terrainMultiplier,
        focus_distance_headset_metres: orbitDistanceHeadsetM,
        focus_distance_physical_metres: orbitDistanceHeadsetM === null
          ? null
          : orbitDistanceHeadsetM * scaleDenominator,
      };
    },
    get_journey_state() {
      return journeyRunner.getState();
    },
    start_journey(argumentsValue) {
      if (
        !argumentsValue ||
        typeof argumentsValue !== "object" ||
        (argumentsValue as Record<string, unknown>).journey !==
          EARTH_TO_GAIA_JOURNEY_ID
      ) {
        throw new Error("Journey must be earth_to_gaia.");
      }
      return startEarthToGaiaJourney();
    },
    control_journey(argumentsValue) {
      if (!argumentsValue || typeof argumentsValue !== "object") {
        throw new Error("Journey control arguments are required.");
      }
      const action = (argumentsValue as Record<string, unknown>).action;
      if (action === "pause") journeyRunner.pause();
      else if (action === "resume") journeyRunner.resume();
      else if (action === "stop") journeyRunner.stop();
      else throw new Error("Journey action must be pause, resume, or stop.");
      return journeyRunner.getState();
    },
    set_navigation(argumentsValue) {
      requireJourneyUnlocked();
      if (!argumentsValue || typeof argumentsValue !== "object") {
        throw new Error("Navigation arguments are required.");
      }
      const values = argumentsValue as Record<string, unknown>;
      if ("display_radius_metres" in values) {
        throw new Error(
          "display_radius_metres is no longer supported; use scale_denominator.",
        );
      }
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
      if (time !== undefined && values.scale_denominator === undefined) {
        throw new Error(
          "Transition time requires a scale denominator in this tool.",
        );
      }
      if (
        values.scale_denominator !== undefined &&
        typeof values.scale_denominator !== "number"
      ) {
        throw new Error("scale_denominator must be a number.");
      }
      if (typeof values.scale_denominator === "number") {
        applyVoiceScaleDenominatorMutation(
          values.scale_denominator,
          canonicalNavigationMutations,
          time,
        );
      }
      return {
        ok: true,
        mode: navigationMode,
        focus_body: focusBodyId,
        scale_denominator: scaleDenominator,
        target_scale_denominator:
          typeof values.scale_denominator === "number"
            ? values.scale_denominator
            : scaleDenominator,
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
        scale_denominator: scaleDenominator,
        location_detail: AGENT_LOCATION_DETAIL,
        named_location_is_approximate: namedLocation !== undefined,
        named_location: namedLocation ?? null,
      };
    },
    set_user_location(argumentsValue) {
      requireJourneyUnlocked();
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
      requireJourneyUnlocked();
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
      requireJourneyUnlocked();
      applyVoiceRemovePinMutation(
        pinIdFromVoiceArguments(argumentsValue),
        canonicalLocationPinMutations,
      );
      return { ok: true, ...locationPinVoiceState() };
    },
    set_location_pin_visibility(argumentsValue) {
      requireJourneyUnlocked();
      const { pinId, visible } = pinVisibilityFromVoiceArguments(argumentsValue);
      applyVoiceSetPinVisibilityMutation(
        pinId,
        visible,
        canonicalLocationPinMutations,
      );
      return { ok: true, ...locationPinVoiceState() };
    },
    rename_location_pin(argumentsValue) {
      requireJourneyUnlocked();
      const { pinId, label } = pinRenameFromVoiceArguments(argumentsValue);
      applyVoiceRenamePinMutation(pinId, label, canonicalLocationPinMutations);
      return { ok: true, pin_id: pinId, ...locationPinVoiceState() };
    },
    set_location_pin_guidance(argumentsValue) {
      requireJourneyUnlocked();
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
      requireJourneyUnlocked();
      return setViewDirection(argumentsValue);
    },
    async set_satellite_group_visibility(argumentsValue) {
      requireJourneyUnlocked();
      const { group, enabled } =
        parseSatelliteVisibilityArguments(argumentsValue);
      return await setSatelliteGroupEnabled(group, enabled);
    },
    async get_amazon_forest_outlines() {
      await amazonForestOutlineStore.load();
      return amazonForestOutlineVoiceState();
    },
    async set_amazon_forest_outline_visibility(argumentsValue) {
      if (focusBodyId !== "earth") {
        throw new Error("Amazon forest outlines require Earth to be selected.");
      }
      const { year, visible } =
        parseAmazonForestOutlineVisibilityArguments(argumentsValue);
      await setAmazonForestYearVisibility(year, visible);
      return { ok: true, year, visible, ...amazonForestOutlineVoiceState() };
    },
    get_celestial_visibility() {
      return celestialSphere.getVisibility();
    },
    set_celestial_visibility(argumentsValue) {
      requireJourneyUnlocked();
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
      requireJourneyUnlocked();
      const display = parseAircraftDisplayArguments(argumentsValue);
      return setAircraftDisplay(display.target, display.enabled);
    },
    get_tile_debug_controls() {
      return focusedTerrain().getTileDebugControls();
    },
    get_tile_planner_state() {
      return focusedTerrain().getTilePlannerState();
    },
    set_tile_pixel_ratio(argumentsValue) {
      requireJourneyUnlocked();
      return focusedTerrain().setTilePixelRatio(
        parseTilePixelRatioArguments(argumentsValue),
      );
    },
    set_tile_max_zoom(argumentsValue) {
      requireJourneyUnlocked();
      return focusedTerrain().setTileMaxZoom(
        parseTileMaxZoomArguments(argumentsValue),
      );
    },
    set_tile_recalculation(argumentsValue) {
      requireJourneyUnlocked();
      return focusedTerrain().setTileRecalculation(
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
    hidePanelPointerVisual();
    return;
  }
  const anchorPose = resolveHandPanelAnchorPose();
  if (!anchorPose) {
    if (handPanel.enabled) handPanel.enabled = false;
    hidePanelPointerVisual();
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
        focusedDisplayRadiusM(),
      );
    }
  }
  previousXrHead = headsetFloorPosition.clone();
}

function updateXrControls(deltaSeconds: number, nowMs: number): void {
  const session = renderer.xr.getSession();
  if (!session) return;
  const intent = controllerIntent(session, nowMs, buttonLatch);
  if (journeyRunner.isLocked()) {
    if (intent.toggleAgent) void voiceAgent.toggle();
    if (intent.reset) resetExperience();
    return;
  }
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
        focusedDisplayRadiusM(),
      );
    } else {
      spaceTravel.set(intent.travel.x, 0, intent.travel.y)
        .applyQuaternion(xrViewQuaternion);
      if (spaceTravel.lengthSq() > 1) spaceTravel.normalize();
      spaceTravel.multiplyScalar(
        spaceTravelSpeedHeadsetMPerSecond(
          "free",
          focusedDisplayRadiusM(),
          focusDistanceHeadsetM(),
          intent.boost,
        ) * deltaSeconds,
      );
      moveSpaceObserver(spaceTravel);
    }
  }
  if (navigationMode !== "orbit") {
    commitScaleDenominator(scaleDenominatorAfterInput(
      scaleDenominator,
      intent.scaleAxis,
      deltaSeconds,
    ));
    state.terrainMultiplier = applyTerrainMultiplierRate(
      state.terrainMultiplier,
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
  if (intent.reset) resetExperience();
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
  syncOrbitObserverSystemPosition();
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
    commitObserverTransform(observerProjectedToBodyRadius(
      orbitNavigation.observer,
      headPosition,
      orbitNavigation.focusWorldPosition,
      desiredDistance,
    ));
  }
  if (dominant.vertical !== 0) {
    commitScaleDenominator(orbitalLogarithmicValue(
      scaleDenominator,
      -dominant.vertical,
      deltaSeconds,
      boosted,
    ));
  } else {
    commitScaleDenominator(scaleDenominatorAfterInput(
      scaleDenominator,
      0,
      deltaSeconds,
    ));
  }
}

function updateDesktopControls(deltaSeconds: number): void {
  if (journeyRunner.isLocked()) return;
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
        focusedDisplayRadiusM(),
      );
    } else {
      spaceTravel.set(desktopTravel.x, 0, desktopTravel.y)
        .applyQuaternion(camera.quaternion);
      if (spaceTravel.lengthSq() > 1) spaceTravel.normalize();
      spaceTravel.multiplyScalar(
        spaceTravelSpeedHeadsetMPerSecond(
          "free",
          focusedDisplayRadiusM(),
          focusDistanceHeadsetM(),
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
  commitScaleDenominator(scaleDenominatorAfterInput(
    scaleDenominator,
    scaleAxis,
    deltaSeconds,
  ));
  state.terrainMultiplier = applyTerrainMultiplierRate(
    state.terrainMultiplier,
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
  if (!pointerActive || renderer.xr.isPresenting || journeyRunner.isLocked()) {
    return;
  }
  if (navigationMode === "orbit") {
    const radiansPerPixel = orbitalDragRadiansPerPixel(
      focusDistanceHeadsetM(),
      focusedDisplayRadiusM(),
      terrainViewMetrics().focalLengthPixels,
      0.002,
    );
    orbitSystemFrameByRadians(
      -(event.clientX - pointerX) * radiansPerPixel,
      (event.clientY - pointerY) * radiansPerPixel,
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
  if (
    renderer.xr.isPresenting ||
    navigationMode !== "orbit" ||
    journeyRunner.isLocked()
  ) return;
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
  if (journeyRunner.isLocked()) {
    if (!event.repeat && event.code === "Backspace") resetExperience();
    event.preventDefault();
    return;
  }
  if (event.repeat && event.code === "Backspace") return;
  if (event.code === "Backspace") resetExperience();
  if (!event.repeat && event.code === "KeyM") {
    const modes: NavigationMode[] = ["surface", "orbit", "free"];
    setNavigationMode(modes[(modes.indexOf(navigationMode) + 1) % modes.length]!);
  }
  if (!event.repeat && event.code === "KeyN") {
    setFocusBody(focusBodyId === "earth" ? "moon" : "earth");
  }
  if (!event.repeat && event.code === "KeyE") {
    setEclipseConesVisible(!eclipseConesVisible);
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
      "KeyE",
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
  if (journeyRunner.isLocked()) journeyRunner.cancel(true);
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
  readonly scaleDenominator: number;
  readonly terrainMultiplier: number;
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
      focusDistanceHeadsetM: orbitDistanceM,
      focusDistancePhysicalM: orbitDistanceM === null
        ? null
        : orbitDistanceM * scaleDenominator,
      observerRig: {
        position: observerRig.position.toArray(),
        quaternion: observerRig.quaternion.toArray(),
        scale: observerRig.scale.toArray(),
      },
      observerSystemPositionM: orbitNavigation?.observerSystemPositionM ??
        freeObserverJ2000M ?? null,
      focusWorldPosition: orbitNavigation?.focusWorldPosition.toArray() ?? null,
    },
    scaleDenominator,
    focusedBodyDisplayRadiusM: focusedDisplayRadiusM(),
    terrainMultiplier: state.terrainMultiplier,
    surfaceView: focusBodyId === "earth" || focusBodyId === "moon"
      ? bodySurfaceView(focusBodyId, focusBodyId === "moon" ? moonRoot : planetRoot)
      : null,
    view: {
      pitchRadians: pitch,
      yawRadians: yaw,
      worldRotationRadians,
      worldRotationDegrees: normalizeHeadingDegrees(
        worldRotationRadians * 180 / Math.PI,
      ),
    },
    tileControls: focusedTerrain().getTileDebugControls(),
    overlays: {
      terrain: tileOverlayVisible,
      textures: textureTileOverlayVisible,
    },
    renderingEnabled,
    terrainRenderCullingEnabled: focusedTerrain().renderCullingEnabled,
    simulationInputEnabled,
    benchmarkActive: benchmarkRestoreState !== undefined,
    foveation: renderer.xr.getFoveation() ?? null,
    xrFramebufferScaleFactor,
    desktopPixelRatio: renderer.getPixelRatio(),
    layers: {
      terrain: focusedTerrain().group.visible,
      atmosphere: atmosphere.mesh.visible,
      stars: spatialStarPass.scene.visible,
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
    terrain: focusedTerrain().getMetrics(),
    planner: focusedTerrain().getTilePlannerState(),
    resourcesByHostLast30Seconds: summarizeResourceTimings(
      performance.getEntriesByType("resource") as PerformanceResourceTiming[],
      performance.now(),
    ),
    browser: debugBrowserSnapshot(),
    imagery: {
      provider: document.body.dataset.imageryProvider,
      tileSize: Number(document.body.dataset.imageryTileSize),
    },
  };
}

function captureBenchmarkRestoreState(): BenchmarkRestoreState {
  return {
    coordinates: coordinatesForFrame(state.contact),
    scaleDenominator,
    terrainMultiplier: state.terrainMultiplier,
    pitchRadians: pitch,
    yawRadians: yaw,
    worldRotationRadians,
    tileControls: focusedTerrain().getTileDebugControls(),
    tileOverlayVisible,
    textureTileOverlayVisible,
    renderingEnabled,
    terrainRenderCullingEnabled: focusedTerrain().renderCullingEnabled,
    simulationInputEnabled,
    foveation: renderer.xr.getFoveation(),
    layers: {
      terrain: focusedTerrain().group.visible,
      atmosphere: atmosphere.mesh.visible,
      stars: spatialStarPass.scene.visible,
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
  focusedTerrain().setTileRecalculation({ target: "both", enabled: false });
  focusedTerrain().setTilePixelRatio({
    target: "terrain",
    screenPixelsPerSourcePixel:
      controls.terrain.screen_pixels_per_source_pixel,
  });
  focusedTerrain().setTilePixelRatio({
    target: "textures",
    screenPixelsPerSourcePixel:
      controls.textures.screen_pixels_per_source_pixel,
  });
  focusedTerrain().setTileMaxZoom({
    target: "terrain",
    value: controls.terrain.max_zoom,
  });
  focusedTerrain().setTileMaxZoom({
    target: "textures",
    value: controls.textures.max_zoom,
  });
  focusedTerrain().setTileRecalculation({
    target: "terrain",
    enabled: controls.terrain.recalculation_enabled,
  });
  focusedTerrain().setTileRecalculation({
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
      position: "setLocation(lat, lon), setScaleDenominator(value), setTerrainMultiplier(value), setView({pitchRadians?, yawRadians?}), reset()",
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
    focusedTerrain().clearRenderVisibilityMetrics();
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
    const benchmarkScaleDenominator = finiteDebugNumber(
      options.scaleDenominator ?? DEFAULT_SCALE_DENOMINATOR,
      "scaleDenominator",
    );
    const terrainMultiplier = finiteDebugNumber(
      options.terrainMultiplier ?? 1,
      "terrainMultiplier",
    );
    validScaleDenominator(benchmarkScaleDenominator);
    if (terrainMultiplier < 0) {
      throw new Error("terrainMultiplier must be nonnegative.");
    }
    benchmarkRestoreState ??= captureBenchmarkRestoreState();
    setSimulationInputEnabled(false);
    focusedTerrain().setTileRecalculation({ target: "both", enabled: false });
    setUserLocation(latitudeDegrees, longitudeDegrees);
    commitScaleDenominator(benchmarkScaleDenominator);
    state.terrainMultiplier = terrainMultiplier;
    pitch = 0;
    yaw = 0;
    worldRotationRadians = 0;
    headingTransition = undefined;
    camera.rotation.set(0, 0, 0);
    focusedTerrain().setTilePixelRatio({
      target: "terrain",
      screenPixelsPerSourcePixel: 2,
    });
    focusedTerrain().setTilePixelRatio({
      target: "textures",
      screenPixelsPerSourcePixel: 1,
    });
    focusedTerrain().setTileMaxZoom({ target: "both", value: null });
    setTileOverlayVisible(false);
    setTextureTileOverlayVisible(false);
    focusedTerrain().setRenderCullingEnabled(true);
    renderingEnabled = true;
    focusedTerrain().group.visible = true;
    spatialStarPass.scene.visible = true;
    aircraftLayer.group.visible = false;
    handPanelVisible = false;
    handPanel.enabled = false;
    renderer.xr.setFoveation(1);
    updatePresentation();
    focusedTerrain().setTileRecalculation({ target: "both", enabled: true });
    frameTelemetry.clear();
    focusedTerrain().clearRenderVisibilityMetrics();
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
    focusedTerrain().setTileRecalculation({ target: "both", enabled: false });
    setUserLocation(
      restore.coordinates.latitudeDegrees,
      restore.coordinates.longitudeDegrees,
    );
    commitScaleDenominator(restore.scaleDenominator);
    state.terrainMultiplier = restore.terrainMultiplier;
    pitch = restore.pitchRadians;
    yaw = restore.yawRadians;
    worldRotationRadians = restore.worldRotationRadians;
    headingTransition = undefined;
    camera.rotation.set(pitch, yaw, 0);
    applyTileControlReadback(restore.tileControls);
    setTileOverlayVisible(restore.tileOverlayVisible);
    setTextureTileOverlayVisible(restore.textureTileOverlayVisible);
    renderingEnabled = restore.renderingEnabled;
    focusedTerrain().setRenderCullingEnabled(restore.terrainRenderCullingEnabled);
    focusedTerrain().group.visible = restore.layers.terrain;
    atmosphere.mesh.visible = restore.layers.atmosphere;
    spatialStarPass.scene.visible = restore.layers.stars;
    aircraftLayer.group.visible = restore.layers.aircraft;
    handPanelVisible = restore.layers.handPanel;
    if (restore.foveation !== undefined) {
      renderer.xr.setFoveation(restore.foveation);
    }
    setSimulationInputEnabled(restore.simulationInputEnabled);
    frameTelemetry.clear();
    focusedTerrain().clearRenderVisibilityMetrics();
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
  setScaleDenominator(denominator) {
    const value = finiteDebugNumber(denominator, "scaleDenominator");
    setScaleDenominator(value);
    return debugControlState();
  },
  setTerrainMultiplier(multiplier) {
    const value = finiteDebugNumber(multiplier, "multiplier");
    setTerrainMultiplier(value);
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
    return focusedTerrain().setTilePixelRatio({
      target: debugTileTarget(target),
      screenPixelsPerSourcePixel: value,
    });
  },
  setMaxZ(target, zoom) {
    if (zoom !== null && (!Number.isInteger(zoom) || zoom < 0)) {
      throw new Error("zoom must be a nonnegative integer or null.");
    }
    return focusedTerrain().setTileMaxZoom({ target: debugTileTarget(target), value: zoom });
  },
  setTileRecalculation(target, enabled) {
    return focusedTerrain().setTileRecalculation({
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
    focusedTerrain().setRenderCullingEnabled(enabled);
    frameTelemetry.clear();
    focusedTerrain().clearRenderVisibilityMetrics();
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
        focusedTerrain().group.visible = visible;
        break;
      case "atmosphere":
        atmosphere.mesh.visible = visible;
        break;
      case "stars":
        spatialStarPass.scene.visible = visible;
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
const starJ2000ToWorld = new THREE.Quaternion();
let lastStarTelemetryUpdateMs = Number.NEGATIVE_INFINITY;
function render(nowMs: number): void {
  const applicationStartMs = performance.now();
  const xrFrameRate = renderer.xr.getSession()?.frameRate;
  if (xrFrameRate !== undefined && xrFrameRate > 0) {
    lastKnownXrFrameRate = xrFrameRate;
  }
  if (renderer.xr.isPresenting) renderer.xr.updateCamera(camera);
  const wallTimeMs = Date.now();
  const intervalMs = nowMs - previousFrameMs;
  const deltaSeconds = Math.min(0.05, intervalMs / 1000);
  previousFrameMs = nowMs;
  journeyRunner.update(nowMs);
  const simulationTimeMsValue = simulationTimeMs(
    state.simulationClock,
    wallTimeMs,
  );
  const when = new Date(simulationTimeMsValue);
  updateNavigationTransitions(nowMs);
  if (simulationInputEnabled || journeyRunner.isLocked()) {
    if (renderer.xr.isPresenting) {
      updatePhysicalWalking();
      updateXrControls(deltaSeconds, nowMs);
    } else {
      updateDesktopControls(deltaSeconds);
    }
  }
  // Publish loaded tiles before anchoring and measuring this frame's ground.
  for (const world of worldRuntimes) world.processFrame();
  updatePresentation(when);
  applyJourneyVisualOpacity();
  const pinCoordinates = coordinatesForFrame(state.contact);
  locationPinLayer.update({
    pinState: locationPinStore.snapshot(),
    camera: currentViewCamera(),
    earthRoot: planetRoot,
    userLatitudeDegrees: pinCoordinates.latitudeDegrees,
    userLongitudeDegrees: pinCoordinates.longitudeDegrees,
    displayRadiusM: displayRadiusForScale("earth", scaleDenominator),
    terrainMultiplier: state.terrainMultiplier,
    visible: renderer.xr.isPresenting &&
      navigationMode === "surface" && focusBodyId === "earth",
  });
  supervisionClient?.update(nowMs);
  const earthDisplayRadiusM = navigationMode === "surface"
    ? displayRadiusForScale("earth", scaleDenominator)
    : planetRoot.getWorldScale(earthWorldScale).x;
  aircraftLayer.update(
    wallTimeMs,
    earthDisplayRadiusM,
  );
  satelliteLayer.update(
    simulationTimeMsValue,
    earthDisplayRadiusM,
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
    simulationTimeMsValue,
    celestialObserverAppEcefKm,
  );
  const sunObserverPc = vectorMetresToParsecs(
    authoredStellarObserverJ2000M(),
  );
  const starObserverPc = activeJourneySample?.catalogObserverJ2000Pc ??
    sunObserverPc;
  const starFrame = activeJourneySample
    ? journeyJ2000ToWorld
    : j2000ToWorldQuaternion(
        lastSystemPresentationFrame?.systemFrameQuaternion ??
          worldRotationQuaternion,
        starJ2000ToWorld,
      );
  if (activeJourneySample) {
    observerRig.getWorldQuaternion(observerRigWorldQuaternion);
    trackingRoomOffsetWorld(
      camera.position,
      journeyTrackingOriginLocal,
      observerRigWorldQuaternion,
      journeyRoomOffsetWorld,
    );
    journeyTrackingAnchorWorld.copy(cameraWorldPosition)
      .sub(journeyRoomOffsetWorld);
  }
  const starTrackingAnchor = activeJourneySample
    ? journeyTrackingAnchorWorld
    : cameraWorldPosition;
  spatialStarPass.setView({
    observerJ2000Pc: starObserverPc,
    sunObserverJ2000Pc: sunObserverPc,
    j2000ToWorld: starFrame,
    trackingAnchorWorld: starTrackingAnchor,
    parallaxBlend: activeJourneySample?.roomTranslationBlend ?? 0,
    sunOpacity: activeJourneySample?.syntheticSunOpacity ?? 0,
  });
  if (nowMs - lastStarTelemetryUpdateMs >= 1_000) {
    lastStarTelemetryUpdateMs = nowMs;
    const starSnapshot = spatialStarPass.getSnapshot();
    document.body.dataset.starStatus = starSnapshot.status;
    document.body.dataset.starCount = String(starSnapshot.starCount);
  }
  updateHandPanel(nowMs);
  if (renderingEnabled) {
    renderer.clear(true, true, true);
    spatialStarPass.render(renderer, camera);
    renderer.clearDepth();
    renderer.render(scene, camera);
  }
  frameTelemetry.record(
    nowMs,
    intervalMs,
    performance.now() - applicationStartMs,
    renderingEnabled,
  );
}

window.addEventListener("beforeunload", () => {
  void voiceAgent.dispose();
  stopSupervisionSession();
  if (benchmarkMetricsTimer !== undefined) {
    window.clearInterval(benchmarkMetricsTimer);
  }
  stopAircraftStream();
  for (const { id } of SATELLITE_GROUPS) stopSatelliteGroup(id);
  amazonForestOutlines.dispose();
  for (const world of worldRuntimes) world.dispose();
  journeyEarthGlobe.geometry.dispose();
  journeyEarthGlobeMaterial.dispose();
  locationPinLayer.dispose();
  celestialSphere.dispose();
  void spatialStarPass.dispose();
  eclipseWorker?.dispose();
  shadowCones.dispose();
  handPanel.dispose();
  handPanelRuntime.dispose();
});

const benchmarkMetricsTimer = benchmarkParameters.get("benchmarkMetrics") === "1"
  ? window.setInterval(() => {
      document.body.dataset.terrainMetrics = JSON.stringify(
        focusedTerrain().getMetrics(),
      );
    }, 1_000)
  : undefined;

updatePresentation();
setTileOverlayVisible(false);
setTextureTileOverlayVisible(false);
setEclipseConesVisible(false);
setPreflightCheck(worldCheck, worldCheckStatus, "ready", `${celestialBody(initialFocusBodyId).name} ready`);
errorState.hidden = true;
monitorTileSourceFailures(() => focusedTerrain().getTileFailureTotal());
aircraftLayer.visible = false;
setAircraftEnabled(false);
setAircraftLabelsEnabled(false);
for (const { id } of SATELLITE_GROUPS) {
  satelliteLayer.setGroupVisible(id, false);
}
updateSatelliteReadout();
renderer.setAnimationLoop(render);
