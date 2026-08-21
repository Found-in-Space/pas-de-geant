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
  stickForSource,
} from "./controller-input.js";
import {
  beginObserverOneGrip,
  beginObserverTwoGrip,
  observerPositionForView,
  updateObserverOneGrip,
  updateObserverTwoGrip,
  type EclipseObserverTransform,
  type ObserverOneGripGesture,
  type ObserverTwoGripGesture,
} from "./eclipse-observer.js";
import { eclipseControllerIntent } from "./eclipse-controller-input.js";
import {
  EclipseLightField,
  EclipseFootprints,
  RetainedShadowCones,
  VISIBLE_SUN_FAR_M,
  VisibleSun,
  createGeodeticEllipsoidGeometry,
  displayDirection,
  ecefKmToDisplay,
  ecefToInertialMatrix,
  sunAlignedStageOrientation,
} from "./eclipse-rendering.js";
import {
  HAND_PANEL_SURFACE,
  HAND_PANEL_THEME,
  createEclipsePanelRoot,
  eclipsePanelCommand,
  type EclipsePanelState,
} from "./eclipse-panel.js";
import {
  presetFocus,
  presetMetresPerEarthRadius,
  presetViewDistance,
  type EclipseStageFrame,
  type EclipseStageTransform,
  type GripPose,
} from "./eclipse-stage.js";
import {
  eclipseYearFromEventId,
  parseEclipsePlaybackArguments,
  parseEclipseRangeArguments,
  parseEclipseScaleArguments,
  parseEclipseSelectionArguments,
  parseEclipseTimeArguments,
  parseEclipseViewArguments,
} from "./eclipse-tools.js";
import type {
  EclipseContactRange,
  EclipseFrame,
  EclipseViewPreset,
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

const DEFAULT_EVENT_ID = "solar-2026-08-12-total";
const PLAYBACK_RATE = 180;
const GEOMETRY_INTERVAL_MS = 160;

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
const viewReadout = element<HTMLElement>("view-readout");
const voiceReadout = element<HTMLElement>("voice-readout");
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
earthTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
moonTexture.colorSpace = THREE.SRGBColorSpace;
moonTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

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
earthFixedRoot.add(atmosphere);

const moon = new THREE.Mesh(
  new THREE.SphereGeometry(MOON_RADIUS_KM / EARTH_MEAN_RADIUS_KM, 64, 40),
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
  activePreset: EclipseViewPreset | null;
  lastPreset: EclipseViewPreset;
  panelVisible: boolean;
  voice: RealtimeAgentStatus;
  frame: EclipseFrame;
  stage: EclipseStageTransform;
  observer: EclipseObserverTransform;
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
  activePreset: "system",
  lastPreset: "system",
  panelVisible: true,
  voice: { state: "off", detail: "Press A to wake" },
  frame: initialFrame,
  stage: {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    metresPerEarthRadius: 0.09,
  },
  observer: {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  },
};

let inertialToStage: THREE.Matrix4 | null = null;
let peakStageFrame: EclipseStageFrame | null = null;
const stageToEarthFixed = new THREE.Matrix4();
const moonStagePosition = new THREE.Vector3();
const sunStagePosition = new THREE.Vector3();
const sunWorldPosition = new THREE.Vector3();
const shadowAxisStage = new THREE.Vector3(1, 0, 0);

function currentStageFrame(): EclipseStageFrame {
  return {
    moonPosition: moonStagePosition.clone(),
    shadowAxis: shadowAxisStage.clone(),
  };
}

function stageFrameForPreset(preset: EclipseViewPreset): EclipseStageFrame {
  return preset === "system" && peakStageFrame
    ? peakStageFrame
    : currentStageFrame();
}

function updateSceneFrame(frame: EclipseFrame): void {
  const ecefToInertial = ecefToInertialMatrix(frame.ecefToEquatorialJ2000);
  if (!inertialToStage) {
    const earthFromSun = ecefKmToDisplay(frame.sunEcefKm)
      .applyMatrix4(ecefToInertial)
      .multiplyScalar(-1);
    inertialToStage = sunAlignedStageOrientation(earthFromSun);
  }
  const earthFixedToStage = inertialToStage.clone().multiply(ecefToInertial);
  stageToEarthFixed.copy(earthFixedToStage).invert();
  earthFixedRoot.matrix.copy(earthFixedToStage);
  earthFixedRoot.matrixWorldNeedsUpdate = true;
  moonStagePosition.copy(
    ecefKmToDisplay(frame.moonEcefKm).applyMatrix4(earthFixedToStage),
  );
  sunStagePosition.copy(
    ecefKmToDisplay(frame.sunEcefKm).applyMatrix4(earthFixedToStage),
  );
  shadowAxisStage.copy(
    displayDirection(frame.direction)
      .transformDirection(earthFixedToStage)
      .normalize(),
  );
  moon.position.copy(moonStagePosition);
  moon.quaternion.setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    moonStagePosition.clone().negate().normalize(),
  );
  const coneLength =
    frame.axisDistanceToEarthPlaneKm / EARTH_MEAN_RADIUS_KM + 2.3;
  cones.update({
    moonPosition: moonStagePosition,
    shadowAxis: shadowAxisStage,
    displayLength: coneLength,
    centralConeSlope: frame.centralConeSlope,
    penumbraConeSlope: frame.penumbraConeSlope,
    coneToEarthFixed: stageToEarthFixed,
  });
  footprints.update(frame.penumbraRings, frame.centralRings);
  sunLight.position.copy(sunStagePosition);
}

function applyPreset(preset: EclipseViewPreset): void {
  state.activePreset = preset;
  state.lastPreset = preset;
  const metresPerEarthRadius = presetMetresPerEarthRadius(preset);
  commitSystemScale(metresPerEarthRadius);
  const focusWorld = presetFocus(preset, stageFrameForPreset(preset))
    .multiplyScalar(metresPerEarthRadius);
  commitObserverTransform({
    position: observerPositionForView(
      focusWorld,
      presetViewDistance(preset),
      camera.position,
      camera.quaternion,
      observerRig.quaternion,
    ),
    quaternion: observerRig.quaternion,
  });
  syncPresentation();
}

function commitSystemScale(metresPerEarthRadius: number): void {
  state.stage = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    metresPerEarthRadius,
  };
  modelRoot.position.set(0, 0, 0);
  modelRoot.quaternion.identity();
  modelRoot.scale.setScalar(metresPerEarthRadius);
  modelRoot.updateMatrixWorld(true);
}

function commitObserverTransform(transform: EclipseObserverTransform): void {
  state.observer = {
    position: transform.position.clone(),
    quaternion: transform.quaternion.clone().normalize(),
  };
  observerRig.position.copy(state.observer.position);
  observerRig.quaternion.copy(state.observer.quaternion);
  observerRig.scale.set(1, 1, 1);
  observerRig.updateMatrixWorld(true);
}

function resetEclipseStage(): Record<string, unknown> {
  applyPreset(state.lastPreset);
  return eclipseStateReadback();
}

function setStageScale(metresPerEarthRadius: number): void {
  if (!Number.isFinite(metresPerEarthRadius) || metresPerEarthRadius <= 0) {
    throw new Error("metresPerEarthRadius must be positive and finite.");
  }
  const focus = state.activePreset
    ? presetFocus(state.activePreset, stageFrameForPreset(state.activePreset))
    : new THREE.Vector3();
  const oldFocusWorld = focus.clone().multiplyScalar(
    state.stage.metresPerEarthRadius,
  );
  const newFocusWorld = focus.clone().multiplyScalar(metresPerEarthRadius);
  commitSystemScale(metresPerEarthRadius);
  commitObserverTransform({
    position: state.observer.position.clone().add(
      newFocusWorld.sub(oldFocusWorld),
    ),
    quaternion: state.observer.quaternion,
  });
  state.activePreset = null;
  syncPresentation();
}

function setEclipseView(preset: EclipseViewPreset): Record<string, unknown> {
  applyPreset(preset);
  return eclipseStateReadback();
}

function setEclipseScale(metresPerEarthRadius: number): Record<string, unknown> {
  setStageScale(metresPerEarthRadius);
  return eclipseStateReadback();
}

updateSceneFrame(initialFrame);
peakStageFrame = currentStageFrame();
applyPreset("system");

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
  peakStageFrame = currentStageFrame();
  applyPreset("system");
  return eclipseStateReadback();
}

function eclipseStateReadback(): Record<string, unknown> {
  const frame = state.frame;
  return {
    event_id: state.event.id,
    eclipse_kind: state.event.kind,
    peak_utc: state.event.peakUtc,
    at_utc: new Date(state.atMs).toISOString(),
    contact_start_utc: state.contacts.startUtc,
    contact_end_utc: state.contacts.endUtc,
    playing: state.playing,
    playback_rate: PLAYBACK_RATE,
    view: state.activePreset ?? "custom",
    canonical_view: state.lastPreset,
    metres_per_earth_radius: state.stage.metresPerEarthRadius,
    central_shadow: frame.centralKind,
    penumbra_visible: frame.penumbraRings.length > 0,
  };
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
    activePreset: state.activePreset,
    metresPerEarthRadius: state.stage.metresPerEarthRadius,
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

function formatView(): string {
  const view = state.activePreset ?? "custom";
  return view === "system"
    ? "Whole system"
    : view[0]!.toUpperCase() + view.slice(1);
}

let panelSignature = "";
let lastPanelRedrawMs = Number.NEGATIVE_INFINITY;

function syncPresentation(nowMs = performance.now()): void {
  eventReadout.textContent =
    `${formatEventKind(state.event.kind)} · ${formatEventDate(state.event.peakUtc)}`;
  timeReadout.textContent = new Date(state.atMs).toISOString().replace("T", " ").replace(".000Z", "Z");
  viewReadout.textContent = `${formatView()} · 1 R⊕ = ${formatScale(state.stage.metresPerEarthRadius)}`;
  voiceReadout.textContent = state.voice.detail;
  document.body.dataset.eventId = state.event.id;
  document.body.dataset.eclipseUtc = new Date(state.atMs).toISOString();
  document.body.dataset.eclipseView = state.activePreset ?? "custom";
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

function formatScale(value: number): string {
  if (value < 0.01) return `${(value * 1_000).toFixed(1)} mm`;
  if (value < 1) return `${(value * 100).toFixed(1)} cm`;
  return `${value.toFixed(2)} m`;
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
    set_eclipse_view(argumentsValue) {
      return setEclipseView(parseEclipseViewArguments(argumentsValue));
    },
    set_eclipse_scale(argumentsValue) {
      return setEclipseScale(parseEclipseScaleArguments(argumentsValue));
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
  } else if (command.type === "set-view") {
    setEclipseView(command.preset);
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
let oneGripGesture: ObserverOneGripGesture | null = null;
let twoGripGesture: ObserverTwoGripGesture | null = null;
let gestureCount = 0;

function readGripReferencePose(
  binding: ControllerBinding,
  target: GripPose,
): GripPose {
  target.position.copy(binding.grip.position);
  target.quaternion.copy(binding.grip.quaternion);
  return target;
}

function updateObserverGripNavigation(): void {
  const active = controllerBindings.filter((binding) =>
    binding.inputSource &&
    (binding.inputSource.gamepad?.buttons[1]?.value ?? 0) > 0.55
  );
  const nextCount = Math.min(2, active.length);
  if (nextCount !== gestureCount) {
    gestureCount = nextCount;
    oneGripGesture = null;
    twoGripGesture = null;
    if (nextCount === 1) {
      const binding = active[0]!;
      oneGripGesture = beginObserverOneGrip(
        readGripReferencePose(binding, firstGripPose),
        state.observer,
      );
    } else if (nextCount === 2) {
      twoGripGesture = beginObserverTwoGrip(
        readGripReferencePose(active[0]!, firstGripPose),
        readGripReferencePose(active[1]!, secondGripPose),
        state.observer,
      );
    }
  }
  if (nextCount === 1 && oneGripGesture) {
    commitObserverTransform(
      updateObserverOneGrip(
        oneGripGesture,
        readGripReferencePose(active[0]!, firstGripPose),
      ),
    );
    state.activePreset = null;
    syncPresentation();
  } else if (nextCount === 2 && twoGripGesture) {
    commitObserverTransform(
      updateObserverTwoGrip(
        twoGripGesture,
        readGripReferencePose(active[0]!, firstGripPose),
        readGripReferencePose(active[1]!, secondGripPose),
      ),
    );
    state.activePreset = null;
    syncPresentation();
  }
}

const observerFlightDirection = new THREE.Vector3();
const observerViewQuaternion = new THREE.Quaternion();
const observerFlightRight = new THREE.Vector3();
const observerFlightUp = new THREE.Vector3();
const observerFlightForward = new THREE.Vector3();
const observerHeadPosition = new THREE.Vector3();
function updateObserverFlight(
  elapsedSeconds: number,
  viewCamera: THREE.Camera,
): void {
  if (gestureCount > 0) return;
  const left = bindingForHand("left")?.inputSource;
  const right = bindingForHand("right")?.inputSource;
  const [travelX, travelY] = stickForSource(left);
  const [turnAxis, verticalAxis] = stickForSource(right, 0.22);
  if (
    travelX === 0 && travelY === 0 &&
    turnAxis === 0 && verticalAxis === 0
  ) return;
  viewCamera.getWorldQuaternion(observerViewQuaternion);
  observerFlightRight.set(1, 0, 0).applyQuaternion(observerViewQuaternion);
  observerFlightUp.set(0, 1, 0).applyQuaternion(observerViewQuaternion);
  observerFlightForward.set(0, 0, -1).applyQuaternion(observerViewQuaternion);
  observerFlightDirection.set(0, 0, 0)
    .addScaledVector(observerFlightRight, travelX)
    .addScaledVector(observerFlightForward, -travelY)
    .addScaledVector(observerFlightUp, -verticalAxis);
  const nextObserver = {
    position: state.observer.position.clone(),
    quaternion: state.observer.quaternion.clone(),
  };
  if (observerFlightDirection.lengthSq() > 0) {
    nextObserver.position.addScaledVector(
      observerFlightDirection.normalize(),
      1.8 * elapsedSeconds,
    );
  }
  if (turnAxis !== 0) {
    viewCamera.getWorldPosition(observerHeadPosition);
    const yaw = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      -turnAxis * 1.35 * elapsedSeconds,
    );
    nextObserver.position
      .sub(observerHeadPosition)
      .applyQuaternion(yaw)
      .add(observerHeadPosition);
    nextObserver.quaternion.premultiply(yaw).normalize();
  }
  commitObserverTransform(nextObserver);
  state.activePreset = null;
  syncPresentation();
}

const buttonLatch = freshButtonLatch();
function updateControllerButtons(): void {
  const session = renderer.xr.getSession();
  if (!session) return;
  const intent = eclipseControllerIntent(session, buttonLatch);
  if (intent.toggleVoice) void voiceAgent.toggle();
  if (intent.resetStage) resetEclipseStage();
  if (intent.togglePlayback) setPlaying(!state.playing);
  if (intent.togglePanel) {
    state.panelVisible = !state.panelVisible;
  }
}

let pointerActive = false;
let pointerX = 0;
let pointerY = 0;
const desktopNavigationFocus = new THREE.Vector3();
const desktopHeadPosition = new THREE.Vector3();
function currentNavigationFocus(): THREE.Vector3 {
  const preset = state.activePreset ?? state.lastPreset;
  return desktopNavigationFocus.copy(
    presetFocus(preset, stageFrameForPreset(preset)),
  ).multiplyScalar(state.stage.metresPerEarthRadius);
}
renderer.domElement.addEventListener("pointerdown", (event) => {
  if (renderer.xr.isPresenting) return;
  pointerActive = true;
  pointerX = event.clientX;
  pointerY = event.clientY;
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener("pointermove", (event) => {
  if (!pointerActive || renderer.xr.isPresenting) return;
  const yaw = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    -(event.clientX - pointerX) * 0.004,
  );
  const pitch = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -(event.clientY - pointerY) * 0.004,
  );
  const rotation = yaw.multiply(pitch).normalize();
  const focus = currentNavigationFocus();
  commitObserverTransform({
    position: state.observer.position.clone()
      .sub(focus)
      .applyQuaternion(rotation)
      .add(focus),
    quaternion: rotation.multiply(state.observer.quaternion).normalize(),
  });
  state.activePreset = null;
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
  const focus = currentNavigationFocus();
  camera.getWorldPosition(desktopHeadPosition);
  const desiredHeadPosition = desktopHeadPosition.clone()
    .sub(focus)
    .multiplyScalar(Math.exp(event.deltaY * 0.001))
    .add(focus);
  commitObserverTransform({
    position: state.observer.position.clone().add(
      desiredHeadPosition.sub(desktopHeadPosition),
    ),
    quaternion: state.observer.quaternion,
  });
  state.activePreset = null;
  syncPresentation();
}, { passive: false });

renderer.xr.addEventListener("sessionstart", () => {
  state.panelVisible = true;
});
renderer.xr.addEventListener("sessionend", () => {
  handPanel.enabled = false;
  voiceAgent.disable();
  pointerPressed = false;
  gestureCount = 0;
  oneGripGesture = null;
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
    stage: {
      active_preset: state.activePreset,
      reset_preset: state.lastPreset,
      position: state.stage.position.toArray(),
      quaternion: state.stage.quaternion.toArray(),
      scale: [
        state.stage.metresPerEarthRadius,
        state.stage.metresPerEarthRadius,
        state.stage.metresPerEarthRadius,
      ],
    },
    observer: {
      position: state.observer.position.toArray(),
      quaternion: state.observer.quaternion.toArray(),
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

const debugApi = {
  help() {
    return {
      snapshot: "Read event, system, observer, renderer, voice, and XR state.",
      findEclipses: "findEclipses(startUtc, endUtc)",
      selectEclipse: "selectEclipse(eventId)",
      setTime: "setTime(utc)",
      setPlaying: "setPlaying(enabled)",
      setView: "setView(system|earth|moon|shadow)",
      setScale: "setScale(metresPerEarthRadius)",
      resetStage: "Return the observer to the current canonical viewpoint.",
    };
  },
  snapshot: debugSnapshot,
  findEclipses,
  selectEclipse: selectEvent,
  setTime: setTimeUtc,
  setPlaying,
  setView(preset: EclipseViewPreset) {
    return setEclipseView(parseEclipseViewArguments({ preset }));
  },
  setScale(metresPerEarthRadius: number) {
    return setEclipseScale(parseEclipseScaleArguments({
      metres_per_earth_radius: metresPerEarthRadius,
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
  const viewCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  if (renderer.xr.isPresenting) {
    updateControllerButtons();
    updateObserverGripNavigation();
    updateObserverFlight(simulationIntervalMs / 1_000, viewCamera);
  }
  updateHandPanel(nowMs, viewCamera);
  sunWorldPosition.copy(sunStagePosition);
  modelRoot.localToWorld(sunWorldPosition);
  lightField.update(viewCamera, sunWorldPosition);
  visibleSun.update(
    viewCamera,
    sunWorldPosition,
    SUN_RADIUS_KM / EARTH_MEAN_RADIUS_KM * state.stage.metresPerEarthRadius,
  );
  renderer.render(scene, camera);
}

window.addEventListener("beforeunload", () => {
  voiceAgent.disable();
  worker.dispose();
  handPanel.dispose();
  panelRuntime.dispose();
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
