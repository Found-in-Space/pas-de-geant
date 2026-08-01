import "./construct-transition.css";

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  FakeTileProvider,
  type FakeFailureMode,
  type FakeTileProviderOptions,
} from "./construct-fake-tile-provider.js";
import {
  normalizeConstructTarget,
  TileOnionLayoutSource,
  type ConstructTarget,
} from "./construct-layout-source.js";
import {
  observerTileZoom,
  projectedFocalLengthPixels,
} from "./construct-observer-zoom.js";
import {
  TileTransitionScheduler,
  type SchedulerEvent,
  type SchedulerSnapshot,
  type TileRequirementState,
} from "./construct-transition-scheduler.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "./construct-transition-planner.js";
import { mercatorPoint, tileBounds } from "./tile-onion-core.js";

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing Construct element #${id}.`);
  return element as T;
}

const globeHost = requiredElement<HTMLElement>("globe");
const targetXInput = requiredElement<HTMLInputElement>("target-x");
const targetYInput = requiredElement<HTMLInputElement>("target-y");
const targetZInput = requiredElement<HTMLInputElement>("target-z");
const observerHeightInput = requiredElement<HTMLInputElement>("observer-height");
const observerHeightValue = requiredElement<HTMLElement>("observer-height-value");
const tileResolutionInput = requiredElement<HTMLInputElement>("tile-resolution");
const derivedZoom = requiredElement<HTMLElement>("derived-zoom");
const zoomDerivationDetail = requiredElement<HTMLElement>("zoom-derivation-detail");
let configuredTileResolutionPixels = Number(tileResolutionInput.value);
const latencyInput = requiredElement<HTMLInputElement>("latency");
const jitterInput = requiredElement<HTMLInputElement>("jitter");
const failureModeInput = requiredElement<HTMLSelectElement>("failure-mode");
const failureRateInput = requiredElement<HTMLInputElement>("failure-rate");
const failureKeyInput = requiredElement<HTMLInputElement>("failure-key");
const retryButton = requiredElement<HTMLButtonElement>("retry");
const clearLogButton = requiredElement<HTMLButtonElement>("clear-log");
const eventLog = requiredElement<HTMLOListElement>("event-log");
const targetLabel = requiredElement<HTMLElement>("target-label");
const clock = requiredElement<HTMLElement>("clock");
const revision = requiredElement<HTMLElement>("revision");
const settledState = requiredElement<HTMLElement>("settled-state");
const stateStrip = requiredElement<HTMLElement>("state-strip");

const counters = {
  committed: requiredElement<HTMLElement>("committed-count"),
  requested: requiredElement<HTMLElement>("requested-count"),
  groups: requiredElement<HTMLElement>("group-count"),
  batches: requiredElement<HTMLElement>("batch-count"),
  inflight: requiredElement<HTMLElement>("inflight-count"),
  failed: requiredElement<HTMLElement>("blocked-count"),
};

interface GeographicTarget {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

const initialTile: ConstructTarget = { z: 7, x: 64, y: 64 };
const initialTileBounds = tileBounds(initialTile);
let geographicTarget: GeographicTarget = {
  latitudeDegrees: (initialTileBounds.north + initialTileBounds.south) / 2,
  longitudeDegrees: (initialTileBounds.west + initialTileBounds.east) / 2,
};

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
globeHost.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(37, 1, 0.01, 100);
camera.position.set(1.65, 0.95, 2.25);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 1.75;
controls.maxDistance = 5.2;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.7;

const initialWidth = Math.max(1, globeHost.clientWidth);
const initialHeight = Math.max(1, globeHost.clientHeight);
renderer.setSize(initialWidth, initialHeight, false);
camera.aspect = initialWidth / initialHeight;
camera.updateProjectionMatrix();

const initialTarget = targetAtDerivedZoom(geographicTarget);
const provider = new FakeTileProvider();
const scheduler = new TileTransitionScheduler(
  initialTarget,
  new TileOnionLayoutSource(),
  provider,
);

scene.add(new THREE.AmbientLight(0xa5c5df, 1.2));
const sun = new THREE.DirectionalLight(0xffe6b8, 2.2);
sun.position.set(2, 3, 4);
scene.add(sun);

const globeSphere = new THREE.Mesh(
  new THREE.SphereGeometry(1, 72, 44),
  new THREE.MeshPhongMaterial({
    color: 0x07121b,
    emissive: 0x02060a,
    specular: 0x1d4c5b,
    shininess: 22,
    transparent: true,
    opacity: 0.96,
  }),
);
scene.add(globeSphere);
const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.025, 72, 44),
  new THREE.MeshBasicMaterial({
    color: 0x66c5d4,
    transparent: true,
    opacity: 0.035,
    side: THREE.BackSide,
  }),
);
scene.add(atmosphere);

const committedLayer = new THREE.Group();
const requestedLayer = new THREE.Group();
const lifecycleLayer = new THREE.Group();
const swapLayer = new THREE.Group();
scene.add(committedLayer, requestedLayer, lifecycleLayer, swapLayer);

let latestSnapshot = scheduler.snapshot;
let renderQueued = true;
let lastSwap: { tiles: readonly TileIdentity[]; expiresAt: number } | undefined;
const logEntries: SchedulerEvent[] = [];

function sphericalPoint(
  latitudeDegrees: number,
  longitudeDegrees: number,
  radius: number,
): THREE.Vector3 {
  const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
  const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
  return new THREE.Vector3(
    radius * Math.cos(latitude) * Math.cos(longitude),
    radius * Math.sin(latitude),
    radius * Math.cos(latitude) * Math.sin(longitude),
  );
}

function tilePatchGeometry(tile: TileIdentity, radius: number): THREE.BufferGeometry {
  const bounds = tileBounds(tile);
  // Large, coarse tiles need enough curvature that their triangular chords do
  // not fall back through the globe and look like missing coverage.
  const segments = Math.max(
    3,
    Math.ceil(
      Math.max(bounds.east - bounds.west, bounds.north - bounds.south) / 4,
    ),
  );
  const positions: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= segments; row += 1) {
    const latitude = THREE.MathUtils.lerp(bounds.north, bounds.south, row / segments);
    for (let column = 0; column <= segments; column += 1) {
      const longitude = THREE.MathUtils.lerp(bounds.west, bounds.east, column / segments);
      const point = sphericalPoint(latitude, longitude, radius);
      positions.push(point.x, point.y, point.z);
    }
  }
  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const topLeft = row * (segments + 1) + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + segments + 1;
      const bottomRight = bottomLeft + 1;
      indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function tileOutlineGeometry(tile: TileIdentity, radius: number): THREE.BufferGeometry {
  const bounds = tileBounds(tile);
  const segments = 5;
  const points: THREE.Vector3[] = [];
  const appendEdge = (
    fromLatitude: number,
    fromLongitude: number,
    toLatitude: number,
    toLongitude: number,
  ): void => {
    let previous = sphericalPoint(fromLatitude, fromLongitude, radius);
    for (let index = 1; index <= segments; index += 1) {
      const amount = index / segments;
      const next = sphericalPoint(
        THREE.MathUtils.lerp(fromLatitude, toLatitude, amount),
        THREE.MathUtils.lerp(fromLongitude, toLongitude, amount),
        radius,
      );
      points.push(previous, next);
      previous = next;
    }
  };
  appendEdge(bounds.north, bounds.west, bounds.north, bounds.east);
  appendEdge(bounds.north, bounds.east, bounds.south, bounds.east);
  appendEdge(bounds.south, bounds.east, bounds.south, bounds.west);
  appendEdge(bounds.south, bounds.west, bounds.north, bounds.west);
  return new THREE.BufferGeometry().setFromPoints(points);
}

function disposeLayer(layer: THREE.Group): void {
  for (const child of [...layer.children]) {
    layer.remove(child);
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) material.dispose();
    }
  }
}

function absoluteZoomColour(zoom: number): THREE.Color {
  const hue = ((0.55 - zoom * 0.038) % 1 + 1) % 1;
  return new THREE.Color().setHSL(hue, 0.62, 0.3 + Math.min(zoom, 12) * 0.012);
}

function addTileFill(
  layer: THREE.Group,
  tile: TileIdentity,
  colour: THREE.ColorRepresentation,
  opacity: number,
  radius: number,
): void {
  const mesh = new THREE.Mesh(
    tilePatchGeometry(tile, radius),
    new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.userData.tile = tile;
  layer.add(mesh);
}

function addTileOutline(
  layer: THREE.Group,
  tile: TileIdentity,
  colour: THREE.ColorRepresentation,
  opacity: number,
  radius: number,
): void {
  const line = new THREE.LineSegments(
    tileOutlineGeometry(tile, radius),
    new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity }),
  );
  layer.add(line);
}

const requirementColours: Record<TileRequirementState, number> = {
  requested: 0xa3b2bd,
  "in-flight": 0x51a9ff,
  ready: 0x64efc1,
  failed: 0xff5575,
};

function renderGlobe(): void {
  disposeLayer(committedLayer);
  disposeLayer(requestedLayer);
  disposeLayer(lifecycleLayer);
  disposeLayer(swapLayer);

  for (const tile of latestSnapshot.committedCut) {
    addTileFill(committedLayer, tile, absoluteZoomColour(tile.z), 0.64, 1.002);
    addTileOutline(committedLayer, tile, 0x77a9ad, 0.35, 1.004);
  }
  for (const tile of latestSnapshot.requestedCut) {
    addTileOutline(requestedLayer, tile, 0xffd48a, 0.72, 1.009);
  }
  for (const requirement of latestSnapshot.requirements) {
    addTileFill(
      lifecycleLayer,
      requirement.tile,
      requirementColours[requirement.state],
      requirement.state === "failed" ? 0.84 : 0.66,
      1.012,
    );
    addTileOutline(
      lifecycleLayer,
      requirement.tile,
      requirementColours[requirement.state],
      0.95,
      1.014,
    );
  }
  if (lastSwap && lastSwap.expiresAt > performance.now()) {
    for (const tile of lastSwap.tiles) {
      addTileFill(swapLayer, tile, 0xffffff, 0.38, 1.016);
      addTileOutline(swapLayer, tile, 0xffffff, 1, 1.018);
    }
  }
  renderQueued = false;
}

function eventDescription(event: SchedulerEvent): string {
  if (event.kind === "atomic-swap") {
    return `${event.groupIds?.length ?? 0} group${event.groupIds?.length === 1 ? "" : "s"} · ${event.before?.length ?? 0} → ${event.after?.length ?? 0} leaves`;
  }
  const tile = event.tile ? tileIdentityKey(event.tile) : "";
  if (event.kind === "failure") return `${tile} · ${event.reason}`;
  if (event.kind === "cancellation" || event.kind === "discard") {
    return `${tile} · ${event.reason}`;
  }
  return `${tile} · request ${event.requestId}`;
}

function renderLog(): void {
  eventLog.replaceChildren(
    ...logEntries.slice(-80).reverse().map((event) => {
      const item = document.createElement("li");
      item.className = `event-${event.kind}`;
      const heading = document.createElement("div");
      const kind = document.createElement("strong");
      kind.textContent = event.kind.replace("-", " ");
      const meta = document.createElement("span");
      meta.textContent = `#${event.sequence} · r${event.revision}`;
      heading.append(kind, meta);
      const description = document.createElement("p");
      description.textContent = eventDescription(event);
      item.append(heading, description);
      return item;
    }),
  );
}

function renderDiagnostics(): void {
  const requirements = latestSnapshot.requirements;
  const inFlight = requirements.filter(
    ({ state }) => state === "requested" || state === "in-flight",
  ).length;
  const ready = requirements.filter(({ state }) => state === "ready").length;
  const failed = requirements.filter(({ state }) => state === "failed").length;
  counters.committed.textContent = String(latestSnapshot.committedCut.length);
  counters.requested.textContent = String(latestSnapshot.requestedCut.length);
  counters.groups.textContent = String(latestSnapshot.graph.groups.length);
  counters.batches.textContent = String(latestSnapshot.graph.batches.length);
  counters.inflight.textContent = String(inFlight);
  counters.failed.textContent = String(failed);
  revision.textContent = `r${latestSnapshot.revision}`;
  settledState.textContent =
    latestSnapshot.graph.groups.length === 0
      ? "Settled"
      : failed > 0
        ? "Blocked regions"
        : "Transitioning";
  settledState.className = failed > 0 ? "has-failure" : inFlight > 0 ? "is-active" : "";
  stateStrip.replaceChildren();
  for (const [label, count, className] of [
    ["requested", requirements.filter(({ state }) => state === "requested").length, "requested"],
    ["in flight", requirements.filter(({ state }) => state === "in-flight").length, "inflight"],
    ["staged", ready, "ready"],
    ["failed", failed, "failed"],
  ] as const) {
    const chip = document.createElement("span");
    chip.className = className;
    chip.textContent = `${count} ${label}`;
    stateStrip.append(chip);
  }
}

function writeTargetInputs(target: Readonly<ConstructTarget>): void {
  targetXInput.value = String(target.x);
  targetYInput.value = String(target.y);
  targetZInput.value = String(target.z);
  targetLabel.textContent = `z${target.z} / ${target.x} / ${target.y}`;
}

function observerHeightMeters(): number {
  return 10 ** Number(observerHeightInput.value);
}

function tileResolutionPixels(): number {
  return configuredTileResolutionPixels;
}

function formatObserverHeight(heightMeters: number): string {
  if (heightMeters < 1_000) {
    return `${heightMeters.toLocaleString(undefined, { maximumFractionDigits: 0 })} m`;
  }
  const kilometres = heightMeters / 1_000;
  const maximumFractionDigits = kilometres < 10 ? 2 : kilometres < 100 ? 1 : 0;
  return `${kilometres.toLocaleString(undefined, { maximumFractionDigits })} km`;
}

function currentObserverLayout(target: Readonly<GeographicTarget>): {
  readonly target: ConstructTarget;
  readonly focalLengthPixels: number;
  readonly continuousZoom: number;
} {
  // Tile source pixels are compared with physical render-buffer pixels. Using
  // the drawing-buffer height here makes that DPR choice explicit.
  const drawingBufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
  const focalLengthPixels = projectedFocalLengthPixels(
    drawingBufferSize.y,
    camera.fov,
  );
  const result = observerTileZoom({
    observerHeightMeters: observerHeightMeters(),
    latitudeDegrees: target.latitudeDegrees,
    projectedFocalLengthPixels: focalLengthPixels,
    tilePixels: tileResolutionPixels(),
  });
  const point = mercatorPoint(
    target.latitudeDegrees,
    target.longitudeDegrees,
    result.zoom,
  );
  return {
    target: normalizeConstructTarget({
      z: result.zoom,
      x: Math.floor(point.x),
      y: Math.floor(point.y),
    }),
    focalLengthPixels,
    continuousZoom: result.continuousZoom,
  };
}

function targetAtDerivedZoom(
  target: Readonly<GeographicTarget>,
): ConstructTarget {
  return currentObserverLayout(target).target;
}

function renderObserverDiagnostics(
  layout: ReturnType<typeof currentObserverLayout>,
): void {
  const heightMeters = observerHeightMeters();
  const tilePixels = tileResolutionPixels();
  const formattedHeight = formatObserverHeight(heightMeters);
  observerHeightValue.textContent = formattedHeight;
  observerHeightInput.setAttribute("aria-valuetext", formattedHeight);
  derivedZoom.textContent = `z${layout.target.z}`;
  zoomDerivationDetail.textContent =
    `raw z${layout.continuousZoom.toFixed(2)} · ${tilePixels.toLocaleString()} px tile · ` +
    `${Math.round(layout.focalLengthPixels).toLocaleString()} px render-buffer focal length · ` +
    `${Math.abs(geographicTarget.latitudeDegrees).toFixed(2)}°` +
    `${geographicTarget.latitudeDegrees < 0 ? " S" : " N"}`;
}

function setTarget(target: ConstructTarget): void {
  const normalized = normalizeConstructTarget(target);
  writeTargetInputs(normalized);
  const current = latestSnapshot.target;
  if (
    current.z === normalized.z &&
    current.x === normalized.x &&
    current.y === normalized.y
  ) {
    return;
  }
  scheduler.updateTarget(normalized);
}

function refreshDerivedTarget(): void {
  const layout = currentObserverLayout(geographicTarget);
  renderObserverDiagnostics(layout);
  setTarget(layout.target);
}

function targetFromGeographic(latitude: number, longitude: number): void {
  geographicTarget = {
    latitudeDegrees: latitude,
    longitudeDegrees: longitude,
  };
  refreshDerivedTarget();
}

scheduler.subscribe((snapshot, event) => {
  latestSnapshot = snapshot;
  writeTargetInputs(snapshot.target);
  if (event) {
    logEntries.push(event);
    if (event.kind === "atomic-swap") {
      lastSwap = { tiles: event.after ?? [], expiresAt: performance.now() + 1_150 };
    }
    renderLog();
  }
  renderDiagnostics();
  renderQueued = true;
});

provider.subscribe((event) => {
  clock.textContent = `${(event.timeMs / 1_000).toFixed(2)} s`;
});

for (const input of [targetXInput, targetYInput]) {
  input.addEventListener("input", () => {
    if ([targetXInput, targetYInput].some(({ value }) => value === "")) {
      return;
    }
    const target = normalizeConstructTarget({
      z: latestSnapshot.target.z,
      x: Number(targetXInput.value),
      y: Number(targetYInput.value),
    });
    const bounds = tileBounds(target);
    geographicTarget = {
      latitudeDegrees: (bounds.north + bounds.south) / 2,
      longitudeDegrees: (bounds.west + bounds.east) / 2,
    };
    refreshDerivedTarget();
  });
}

observerHeightInput.addEventListener("input", refreshDerivedTarget);
tileResolutionInput.addEventListener("input", () => {
  if (tileResolutionInput.value === "" || !tileResolutionInput.validity.valid) return;
  configuredTileResolutionPixels = Number(tileResolutionInput.value);
  refreshDerivedTarget();
});

function updateProviderConfiguration(): void {
  provider.configure({
    latencyMs: Number(latencyInput.value),
    jitterMs: Number(jitterInput.value),
    failureMode: failureModeInput.value as FakeFailureMode,
    failureRate: Number(failureRateInput.value) / 100,
    selectedFailureKey: failureKeyInput.value,
  } satisfies Partial<FakeTileProviderOptions>);
}
for (const input of [
  latencyInput,
  jitterInput,
  failureModeInput,
  failureRateInput,
  failureKeyInput,
]) {
  input.addEventListener("change", updateProviderConfiguration);
}
retryButton.addEventListener("click", () => scheduler.retryFailed());
clearLogButton.addEventListener("click", () => {
  logEntries.splice(0);
  renderLog();
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerStart = { x: 0, y: 0 };
let pointerTravel = 0;
renderer.domElement.addEventListener("pointerdown", (event) => {
  pointerStart = { x: event.clientX, y: event.clientY };
  pointerTravel = 0;
});
renderer.domElement.addEventListener("pointermove", (event) => {
  pointerTravel = Math.max(
    pointerTravel,
    Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y),
  );
});
renderer.domElement.addEventListener("pointerup", (event) => {
  if (pointerTravel > 5) return;
  const bounds = renderer.domElement.getBoundingClientRect();
  pointer.x = (event.clientX - bounds.left) / bounds.width * 2 - 1;
  pointer.y = -(event.clientY - bounds.top) / bounds.height * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const intersection = raycaster.intersectObject(globeSphere, false)[0];
  if (!intersection) return;
  const point = intersection.point.normalize();
  targetFromGeographic(
    THREE.MathUtils.radToDeg(Math.asin(point.y)),
    THREE.MathUtils.radToDeg(Math.atan2(point.z, point.x)),
  );
});
controls.addEventListener("end", () => {
  if (pointerTravel <= 5) return;
  const point = camera.position.clone().normalize();
  targetFromGeographic(
    THREE.MathUtils.radToDeg(Math.asin(point.y)),
    THREE.MathUtils.radToDeg(Math.atan2(point.z, point.x)),
  );
});

function resize(): void {
  const width = globeHost.clientWidth;
  const height = globeHost.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
  refreshDerivedTarget();
}
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(globeHost);
resize();

let lastFrame = performance.now();
function animate(now: number): void {
  const elapsed = Math.min(250, now - lastFrame);
  lastFrame = now;
  provider.advanceBy(elapsed);
  controls.update();
  if (lastSwap && lastSwap.expiresAt <= now) {
    lastSwap = undefined;
    renderQueued = true;
  }
  if (renderQueued) renderGlobe();
  renderer.render(scene, camera);
  clock.textContent = `${(provider.now / 1_000).toFixed(2)} s`;
  requestAnimationFrame(animate);
}

refreshDerivedTarget();
updateProviderConfiguration();
renderDiagnostics();
renderLog();
requestAnimationFrame(animate);
