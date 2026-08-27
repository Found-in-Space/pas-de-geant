import "./eclipse.css";

import {
  createRuntime,
  type RuntimeOutput,
} from "@found-in-space/touch-os";
import {
  createPoseAnchoredPanelDriver,
  createThreePanelSession,
  createXrRayPointerSource,
  type ThreeHostPose,
  type ThreePointerPhase,
} from "@found-in-space/touch-os/hosts/three";
import {
  EARTH_MEAN_RADIUS_KM,
  MOON_RADIUS_KM,
  SUN_RADIUS_KM,
  type EclipseSummary,
} from "@found-in-space/shadowline";
import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import {
  freshButtonLatch,
  isHandTrackingInputSource,
} from "./controller-input.js";
import {
  eclipseEarthSurfaceObservation,
  eclipseTopographicAltitudeMetres,
  eclipseTopographicSurfaceRadius,
  trackedHeadWorldPosition,
  trackedHeadWorldQuaternion,
} from "./eclipse-earth-surface.js";
import {
  beginObserverTwoGrip,
  observerProjectedToBodyRadius,
  observerTranslatedForHeadPosition,
  updateObserverEarthOrbit,
  updateObserverTwoGrip,
  type EclipseObserverTransform,
  type ObserverTwoGripGesture,
} from "./eclipse-observer.js";
import {
  eclipseControllerIntent,
  type EclipseControllerIntent,
} from "./eclipse-controller-input.js";
import {
  EclipseLightField,
  EclipseFootprints,
  RetainedShadowCones,
  VISIBLE_SUN_FAR_M,
  VisibleSun,
  createGeodeticEllipsoidGeometry,
  bodyLocalDirection,
  ecefKmToPhysicalMetres,
  ecefToInertialMatrix,
  sunAlignedStageOrientation,
} from "./eclipse-rendering.js";
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
  HAND_PANEL_SURFACE,
  HAND_PANEL_THEME,
  createEclipsePanelRoot,
  eclipsePanelCommand,
  type EclipsePanelState,
} from "./eclipse-panel.js";
import {
  eclipseCameraDepthRange,
  ECLIPSE_DEFAULT_SCALE_DENOMINATOR,
  eclipseRadialDistanceAfterInput,
  eclipseScaleAfterInput,
  headsetPointAfterScaleDenominatorChange,
  type EclipseStageTransform,
  type GripPose,
} from "./eclipse-stage.js";
import {
  eclipseYearFromEventId,
  parseEclipsePlaybackArguments,
  parseEclipseRangeArguments,
  parseEclipseScaleDenominatorArguments,
  parseEclipseSelectionArguments,
  parseEclipseTimeArguments,
} from "./eclipse-tools.js";
import type {
  EclipseContactRange,
  EclipseFrame,
} from "./eclipse-types.js";
import { EclipseWorkerClient } from "./eclipse-worker-client.js";
import {
  parseKnowledgeSearchArguments,
  searchWeb,
  searchWikipedia,
} from "./external-knowledge.js";
import {
  RealtimeVoiceAgent,
  type RealtimeAgentStatus,
} from "./realtime-agent.js";
import type {
  SupervisionCommand,
  SupervisionControlState,
  SupervisionNavigationSnapshot,
} from "./supervision-protocol.js";
import type {
  SupervisionClient,
  SupervisionConnectionStatus,
} from "./supervision-client.js";
import { TerrainSurface, type TerrainSurfaceView } from "./terrain-surface.js";
import { proxiedTileConfiguration } from "./tile-proxy.js";
import {
  displayRadiusMetres,
  formatScaleRatio,
  headsetMetresForPhysicalMetres,
  validScaleDenominator,
} from "./world-scale.js";

const DEFAULT_EVENT_ID = "solar-2026-08-12-total";
const PLAYBACK_RATE = 180;
const GEOMETRY_INTERVAL_MS = 160;
const TERRAIN_VIEW_INTERVAL_MS = 250;
const ECLIPSE_TEXTURE_SCREEN_PIXELS_PER_SOURCE_PIXEL = 0.5;
const METRES_PER_KILOMETRE = 1_000;
const EARTH_REFERENCE_RADIUS_M = EARTH_MEAN_RADIUS_KM * METRES_PER_KILOMETRE;
const MOON_RADIUS_M = MOON_RADIUS_KM * METRES_PER_KILOMETRE;
const SUN_RADIUS_M = SUN_RADIUS_KM * METRES_PER_KILOMETRE;
const INITIAL_EARTH_CENTRE_DISTANCE_M = 3;
const ORBIT_RADIANS_PER_SECOND = 1.35;

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
const eventReadout = element<HTMLElement>("event-readout");
const timeReadout = element<HTMLElement>("time-readout");
const altitudeReadout = element<HTMLElement>("altitude-readout");
const voiceReadout = element<HTMLElement>("voice-readout");
const imageryAttribution = element<HTMLElement>("imagery-attribution");
let handPanelRuntime: ReturnType<typeof createRuntime> | null = null;

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  logarithmicDepthBuffer: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType("local-floor");
renderer.xr.setFramebufferScaleFactor(1);
sceneRoot.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030711);
const camera = new THREE.PerspectiveCamera(
  48,
  window.innerWidth / window.innerHeight,
  0.02,
  VISIBLE_SUN_FAR_M,
);
camera.position.set(0, 1.65, 0);
const observerRig = new THREE.Group();
observerRig.name = "eclipse-observer-rig";
observerRig.add(camera);
scene.add(observerRig);

const modelRoot = new THREE.Group();
modelRoot.name = "eclipse-stage-root";
const physicalRoot = new THREE.Group();
physicalRoot.name = "eclipse-physical-root";
const earthFixedRoot = new THREE.Group();
earthFixedRoot.name = "eclipse-earth-fixed-root";
earthFixedRoot.matrixAutoUpdate = false;
physicalRoot.add(earthFixedRoot);
modelRoot.add(physicalRoot);
scene.add(modelRoot);

scene.add(new THREE.HemisphereLight(0x7998c2, 0x05050a, 0.42));
const sunLight = new THREE.DirectionalLight(0xffe6ae, 3.8);
sunLight.target.position.set(0, 0, 0);
physicalRoot.add(sunLight, sunLight.target);
const lightField = new EclipseLightField();
scene.add(lightField.object);
const visibleSun = new VisibleSun();
scene.add(visibleSun.object);

const textureLoader = new THREE.TextureLoader();
const [earthTexture, moonTexture] = await Promise.all([
  textureLoader.loadAsync(`${import.meta.env.BASE_URL}bluemarble-2048.png`),
  textureLoader.loadAsync(`${import.meta.env.BASE_URL}lroc-color-2k.jpg`),
]);
earthTexture.colorSpace = THREE.SRGBColorSpace;
earthTexture.flipY = false;
earthTexture.wrapS = THREE.RepeatWrapping;
earthTexture.wrapT = THREE.ClampToEdgeWrapping;
earthTexture.needsUpdate = true;
earthTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
moonTexture.colorSpace = THREE.SRGBColorSpace;
moonTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const eclipseParameters = new URLSearchParams(window.location.search);
const baseImageryConfiguration = imageryConfiguration();
const selectedImageryConfiguration = baseImageryConfiguration
  ? selectImageryVariant(
      baseImageryConfiguration,
      eclipseParameters.get(MAPTILER_IMAGERY_VARIANT_PARAMETER),
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
imageryAttribution.textContent = photographicImageryProvider
  ? ` · ${photographicImageryProvider.attribution}`
  : "";

const earth = new THREE.Mesh(
  createGeodeticEllipsoidGeometry(192, 96),
  new THREE.MeshStandardMaterial({
    map: earthTexture,
    roughness: 0.94,
    metalness: 0.01,
    emissive: 0x07111a,
    emissiveMap: earthTexture,
    emissiveIntensity: 0.16,
  }),
);
earth.name = "eclipse-earth";
earth.scale.setScalar(EARTH_REFERENCE_RADIUS_M);
earthFixedRoot.add(earth);
const atmosphere = new THREE.Mesh(
  createGeodeticEllipsoidGeometry(96, 48, 100),
  new THREE.MeshBasicMaterial({
    color: 0x79ddeb,
    transparent: true,
    opacity: 0.095,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
atmosphere.name = "eclipse-atmosphere";
atmosphere.scale.setScalar(EARTH_REFERENCE_RADIUS_M);
earthFixedRoot.add(atmosphere);

const moon = new THREE.Mesh(
  new THREE.SphereGeometry(1, 64, 40),
  new THREE.MeshStandardMaterial({
    map: moonTexture,
    roughness: 1,
    metalness: 0,
    emissive: 0x080808,
    emissiveMap: moonTexture,
    emissiveIntensity: 0.12,
  }),
);
moon.name = "eclipse-moon";
moon.scale.setScalar(MOON_RADIUS_M);
physicalRoot.add(moon);
const cones = new RetainedShadowCones();
physicalRoot.add(cones.group);
const footprints = new EclipseFootprints();
earthFixedRoot.add(footprints.group);

interface ExperienceState {
  event: EclipseSummary;
  contacts: EclipseContactRange;
  atMs: number;
  playing: boolean;
  panelVisible: boolean;
  voice: RealtimeAgentStatus;
  frame: EclipseFrame;
  stage: EclipseStageTransform;
  /** Render-boundary transform for the unscaled XR reference space. */
  observerRigTransform: EclipseObserverTransform;
  /** Authoritative observer position in stage-local physical metres. */
  observerPhysicalPositionM: THREE.Vector3;
}

const worker = new EclipseWorkerClient();
const eventCache = new Map<string, EclipseSummary>();
const initialEvents = await worker.events(
  "2026-08-12T00:00:00Z",
  "2026-08-13T00:00:00Z",
);
for (const event of initialEvents) eventCache.set(event.id, event);
const initialEvent = initialEvents.find(({ id }) => id === DEFAULT_EVENT_ID);
if (!initialEvent) throw new Error(`Shadowline did not find ${DEFAULT_EVENT_ID}.`);
const [initialContacts, initialFrame] = await Promise.all([
  worker.contacts(initialEvent),
  worker.latest(initialEvent, initialEvent.peakUtc),
]);
const state: ExperienceState = {
  event: initialEvent,
  contacts: initialContacts,
  atMs: Date.parse(initialFrame.atUtc),
  playing: false,
  panelVisible: true,
  voice: { state: "off", detail: "Press A to wake" },
  frame: initialFrame,
  stage: {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scaleDenominator: ECLIPSE_DEFAULT_SCALE_DENOMINATOR,
  },
  observerRigTransform: {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  },
  observerPhysicalPositionM: new THREE.Vector3(),
};
let latestTopographicAltitudeMetres = Number.NaN;
let gestureCount = 0;
let twoGripHeadsetRadiusM = 0;
let twoGripGesture: ObserverTwoGripGesture | null = null;

let inertialToStage: THREE.Matrix4 | null = null;
const stageToEarthFixed = new THREE.Matrix4();
const moonStagePosition = new THREE.Vector3();
const sunStagePosition = new THREE.Vector3();
const sunWorldPosition = new THREE.Vector3();
const shadowAxisStage = new THREE.Vector3(1, 0, 0);
const earthWorldPosition = new THREE.Vector3();
const eclipseSunlightDirection = new THREE.Vector3();
let shadowConeLengthPhysicalM = 0;

function updateSceneFrame(frame: EclipseFrame): void {
  const ecefToInertial = ecefToInertialMatrix(frame.ecefToEquatorialJ2000);
  if (!inertialToStage) {
    const earthFromSun = ecefKmToPhysicalMetres(frame.sunEcefKm)
      .applyMatrix4(ecefToInertial)
      .multiplyScalar(-1);
    inertialToStage = sunAlignedStageOrientation(earthFromSun);
  }
  const earthFixedToStage = inertialToStage.clone().multiply(ecefToInertial);
  stageToEarthFixed.copy(earthFixedToStage).invert();
  earthFixedRoot.matrix.copy(earthFixedToStage);
  earthFixedRoot.matrixWorldNeedsUpdate = true;
  moonStagePosition.copy(
    ecefKmToPhysicalMetres(frame.moonEcefKm).applyMatrix4(earthFixedToStage),
  );
  sunStagePosition.copy(
    ecefKmToPhysicalMetres(frame.sunEcefKm).applyMatrix4(earthFixedToStage),
  );
  shadowAxisStage.copy(
    bodyLocalDirection(frame.direction)
      .transformDirection(earthFixedToStage)
      .normalize(),
  );
  moon.position.copy(moonStagePosition);
  moon.quaternion.setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    moonStagePosition.clone().negate().normalize(),
  );
  const coneLengthPhysicalM =
    frame.axisDistanceToEarthPlaneKm * METRES_PER_KILOMETRE +
    2.3 * EARTH_REFERENCE_RADIUS_M;
  shadowConeLengthPhysicalM = coneLengthPhysicalM;
  cones.update({
    moonPosition: moonStagePosition,
    shadowAxis: shadowAxisStage,
    physicalLengthM: coneLengthPhysicalM,
    centralConeSlope: frame.centralConeSlope,
    penumbraConeSlope: frame.penumbraConeSlope,
    coneToEarthFixed: stageToEarthFixed,
  });
  footprints.update(frame.penumbraRings, frame.centralRings);
  sunLight.position.copy(sunStagePosition);
}

function commitScaleDenominator(
  scaleDenominator: number,
  position = new THREE.Vector3(),
  quaternion = new THREE.Quaternion(),
): void {
  state.stage = {
    position: position.clone(),
    quaternion: quaternion.clone().normalize(),
    scaleDenominator,
  };
  modelRoot.position.copy(state.stage.position);
  modelRoot.quaternion.copy(state.stage.quaternion);
  modelRoot.scale.setScalar(1 / scaleDenominator);
  modelRoot.updateMatrixWorld(true);
}

function syncObserverPhysicalPosition(
  viewCamera = currentViewCamera(),
): void {
  eclipseHeadWorldPose(viewCamera, state.observerPhysicalPositionM);
  modelRoot.worldToLocal(state.observerPhysicalPositionM);
}

function commitObserverRigTransform(transform: EclipseObserverTransform): void {
  state.observerRigTransform = {
    position: transform.position.clone(),
    quaternion: transform.quaternion.clone().normalize(),
  };
  observerRig.position.copy(state.observerRigTransform.position);
  observerRig.quaternion.copy(state.observerRigTransform.quaternion);
  observerRig.scale.set(1, 1, 1);
  observerRig.updateMatrixWorld(true);
  syncObserverPhysicalPosition();
}

function currentViewCamera(): THREE.Camera {
  return renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
}

function earthCentreWorld(target = new THREE.Vector3()): THREE.Vector3 {
  modelRoot.updateWorldMatrix(true, false);
  return modelRoot.getWorldPosition(target);
}

function resetEarthOrbit(): void {
  gestureCount = 0;
  twoGripGesture = null;
  commitScaleDenominator(ECLIPSE_DEFAULT_SCALE_DENOMINATOR);
  const headQuaternion = new THREE.Quaternion();
  const headPosition = eclipseHeadWorldPose(
    currentViewCamera(),
    new THREE.Vector3(),
    headQuaternion,
  );
  const desiredHeadPosition = earthCentreWorld()
    .addScaledVector(
      new THREE.Vector3(0, 0, -1).applyQuaternion(headQuaternion),
      -INITIAL_EARTH_CENTRE_DISTANCE_M,
    );
  commitObserverRigTransform(observerTranslatedForHeadPosition(
    state.observerRigTransform,
    headPosition,
    desiredHeadPosition,
  ));
  syncPresentation();
}

function resetEclipseStage(): Record<string, unknown> {
  resetEarthOrbit();
  enforceTopographicFloor(currentViewCamera());
  return eclipseStateReadback();
}

function setScaleDenominator(scaleDenominator: number): void {
  validScaleDenominator(scaleDenominator);
  const viewCamera = currentViewCamera();
  const headPosition = eclipseHeadWorldPose(viewCamera, new THREE.Vector3());
  const earthCentre = earthCentreWorld();
  const scaleRatio = state.stage.scaleDenominator / scaleDenominator;
  if (gestureCount === 2) twoGripHeadsetRadiusM *= scaleRatio;
  const desiredHeadPosition = headsetPointAfterScaleDenominatorChange(
    headPosition,
    earthCentre,
    state.stage.scaleDenominator,
    scaleDenominator,
  );
  commitScaleDenominator(
    scaleDenominator,
    state.stage.position,
    state.stage.quaternion,
  );
  commitObserverRigTransform(observerTranslatedForHeadPosition(
    state.observerRigTransform,
    headPosition,
    desiredHeadPosition,
  ));
  syncPresentation();
}

function setEclipseScaleDenominator(
  scaleDenominator: number,
): Record<string, unknown> {
  setScaleDenominator(scaleDenominator);
  return eclipseStateReadback();
}

const terrainHeadWorldPosition = new THREE.Vector3();
const terrainHeadEarthFixed = new THREE.Vector3();
const terrainDrawingBufferSize = new THREE.Vector2();

function eclipseHeadWorldPose(
  viewCamera: THREE.Camera,
  positionTarget: THREE.Vector3,
  quaternionTarget?: THREE.Quaternion,
): THREE.Vector3 {
  if (
    renderer.xr.isPresenting &&
    viewCamera instanceof THREE.ArrayCamera &&
    viewCamera.cameras.length > 0
  ) {
    // The XR eye cameras contain the current reference-space poses. Their
    // matrixWorld values are not composed with observerRig until render(), so
    // compose their midpoint explicitly and never updateWorldMatrix() here.
    observerRig.updateWorldMatrix(true, false);
    const position = trackedHeadWorldPosition(
      viewCamera.cameras.map((eyeCamera) => eyeCamera.position),
      observerRig.matrixWorld,
      positionTarget,
    );
    if (quaternionTarget) {
      trackedHeadWorldQuaternion(
        viewCamera.quaternion,
        state.observerRigTransform.quaternion,
        quaternionTarget,
      );
    }
    return position;
  }
  camera.updateWorldMatrix(true, false);
  if (quaternionTarget) camera.getWorldQuaternion(quaternionTarget);
  return camera.getWorldPosition(positionTarget);
}

function eclipseHeadReferencePosition(
  viewCamera: THREE.Camera,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  if (
    renderer.xr.isPresenting &&
    viewCamera instanceof THREE.ArrayCamera &&
    viewCamera.cameras.length > 0
  ) {
    target.set(0, 0, 0);
    for (const eyeCamera of viewCamera.cameras) target.add(eyeCamera.position);
    return target.multiplyScalar(1 / viewCamera.cameras.length);
  }
  return target.copy(camera.position);
}

function headWorldPositionForObserver(
  viewCamera: THREE.Camera,
  observer: EclipseObserverTransform,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return eclipseHeadReferencePosition(viewCamera, target)
    .applyQuaternion(observer.quaternion)
    .add(observer.position);
}

function terrainFocalLengthPixels(viewCamera: THREE.Camera): number {
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
  return Math.max(1, focalLengthPixels);
}

function eclipseTerrainView(viewCamera: THREE.Camera): {
  view: TerrainSurfaceView;
  observation: ReturnType<typeof eclipseEarthSurfaceObservation>;
} {
  eclipseHeadWorldPose(viewCamera, terrainHeadWorldPosition);
  terrainHeadEarthFixed.copy(terrainHeadWorldPosition);
  earthFixedRoot.worldToLocal(terrainHeadEarthFixed);
  const observation = eclipseEarthSurfaceObservation(terrainHeadEarthFixed);
  return {
    view: {
      latitudeDegrees: observation.latitudeDegrees,
      longitudeDegrees: observation.longitudeDegrees,
      displayRadiusM: displayRadiusMetres(
        EARTH_REFERENCE_RADIUS_M,
        state.stage.scaleDenominator,
      ),
      radialMultiplier: 1,
      observerHeightWorldM: headsetMetresForPhysicalMetres(
        observation.headDistancePhysicalM,
        state.stage.scaleDenominator,
      ),
      focalLengthPixels: terrainFocalLengthPixels(viewCamera),
    },
    observation,
  };
}

updateSceneFrame(initialFrame);
resetEarthOrbit();
const initialTerrainView = eclipseTerrainView(camera);
let latestEarthSurfaceObservation = initialTerrainView.observation;
latestTopographicAltitudeMetres = Math.max(
  0,
  eclipseTopographicAltitudeMetres(initialTerrainView.observation, 0),
);
const terrain = new TerrainSurface({
  renderer,
  baseTexture: earthTexture,
  imageryProvider: photographicImageryProvider,
  initialView: initialTerrainView.view,
});
terrain.setTilePixelRatio({
  target: "textures",
  screenPixelsPerSourcePixel:
    ECLIPSE_TEXTURE_SCREEN_PIXELS_PER_SOURCE_PIXEL,
});
earthFixedRoot.add(terrain.group);
terrain.group.scale.setScalar(EARTH_REFERENCE_RADIUS_M);
terrain.group.visible = false;
scene.onBeforeRender = (_renderer, _scene, renderCamera): void => {
  terrain.updateRenderVisibility(renderCamera);
};
let previousTerrainViewMs = Number.NEGATIVE_INFINITY;
const topographicHeadEarthFixed = new THREE.Vector3();

function topographicHeadState(headWorldPosition: THREE.Vector3): {
  observation: ReturnType<typeof eclipseEarthSurfaceObservation>;
  floorRadiusWorldM: number;
  altitudeMetres: number;
} {
  topographicHeadEarthFixed.copy(headWorldPosition);
  earthFixedRoot.worldToLocal(topographicHeadEarthFixed);
  const observation = eclipseEarthSurfaceObservation(topographicHeadEarthFixed);
  const elevationMetres = terrain.sampleElevationMetres(
    observation.latitudeDegrees,
    observation.longitudeDegrees,
  );
  return {
    observation,
    floorRadiusWorldM: headsetMetresForPhysicalMetres(
      eclipseTopographicSurfaceRadius(observation, elevationMetres),
      state.stage.scaleDenominator,
    ),
    altitudeMetres: Math.max(
      0,
      eclipseTopographicAltitudeMetres(observation, elevationMetres),
    ),
  };
}

function enforceTopographicFloor(viewCamera: THREE.Camera): void {
  const headWorldPosition = eclipseHeadWorldPose(
    viewCamera,
    new THREE.Vector3(),
  );
  const earthCentre = earthCentreWorld();
  let surface = topographicHeadState(headWorldPosition);
  const centreDistance = headWorldPosition.distanceTo(earthCentre);
  if (centreDistance < surface.floorRadiusWorldM) {
    commitObserverRigTransform(observerProjectedToBodyRadius(
      state.observerRigTransform,
      headWorldPosition,
      earthCentre,
      surface.floorRadiusWorldM,
    ));
    eclipseHeadWorldPose(viewCamera, headWorldPosition);
    surface = topographicHeadState(headWorldPosition);
  }
  const altitudeChanged =
    Math.abs(latestTopographicAltitudeMetres - surface.altitudeMetres) >= 0.1;
  latestEarthSurfaceObservation = surface.observation;
  latestTopographicAltitudeMetres = surface.altitudeMetres;
  if (altitudeChanged) syncPresentation();
}

function updateEclipseTerrain(
  nowMs: number,
  viewCamera: THREE.Camera,
): void {
  if (nowMs - previousTerrainViewMs < TERRAIN_VIEW_INTERVAL_MS) return;
  previousTerrainViewMs = nowMs;
  const next = eclipseTerrainView(viewCamera);
  latestEarthSurfaceObservation = next.observation;
  terrain.update(next.view);
}

let frameCommitSequence = 0;
let selectionSequence = 0;
let requestedPlaybackTimeMs = state.atMs;

async function setTimeUtc(utc: string): Promise<Record<string, unknown>> {
  const timeMs = Date.parse(utc);
  if (!Number.isFinite(timeMs)) throw new Error("Invalid eclipse UTC.");
  const peakMs = Date.parse(state.event.peakUtc);
  if (Math.abs(timeMs - peakMs) > 24 * 60 * 60 * 1_000) {
    throw new Error("Eclipse time must be within 24 hours of global peak.");
  }
  requestedPlaybackTimeMs = timeMs;
  frameCommitSequence += 1;
  const sequence = frameCommitSequence;
  const frame = await worker.latest(state.event, new Date(timeMs).toISOString());
  if (sequence !== frameCommitSequence || frame.event.id !== state.event.id) {
    return eclipseStateReadback();
  }
  state.frame = frame;
  state.atMs = Date.parse(frame.atUtc);
  updateSceneFrame(frame);
  enforceTopographicFloor(currentViewCamera());
  syncPresentation();
  return eclipseStateReadback();
}

function setPlaying(playing: boolean): Record<string, unknown> {
  state.playing = playing;
  requestedPlaybackTimeMs = state.atMs;
  syncPresentation();
  return eclipseStateReadback();
}

async function findEclipses(
  startUtc: string,
  endUtc: string,
): Promise<EclipseSummary[]> {
  const events = await worker.events(startUtc, endUtc);
  for (const event of events) eventCache.set(event.id, event);
  return events;
}

async function verifiedEvent(eventId: string): Promise<EclipseSummary> {
  const cached = eventCache.get(eventId);
  if (cached) return cached;
  const year = eclipseYearFromEventId(eventId);
  if (year === null) throw new Error("Unrecognized solar eclipse event_id.");
  const events = await findEclipses(
    `${String(year).padStart(4, "0")}-01-01T00:00:00Z`,
    `${String(year + 1).padStart(4, "0")}-01-01T00:00:00Z`,
  );
  const event = events.find(({ id }) => id === eventId);
  if (!event) throw new Error(`Shadowline did not verify ${eventId}.`);
  return event;
}

async function selectEvent(eventId: string): Promise<Record<string, unknown>> {
  selectionSequence += 1;
  const sequence = selectionSequence;
  const event = await verifiedEvent(eventId);
  const [contacts, frame] = await Promise.all([
    worker.contacts(event),
    worker.latest(event, event.peakUtc),
  ]);
  if (sequence !== selectionSequence) return eclipseStateReadback();
  frameCommitSequence += 1;
  state.event = event;
  state.contacts = contacts;
  state.frame = frame;
  state.atMs = Date.parse(frame.atUtc);
  requestedPlaybackTimeMs = state.atMs;
  state.playing = false;
  inertialToStage = null;
  updateSceneFrame(frame);
  resetEarthOrbit();
  enforceTopographicFloor(currentViewCamera());
  return eclipseStateReadback();
}

function eclipseStateReadback(): Record<string, unknown> {
  const frame = state.frame;
  syncObserverPhysicalPosition();
  const earthCentreDistancePhysicalM =
    state.observerPhysicalPositionM.length();
  const earthCentreDistanceHeadsetM = headsetMetresForPhysicalMetres(
    earthCentreDistancePhysicalM,
    state.stage.scaleDenominator,
  );
  return {
    event_id: state.event.id,
    eclipse_kind: state.event.kind,
    peak_utc: state.event.peakUtc,
    at_utc: new Date(state.atMs).toISOString(),
    contact_start_utc: state.contacts.startUtc,
    contact_end_utc: state.contacts.endUtc,
    playing: state.playing,
    playback_rate: PLAYBACK_RATE,
    navigation: "earth-orbital",
    earth_center_distance_physical_metres: earthCentreDistancePhysicalM,
    earth_center_distance_headset_metres: earthCentreDistanceHeadsetM,
    altitude_above_terrain_m: latestTopographicAltitudeMetres,
    scale_denominator: state.stage.scaleDenominator,
    central_shadow: frame.centralKind,
    penumbra_visible: frame.penumbraRings.length > 0,
  };
}

function eclipseSupervisionNavigationState(): SupervisionNavigationSnapshot {
  return {
    mode: "orbit",
    focusBody: "earth",
    latitudeDegrees: latestEarthSurfaceObservation.latitudeDegrees,
    longitudeDegrees: latestEarthSurfaceObservation.longitudeDegrees,
    scaleDenominator: state.stage.scaleDenominator,
    radialMultiplier: 1,
    headingDegrees: null,
  };
}

function eclipseSupervisionControlState(): SupervisionControlState {
  return {
    aircraft: {
      aircraft: false,
      labels: false,
    },
    satellites: {
      brightest: false,
      space_stations: false,
      science_education: false,
    },
    eclipse: {
      active: true,
      playing: state.playing,
      eventId: state.event.id,
      eventKind: state.event.kind,
      peakUtc: state.event.peakUtc,
      contactStartUtc: state.contacts.startUtc,
      contactEndUtc: state.contacts.endUtc,
      atUtc: new Date(state.atMs).toISOString(),
      playbackRate: PLAYBACK_RATE,
    },
  };
}

async function applyEclipseSupervisionCommand(
  command: SupervisionCommand,
): Promise<void> {
  if (command.kind === "setEclipsePlayback") {
    setPlaying(command.playing);
    return;
  }
  if (command.kind === "setEclipseTime") {
    await setTimeUtc(command.utc);
    return;
  }
  throw new Error("This command requires an immersive Earth surface session.");
}

let supervisionClient: SupervisionClient | undefined;
let supervisionClientModule: Promise<typeof import("./supervision-client.js")> |
  undefined;
let supervisionSessionGeneration = 0;
const supervisionSessionLabel = eclipseParameters.get("sessionLabel")?.trim() ||
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
    if (
      generation !== supervisionSessionGeneration ||
      !renderer.xr.isPresenting
    ) {
      return;
    }
    supervisionClient ??= new Client({
      readState: eclipseSupervisionNavigationState,
      readControlState: eclipseSupervisionControlState,
      readPinState: () => ({ pins: [], guidedPinIds: [] }),
      applyCommand: applyEclipseSupervisionCommand,
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

function timeFraction(): number {
  const start = Date.parse(state.contacts.startUtc);
  const end = Date.parse(state.contacts.endUtc);
  return Math.max(0, Math.min(1, (state.atMs - start) / (end - start)));
}

function frameStatus(): string {
  if (state.frame.centralKind === "umbra") return "Umbra reaches Earth";
  if (state.frame.centralKind === "antumbra") return "Antumbra reaches Earth";
  return state.frame.penumbraRings.length > 0
    ? "Penumbra only"
    : "Shadow misses Earth";
}

function panelState(): EclipsePanelState {
  return {
    eventLabel: `${formatEventKind(state.event.kind)} · ${formatEventDate(state.event.peakUtc)}`,
    atUtc: new Date(state.atMs).toISOString(),
    status: frameStatus(),
    timeFraction: timeFraction(),
    playing: state.playing,
    altitudeAboveTerrainMetres: latestTopographicAltitudeMetres,
    scaleDenominator: state.stage.scaleDenominator,
    voiceState: state.voice.state,
  };
}

function formatEventKind(kind: EclipseSummary["kind"]): string {
  return kind[0]!.toUpperCase() + kind.slice(1) + " solar eclipse";
}

function formatEventDate(utc: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(utc));
}

let panelSignature = "";
let lastPanelRedrawMs = Number.NEGATIVE_INFINITY;

function syncPresentation(nowMs = performance.now()): void {
  eventReadout.textContent =
    `${formatEventKind(state.event.kind)} · ${formatEventDate(state.event.peakUtc)}`;
  timeReadout.textContent = new Date(state.atMs).toISOString().replace("T", " ").replace(".000Z", "Z");
  altitudeReadout.textContent =
    `${formatPhysicalAltitude(latestTopographicAltitudeMetres)} · ` +
    formatScaleRatio(state.stage.scaleDenominator);
  voiceReadout.textContent = state.voice.detail;
  document.body.dataset.eventId = state.event.id;
  document.body.dataset.eclipseUtc = new Date(state.atMs).toISOString();
  document.body.dataset.eclipseNavigation = "earth-orbital";
  document.body.dataset.eclipseAltitudeMetres =
    String(latestTopographicAltitudeMetres);
  document.body.dataset.eclipseScaleDenominator =
    String(state.stage.scaleDenominator);
  document.body.dataset.eclipsePlaying = String(state.playing);
  const panelRuntime = handPanelRuntime;
  if (!panelRuntime) return;
  const nextPanelState = panelState();
  const signature = JSON.stringify(nextPanelState);
  if (signature === panelSignature || nowMs - lastPanelRedrawMs < 50) return;
  panelSignature = signature;
  lastPanelRedrawMs = nowMs;
  panelRuntime.setRoot(createEclipsePanelRoot(nextPanelState));
}

function formatPhysicalAltitude(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const metres = Math.max(0, value);
  if (metres < 1_000) return `${metres.toFixed(0)} m above terrain`;
  return `${(metres / 1_000).toLocaleString("en-GB", {
    maximumFractionDigits: metres < 1_000_000 ? 1 : 0,
  })} km above terrain`;
}

const realtimeAudio = document.createElement("audio");
realtimeAudio.autoplay = true;
realtimeAudio.setAttribute("playsinline", "");
realtimeAudio.hidden = true;
document.body.append(realtimeAudio);

function setRealtimeAudioStream(stream: MediaStream | null): void {
  realtimeAudio.srcObject = stream;
  if (!stream) {
    realtimeAudio.pause();
    return;
  }
  void realtimeAudio.play().catch((error) => {
    console.warn("Realtime audio playback was blocked:", error);
  });
}

const voiceAgent = new RealtimeVoiceAgent({
  tokenEndpoint: "/api/realtime/token?experience=eclipse",
  greetingInstructions:
    "Greet the user warmly in one short sentence and invite them to choose or explore a solar eclipse. Do not call a tool in this greeting.",
  onStatus(status) {
    state.voice = status;
    panelSignature = "";
    syncPresentation();
  },
  onRemoteStream: setRealtimeAudioStream,
  tools: {
    get_eclipse_state() {
      return eclipseStateReadback();
    },
    async find_solar_eclipses(argumentsValue) {
      const range = parseEclipseRangeArguments(argumentsValue);
      const events = await findEclipses(range.startUtc, range.endUtc);
      return { events };
    },
    async select_solar_eclipse(argumentsValue) {
      return await selectEvent(parseEclipseSelectionArguments(argumentsValue));
    },
    async set_eclipse_time(argumentsValue) {
      return await setTimeUtc(parseEclipseTimeArguments(argumentsValue));
    },
    set_eclipse_playback(argumentsValue) {
      return setPlaying(parseEclipsePlaybackArguments(argumentsValue));
    },
    set_eclipse_scale(argumentsValue) {
      return setEclipseScaleDenominator(
        parseEclipseScaleDenominatorArguments(argumentsValue),
      );
    },
    reset_eclipse_stage() {
      return resetEclipseStage();
    },
    async search_wikipedia(argumentsValue) {
      return await searchWikipedia(
        parseKnowledgeSearchArguments(argumentsValue).query,
      );
    },
    async search_web(argumentsValue) {
      return await searchWeb(parseKnowledgeSearchArguments(argumentsValue).query);
    },
  },
});

interface ControllerBinding {
  controller: THREE.Group;
  grip: THREE.Group;
  inputSource?: XRInputSource;
  ray: THREE.Line;
  reticle: THREE.Mesh;
}

function controllerRay(): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(),
    new THREE.Vector3(0, 0, -4),
  ]);
  const material = new THREE.LineBasicMaterial({
    color: 0x76ddf1,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
  });
  const line = new THREE.Line(geometry, material);
  line.visible = false;
  return line;
}

function controllerReticle(): THREE.Mesh {
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.007, 0.011, 24),
    new THREE.MeshBasicMaterial({
      color: 0xb7f5ff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  reticle.renderOrder = 102;
  reticle.visible = false;
  return reticle;
}

const controllerBindings: ControllerBinding[] = [0, 1].map((index) => {
  const controller = renderer.xr.getController(index);
  const grip = renderer.xr.getControllerGrip(index);
  const ray = controllerRay();
  const reticle = controllerReticle();
  controller.add(ray, reticle);
  const binding: ControllerBinding = { controller, grip, ray, reticle };
  controller.addEventListener("connected", (event) => {
    const source = (event as THREE.Event & { data?: XRInputSource }).data;
    binding.inputSource = source && !isHandTrackingInputSource(source)
      ? source
      : undefined;
  });
  controller.addEventListener("disconnected", () => {
    binding.inputSource = undefined;
  });
  observerRig.add(controller, grip);
  return binding;
});

function bindingForHand(handedness: XRHandedness): ControllerBinding | undefined {
  return controllerBindings.find(
    (binding) => binding.inputSource?.handedness === handedness,
  );
}

const pointerOrigin = new THREE.Vector3();
const pointerQuaternion = new THREE.Quaternion();
const pointerDirection = new THREE.Vector3();
let pointerPressed = false;
const panelPointerSource = createXrRayPointerSource(() => {
  const binding = bindingForHand("right");
  if (!binding?.inputSource) {
    pointerPressed = false;
    return undefined;
  }
  binding.controller.getWorldPosition(pointerOrigin);
  binding.controller.getWorldQuaternion(pointerQuaternion);
  pointerDirection.set(0, 0, -1).applyQuaternion(pointerQuaternion).normalize();
  const pressed = (binding.inputSource.gamepad?.buttons[0]?.value ?? 0) > 0.55;
  const phase: ThreePointerPhase = pressed && !pointerPressed
    ? "down"
    : !pressed && pointerPressed
      ? "up"
      : "move";
  pointerPressed = pressed;
  return {
    pointerId: "eclipse-right-ray",
    pointerType: "ray" as const,
    phase,
    timestamp: performance.now(),
    sourceId: "right-controller",
    handedness: binding.inputSource.handedness,
    pressure: pressed ? 1 : 0,
    origin: pointerOrigin,
    direction: pointerDirection,
  };
});

const panelRuntime = createRuntime({
  root: createEclipsePanelRoot(panelState()),
  surface: HAND_PANEL_SURFACE,
  theme: HAND_PANEL_THEME,
});
handPanelRuntime = panelRuntime;
const handPanelRoot = new THREE.Group();
scene.add(handPanelRoot);
const handPanelDriver = createPoseAnchoredPanelDriver({
  runtime: panelRuntime,
  parent: handPanelRoot,
  surface: HAND_PANEL_SURFACE,
  panelWidth: 0.36,
  panelHeight: 0.225,
  tiltRadians: -Math.PI * 0.24,
  offset: { x: 0.05, y: 0.055, z: -0.035 },
  depthTest: false,
  depthWrite: false,
  renderOrder: 100,
  pointerClaimPolicy: "block-on-hit",
  pointerSources: [panelPointerSource],
  textureQuality: {
    anisotropy: Math.min(4, renderer.capabilities.getMaxAnisotropy()),
  },
});

async function handlePanelOutput(output: RuntimeOutput): Promise<void> {
  const command = eclipsePanelCommand(output);
  if (!command) return;
  if (command.type === "toggle-playback") {
    setPlaying(!state.playing);
  } else if (command.type === "reset-stage") {
    resetEclipseStage();
  } else if (command.type === "toggle-voice") {
    await voiceAgent.toggle();
  } else {
    const start = Date.parse(state.contacts.startUtc);
    const end = Date.parse(state.contacts.endUtc);
    setPlaying(false);
    await setTimeUtc(new Date(start + (end - start) * command.value).toISOString());
  }
}

const handPanel = createThreePanelSession({
  key: "pas-de-geant-eclipse-controls",
  runtime: panelRuntime,
  driver: handPanelDriver,
  enabled: false,
  outputHandler(output) {
    void handlePanelOutput(output);
  },
});
handPanel.attach();

const handPanelAnchorPosition = new THREE.Vector3();
const handPanelAnchorQuaternion = new THREE.Quaternion();
function handPanelAnchorPose(): ThreeHostPose | undefined {
  const binding = bindingForHand("left");
  if (!binding?.inputSource) return undefined;
  binding.grip.getWorldPosition(handPanelAnchorPosition);
  binding.grip.getWorldQuaternion(handPanelAnchorQuaternion);
  return {
    position: handPanelAnchorPosition,
    orientation: handPanelAnchorQuaternion,
  };
}

function updateHandPanel(nowMs: number, viewCamera: THREE.Camera): void {
  const anchorPose = handPanelAnchorPose();
  const enabled = renderer.xr.isPresenting && state.panelVisible && !!anchorPose;
  handPanel.enabled = enabled;
  const right = bindingForHand("right");
  if (right) right.ray.visible = enabled;
  if (!enabled || !anchorPose) {
    if (right) right.reticle.visible = false;
    return;
  }
  syncPresentation(nowMs);
  handPanel.update({
    timestamp: nowMs,
    camera: viewCamera,
    anchorPose,
  });
  const hit = handPanelDriver.getHit();
  if (right) {
    const position = right.ray.geometry.getAttribute("position") as THREE.BufferAttribute;
    const hitLength = hit?.length ?? 4;
    position.setZ(1, -hitLength);
    position.needsUpdate = true;
    right.reticle.position.set(0, 0, -hitLength);
    right.reticle.visible = !!hit;
  }
}

const firstGripPose: GripPose = {
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
};
const secondGripPose: GripPose = {
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
};

function readGripReferencePose(
  binding: ControllerBinding,
  target: GripPose,
): GripPose {
  target.position.copy(binding.grip.position);
  target.quaternion.copy(binding.grip.quaternion);
  return target;
}

function updateObserverGripNavigation(viewCamera: THREE.Camera): void {
  const active = controllerBindings.filter((binding) =>
    binding.inputSource &&
    (binding.inputSource.gamepad?.buttons[1]?.value ?? 0) > 0.55
  );
  const nextCount = Math.min(2, active.length);
  if (nextCount !== gestureCount) {
    gestureCount = nextCount;
    twoGripGesture = null;
    if (nextCount === 2) {
      twoGripGesture = beginObserverTwoGrip(
        readGripReferencePose(active[0]!, firstGripPose),
        readGripReferencePose(active[1]!, secondGripPose),
        state.observerRigTransform,
      );
      twoGripHeadsetRadiusM = eclipseHeadWorldPose(
        viewCamera,
        new THREE.Vector3(),
      ).distanceTo(earthCentreWorld());
    }
  }
  if (nextCount === 2 && twoGripGesture) {
    const candidate = updateObserverTwoGrip(
      twoGripGesture,
      readGripReferencePose(active[0]!, firstGripPose),
      readGripReferencePose(active[1]!, secondGripPose),
    );
    const candidateHeadPosition = headWorldPositionForObserver(
      viewCamera,
      candidate,
    );
    const earthCentre = earthCentreWorld();
    const floorRadius = topographicHeadState(candidateHeadPosition)
      .floorRadiusWorldM;
    commitObserverRigTransform(observerProjectedToBodyRadius(
      candidate,
      candidateHeadPosition,
      earthCentre,
      Math.max(twoGripHeadsetRadiusM, floorRadius),
    ));
    syncPresentation();
  }
}

const observerViewQuaternion = new THREE.Quaternion();
const observerHeadPosition = new THREE.Vector3();
function updateObserverOrbit(
  elapsedSeconds: number,
  viewCamera: THREE.Camera,
  intent: EclipseControllerIntent,
): void {
  if (gestureCount === 2) return;
  const magnitude = Math.hypot(intent.orbitX, intent.orbitY);
  if (magnitude === 0) return;
  const normalizedMagnitude = Math.min(1, magnitude);
  const radiansPerAxis =
    normalizedMagnitude / magnitude * ORBIT_RADIANS_PER_SECOND * elapsedSeconds;
  eclipseHeadWorldPose(
    viewCamera,
    observerHeadPosition,
    observerViewQuaternion,
  );
  commitObserverRigTransform(updateObserverEarthOrbit(
    state.observerRigTransform,
    observerHeadPosition,
    observerViewQuaternion,
    earthCentreWorld(),
    intent.orbitX * radiansPerAxis,
    intent.orbitY * radiansPerAxis,
  ));
  syncPresentation();
}

function updateObserverAltitude(
  elapsedSeconds: number,
  viewCamera: THREE.Camera,
  axis: number,
): void {
  if (axis === 0) return;
  eclipseHeadWorldPose(viewCamera, observerHeadPosition);
  const earthCentre = earthCentreWorld();
  const surface = topographicHeadState(observerHeadPosition);
  const desiredRadius = Math.max(
    surface.floorRadiusWorldM,
    eclipseRadialDistanceAfterInput(
      observerHeadPosition.distanceTo(earthCentre),
      axis,
      elapsedSeconds,
    ),
  );
  if (gestureCount === 2) twoGripHeadsetRadiusM = desiredRadius;
  commitObserverRigTransform(observerProjectedToBodyRadius(
    state.observerRigTransform,
    observerHeadPosition,
    earthCentre,
    desiredRadius,
  ));
  syncPresentation();
}

const buttonLatch = freshButtonLatch();
function updateControllerButtons(): EclipseControllerIntent | undefined {
  const session = renderer.xr.getSession();
  if (!session) return undefined;
  const intent = eclipseControllerIntent(session, buttonLatch);
  if (intent.toggleVoice) void voiceAgent.toggle();
  if (intent.resetStage) resetEclipseStage();
  if (intent.togglePlayback) setPlaying(!state.playing);
  if (intent.togglePanel) {
    state.panelVisible = !state.panelVisible;
  }
  return intent;
}

function updateEclipseStickControls(
  elapsedSeconds: number,
  viewCamera: THREE.Camera,
  intent: EclipseControllerIntent,
): void {
  updateObserverOrbit(elapsedSeconds, viewCamera, intent);
  if (intent.scaleAxis !== 0) {
    setScaleDenominator(eclipseScaleAfterInput(
      state.stage.scaleDenominator,
      intent.scaleAxis,
      elapsedSeconds,
    ));
  }
  updateObserverAltitude(
    elapsedSeconds,
    viewCamera,
    intent.altitudeAxis,
  );
}

let pointerActive = false;
let pointerX = 0;
let pointerY = 0;
const desktopHeadPosition = new THREE.Vector3();
renderer.domElement.addEventListener("pointerdown", (event) => {
  if (renderer.xr.isPresenting) return;
  pointerActive = true;
  pointerX = event.clientX;
  pointerY = event.clientY;
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener("pointermove", (event) => {
  if (!pointerActive || renderer.xr.isPresenting) return;
  eclipseHeadWorldPose(camera, desktopHeadPosition, observerViewQuaternion);
  commitObserverRigTransform(updateObserverEarthOrbit(
    state.observerRigTransform,
    desktopHeadPosition,
    observerViewQuaternion,
    earthCentreWorld(),
    -(event.clientX - pointerX) * 0.004,
    (event.clientY - pointerY) * 0.004,
  ));
  enforceTopographicFloor(camera);
  pointerX = event.clientX;
  pointerY = event.clientY;
  syncPresentation();
});
renderer.domElement.addEventListener("pointerup", (event) => {
  pointerActive = false;
  if (renderer.domElement.hasPointerCapture(event.pointerId)) {
    renderer.domElement.releasePointerCapture(event.pointerId);
  }
});
renderer.domElement.addEventListener("wheel", (event) => {
  if (renderer.xr.isPresenting) return;
  event.preventDefault();
  eclipseHeadWorldPose(camera, desktopHeadPosition);
  const earthCentre = earthCentreWorld();
  const surface = topographicHeadState(desktopHeadPosition);
  const desiredRadius = Math.max(
    surface.floorRadiusWorldM,
    desktopHeadPosition.distanceTo(earthCentre) *
      Math.exp(event.deltaY * 0.001),
  );
  commitObserverRigTransform(observerProjectedToBodyRadius(
    state.observerRigTransform,
    desktopHeadPosition,
    earthCentre,
    desiredRadius,
  ));
  enforceTopographicFloor(camera);
  syncPresentation();
}, { passive: false });

renderer.xr.addEventListener("sessionstart", () => {
  state.panelVisible = true;
  void startSupervisionSession();
});
renderer.xr.addEventListener("sessionend", () => {
  stopSupervisionSession();
  handPanel.enabled = false;
  voiceAgent.disable();
  pointerPressed = false;
  gestureCount = 0;
  twoGripGesture = null;
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const vrButton = VRButton.createButton(renderer, {
  requiredFeatures: ["local-floor"],
});
vrSlot.append(vrButton);

const frameIntervals: number[] = [];
let previousRenderMs = performance.now();
let previousGeometryRequestMs = Number.NEGATIVE_INFINITY;
function frameTimingSummary(): Record<string, unknown> {
  if (frameIntervals.length === 0) return { samples: 0 };
  const sorted = [...frameIntervals].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    samples: sorted.length,
    mean_ms: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
    p99_ms: percentile(0.99),
  };
}

function debugSnapshot(): Record<string, unknown> {
  const session = renderer.xr.getSession();
  const terrainLod = terrain.getLodStatus();
  const tileControls = terrain.getTileDebugControls();
  return {
    experience: "eclipse-observatory",
    ...eclipseStateReadback(),
    xr: {
      presenting: renderer.xr.isPresenting,
      reference_space: "local-floor",
      visibility_state: session?.visibilityState ?? "not-presenting",
      frame_rate: session?.frameRate ?? null,
    },
    panel_visible: state.panelVisible,
    voice_state: state.voice,
    earth_surface: {
      latitude_degrees: latestEarthSurfaceObservation.latitudeDegrees,
      longitude_degrees: latestEarthSurfaceObservation.longitudeDegrees,
      earth_fixed_head_point:
        latestEarthSurfaceObservation.headPoint.toArray(),
      head_distance_physical_metres:
        latestEarthSurfaceObservation.headDistancePhysicalM,
      signed_head_height_physical_metres:
        latestEarthSurfaceObservation.signedHeadHeightPhysicalM,
      earth_fixed_surface_point:
        latestEarthSurfaceObservation.surfacePoint.toArray(),
      earth_fixed_surface_normal:
        latestEarthSurfaceObservation.surfaceNormal.toArray(),
      nearest_point_residual_physical_metres:
        latestEarthSurfaceObservation.nearestPointResidualPhysicalM,
      terrain_min_zoom: terrainLod.minZoom,
      terrain_max_zoom: terrainLod.maxZoom,
      imagery_zoom: tileControls.textures.effective_target_zoom,
      detailed_surface_ready: terrain.hasCommittedSurface,
      imagery_provider: photographicImageryProvider?.id ?? "blue-marble",
    },
    stage: {
      position: state.stage.position.toArray(),
      quaternion: state.stage.quaternion.toArray(),
      scale_denominator: state.stage.scaleDenominator,
      scale: [
        1 / state.stage.scaleDenominator,
        1 / state.stage.scaleDenominator,
        1 / state.stage.scaleDenominator,
      ],
    },
    observer: {
      physical_position_metres: state.observerPhysicalPositionM.toArray(),
      rig_position_headset_metres:
        state.observerRigTransform.position.toArray(),
      rig_quaternion: state.observerRigTransform.quaternion.toArray(),
      scale: observerRig.scale.toArray(),
    },
    renderer: {
      draw_calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    },
    frame_timing: frameTimingSummary(),
  };
}

function updateCameraDepthRange(viewCamera: THREE.Camera): void {
  const headPosition = eclipseHeadWorldPose(
    viewCamera,
    observerHeadPosition,
  );
  const earthCentreDistanceM = headPosition.distanceTo(earthCentreWorld());
  const systemExtentPhysicalM = Math.max(
    EARTH_REFERENCE_RADIUS_M * 1.02,
    moonStagePosition.length() + MOON_RADIUS_M,
    moonStagePosition.length() + shadowConeLengthPhysicalM,
  );
  const depth = eclipseCameraDepthRange(
    state.stage.scaleDenominator,
    earthCentreDistanceM,
    systemExtentPhysicalM,
    0.02,
    VISIBLE_SUN_FAR_M,
  );
  if (camera.near === depth.nearM && camera.far === depth.farM) return;
  camera.near = depth.nearM;
  camera.far = depth.farM;
  camera.updateProjectionMatrix();
}

const debugApi = {
  help() {
    return {
      snapshot: "Read event, system, observer, renderer, voice, and XR state.",
      findEclipses: "findEclipses(startUtc, endUtc)",
      selectEclipse: "selectEclipse(eventId)",
      setTime: "setTime(utc)",
      setPlaying: "setPlaying(enabled)",
      setScaleDenominator: "setScaleDenominator(value)",
      resetStage: "Return to the default 1:8,494,678.4 scale and distance.",
    };
  },
  snapshot: debugSnapshot,
  findEclipses,
  selectEclipse: selectEvent,
  setTime: setTimeUtc,
  setPlaying,
  setScaleDenominator(scaleDenominator: number) {
    return setEclipseScaleDenominator(parseEclipseScaleDenominatorArguments({
      scale_denominator: scaleDenominator,
    }));
  },
  resetStage() {
    return resetEclipseStage();
  },
};

if (import.meta.env.DEV || new URLSearchParams(location.search).get("debug") === "1") {
  (window as unknown as { pasDeGeantDebug?: typeof debugApi }).pasDeGeantDebug =
    debugApi;
}

function render(nowMs: number): void {
  const frameIntervalMs = Math.max(0, nowMs - previousRenderMs);
  const simulationIntervalMs = Math.min(250, frameIntervalMs);
  previousRenderMs = nowMs;
  frameIntervals.push(frameIntervalMs);
  if (frameIntervals.length > 720) frameIntervals.shift();
  const viewCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  if (renderer.xr.isPresenting) {
    const intent = updateControllerButtons();
    updateObserverGripNavigation(viewCamera);
    if (intent) {
      updateEclipseStickControls(
        simulationIntervalMs / 1_000,
        viewCamera,
        intent,
      );
    }
  }
  if (state.playing) {
    const start = Date.parse(state.contacts.startUtc);
    const end = Date.parse(state.contacts.endUtc);
    requestedPlaybackTimeMs += simulationIntervalMs * PLAYBACK_RATE;
    if (requestedPlaybackTimeMs > end) {
      requestedPlaybackTimeMs = start + (requestedPlaybackTimeMs - start) % (end - start);
    }
    if (nowMs - previousGeometryRequestMs >= GEOMETRY_INTERVAL_MS) {
      previousGeometryRequestMs = nowMs;
      void setTimeUtc(new Date(requestedPlaybackTimeMs).toISOString()).catch((error) => {
        state.playing = false;
        console.error("Eclipse playback stopped:", error);
        syncPresentation();
      });
    }
  }
  syncObserverPhysicalPosition(viewCamera);
  updateCameraDepthRange(viewCamera);
  enforceTopographicFloor(viewCamera);
  updateEclipseTerrain(nowMs, viewCamera);
  updateHandPanel(nowMs, viewCamera);
  supervisionClient?.update(nowMs);
  sunWorldPosition.copy(sunStagePosition);
  modelRoot.localToWorld(sunWorldPosition);
  modelRoot.getWorldPosition(earthWorldPosition);
  eclipseSunlightDirection
    .copy(sunWorldPosition)
    .sub(earthWorldPosition)
    .normalize();
  terrain.setSunlightDirection(eclipseSunlightDirection);
  if (!terrain.group.visible && terrain.hasCommittedSurface) {
    earth.visible = false;
    terrain.group.visible = true;
  }
  lightField.update(viewCamera, sunWorldPosition);
  visibleSun.update(
    viewCamera,
    sunWorldPosition,
    headsetMetresForPhysicalMetres(
      SUN_RADIUS_M,
      state.stage.scaleDenominator,
    ),
  );
  renderer.render(scene, camera);
}

window.addEventListener("beforeunload", () => {
  stopSupervisionSession();
  voiceAgent.disable();
  worker.dispose();
  handPanel.dispose();
  panelRuntime.dispose();
  terrain.dispose();
  cones.dispose();
  footprints.dispose();
  lightField.dispose();
  visibleSun.dispose();
  earth.geometry.dispose();
  earth.material.dispose();
  atmosphere.geometry.dispose();
  atmosphere.material.dispose();
  moon.geometry.dispose();
  moon.material.dispose();
  earthTexture.dispose();
  moonTexture.dispose();
  for (const binding of controllerBindings) {
    binding.ray.geometry.dispose();
    (binding.ray.material as THREE.Material).dispose();
    binding.reticle.geometry.dispose();
    (binding.reticle.material as THREE.Material).dispose();
  }
});

syncPresentation();
loadingState.hidden = true;
errorState.hidden = true;
renderer.setAnimationLoop(render);
