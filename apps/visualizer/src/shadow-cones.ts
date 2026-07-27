import "./shadow-cones.css";

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import {
  EARTH_MEAN_RADIUS_KM,
  MOON_RADIUS_KM,
  SUN_RADIUS_KM,
  type CartesianVector,
  type EclipseSummary,
} from "@found-in-space/shadowline";

type DisplayMode = "readable" | "affine";

interface ShadowFrame {
  event: EclipseSummary;
  atUtc: string;
  sunEcefKm: CartesianVector;
  moonEcefKm: CartesianVector;
  direction: CartesianVector;
  sunMoonDistanceKm: number;
  moonEarthDistanceKm: number;
  axisDistanceToEarthPlaneKm: number;
  umbraRadiusAtEarthPlaneKm: number;
  penumbraRadiusAtEarthPlaneKm: number;
  centralKind: "umbra" | "antumbra" | null;
  penumbraRings: CartesianVector[][];
  centralRings: CartesianVector[][];
}

type WorkerResponse =
  | { type: "ready"; event: EclipseSummary }
  | { type: "frame"; requestId: number; frame: ShadowFrame }
  | { type: "error"; requestId: number; message: string };

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}.`);
  return value as T;
};

const sceneRoot = element<HTMLDivElement>("scene-root");
const loadingState = element<HTMLDivElement>("loading-state");
const errorState = element<HTMLDivElement>("error-state");
const errorMessage = element<HTMLParagraphElement>("error-message");
const vrSlot = element<HTMLDivElement>("vr-slot");
const playButton = element<HTMLButtonElement>("play-button");
const timeSlider = element<HTMLInputElement>("time-slider");
const spacingSlider = element<HTMLInputElement>("spacing-slider");
const umbraSlider = element<HTMLInputElement>("umbra-slider");
const spacingOutput = element<HTMLOutputElement>("spacing-output");
const umbraOutput = element<HTMLOutputElement>("umbra-output");
const dateLabel = element<HTMLSpanElement>("date-label");
const timeLabel = element<HTMLElement>("time-label");
const shadowKind = element<HTMLSpanElement>("shadow-kind");
const umbraWidth = element<HTMLElement>("umbra-width");
const statusDot = element<HTMLSpanElement>("status-dot");
const moonDistance = element<HTMLElement>("moon-distance");
const sunDistance = element<HTMLElement>("sun-distance");
const readableModeButton = element<HTMLButtonElement>("readable-mode");
const affineModeButton = element<HTMLButtonElement>("affine-mode");

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
renderer.xr.enabled = true;
sceneRoot.append(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x070b16, 0.018);

const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.03,
  180,
);
camera.position.set(9.2, 5.7, 11.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.minDistance = 3.1;
controls.maxDistance = 34;
controls.target.set(-1.2, 0, 0);
controls.update();

const modelRoot = new THREE.Group();
scene.add(modelRoot);

scene.add(new THREE.HemisphereLight(0x9fc8ff, 0x100d1d, 1.05));
const sunLight = new THREE.DirectionalLight(0xffe3aa, 3.2);
sunLight.target.position.set(0, 0, 0);
modelRoot.add(sunLight, sunLight.target);

function deterministicStars(): THREE.Points {
  let seed = 24681357;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();
  for (let index = 0; index < 950; index += 1) {
    const radius = 38 + random() * 48;
    const cosine = random() * 2 - 1;
    const sine = Math.sqrt(1 - cosine * cosine);
    const angle = random() * Math.PI * 2;
    positions.push(
      radius * sine * Math.cos(angle),
      radius * cosine,
      radius * sine * Math.sin(angle),
    );
    color.setHSL(0.54 + random() * 0.09, 0.24, 0.62 + random() * 0.3);
    colors.push(color.r, color.g, color.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(colors, 3),
  );
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.055,
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      sizeAttenuation: true,
    }),
  );
}
scene.add(deterministicStars());

const earthTransform = new THREE.Group();
modelRoot.add(earthTransform);

const earth = new THREE.Mesh(
  new THREE.SphereGeometry(1, 96, 64),
  new THREE.MeshStandardMaterial({
    color: 0x1a5269,
    roughness: 0.88,
    metalness: 0.02,
    emissive: 0x07101c,
    emissiveIntensity: 0.65,
  }),
);
earthTransform.add(earth);

const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(1.035, 72, 48),
  new THREE.MeshBasicMaterial({
    color: 0x71dbe8,
    transparent: true,
    opacity: 0.075,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
earthTransform.add(atmosphere);

function graticule(): THREE.LineSegments {
  const positions: number[] = [];
  const addSegment = (first: THREE.Vector3, second: THREE.Vector3) => {
    positions.push(first.x, first.y, first.z, second.x, second.y, second.z);
  };
  const spherePoint = (latitude: number, longitude: number) => {
    const cosine = Math.cos(latitude);
    return new THREE.Vector3(
      cosine * Math.cos(longitude),
      Math.sin(latitude),
      -cosine * Math.sin(longitude),
    ).multiplyScalar(1.006);
  };
  for (let latitudeDeg = -60; latitudeDeg <= 60; latitudeDeg += 30) {
    const latitude = THREE.MathUtils.degToRad(latitudeDeg);
    for (let longitudeDeg = 0; longitudeDeg < 360; longitudeDeg += 5) {
      addSegment(
        spherePoint(latitude, THREE.MathUtils.degToRad(longitudeDeg)),
        spherePoint(latitude, THREE.MathUtils.degToRad(longitudeDeg + 5)),
      );
    }
  }
  for (let longitudeDeg = 0; longitudeDeg < 360; longitudeDeg += 30) {
    const longitude = THREE.MathUtils.degToRad(longitudeDeg);
    for (let latitudeDeg = -90; latitudeDeg < 90; latitudeDeg += 5) {
      addSegment(
        spherePoint(THREE.MathUtils.degToRad(latitudeDeg), longitude),
        spherePoint(THREE.MathUtils.degToRad(latitudeDeg + 5), longitude),
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  return new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      color: 0x82ccda,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  );
}
earthTransform.add(graticule());

const moon = new THREE.Mesh(
  new THREE.SphereGeometry(MOON_RADIUS_KM / EARTH_MEAN_RADIUS_KM, 56, 36),
  new THREE.MeshStandardMaterial({
    color: 0xb6b5b2,
    roughness: 1,
    metalness: 0,
    emissive: 0x101116,
    emissiveIntensity: 0.3,
  }),
);
moon.matrixAutoUpdate = false;
modelRoot.add(moon);

const sun = new THREE.Mesh(
  new THREE.SphereGeometry(0.82, 64, 40),
  new THREE.MeshBasicMaterial({ color: 0xffcf66 }),
);
const sunGlow = new THREE.Mesh(
  new THREE.SphereGeometry(1.03, 48, 30),
  new THREE.MeshBasicMaterial({
    color: 0xffae42,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
sun.add(sunGlow);
modelRoot.add(sun);

const ringLayer = new THREE.Group();
earthTransform.add(ringLayer);
const coneLayer = new THREE.Group();
const guideLayer = new THREE.Group();
const labelLayer = new THREE.Group();
modelRoot.add(coneLayer, guideLayer, labelLayer);

function labelSprite(
  text: string,
  accent: string,
  subtitle?: string,
): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 192;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas labels are not supported.");
  context.fillStyle = "rgba(5, 10, 22, 0.82)";
  context.strokeStyle = "rgba(177, 202, 230, 0.25)";
  context.lineWidth = 3;
  context.beginPath();
  context.roundRect(12, 12, 744, 168, 28);
  context.fill();
  context.stroke();
  context.fillStyle = accent;
  context.beginPath();
  context.arc(56, subtitle ? 73 : 96, 10, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#f4f4f1";
  context.font = "700 44px Inter, system-ui, sans-serif";
  context.fillText(text, 82, subtitle ? 84 : 111);
  if (subtitle) {
    context.fillStyle = "#9da9ba";
    context.font = "500 28px Inter, system-ui, sans-serif";
    context.fillText(subtitle, 82, 132);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  sprite.scale.set(2.35, 0.59, 1);
  sprite.renderOrder = 20;
  return sprite;
}

const sunLabel = labelSprite("Sun", "#f2b94d", "symbolic size");
const moonLabel = labelSprite("Moon", "#c4c4c1");
const earthLabel = labelSprite("Earth", "#7ee7f2", "WGS 84 surface");
labelLayer.add(sunLabel, moonLabel, earthLabel);

const spainMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.026, 18, 12),
  new THREE.MeshBasicMaterial({ color: 0xffffff }),
);
const spainPosition = (() => {
  const latitude = THREE.MathUtils.degToRad(40.42);
  const longitude = THREE.MathUtils.degToRad(-3.7);
  const cosine = Math.cos(latitude);
  return new THREE.Vector3(
    cosine * Math.cos(longitude),
    Math.sin(latitude),
    -cosine * Math.sin(longitude),
  ).multiplyScalar(1.02);
})();
spainMarker.position.copy(spainPosition);
earthTransform.add(spainMarker);

const spainLabel = labelSprite("Spain", "#ffffff", "12 August 2026");
spainLabel.scale.multiplyScalar(0.72);
labelLayer.add(spainLabel);

function vector(value: CartesianVector, scaleValue = 1): THREE.Vector3 {
  return new THREE.Vector3(
    value.x * scaleValue,
    value.z * scaleValue,
    -value.y * scaleValue,
  );
}

function clearLayer(layer: THREE.Group): void {
  for (const child of [...layer.children]) {
    layer.remove(child);
    if ("geometry" in child && child.geometry instanceof THREE.BufferGeometry) {
      child.geometry.dispose();
    }
    if ("material" in child) {
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const material of materials) {
        if (material instanceof THREE.Material) material.dispose();
      }
    }
  }
}

function addRing(
  pointsEcefKm: CartesianVector[],
  color: number,
  radius: number,
): void {
  const points = pointsEcefKm.map((point) =>
    vector(point, 1.016 / EARTH_MEAN_RADIUS_KM),
  );
  if (
    points.length > 1 &&
    points[0]!.distanceToSquared(points.at(-1)!) < 1e-9
  ) {
    points.pop();
  }
  if (points.length < 4) return;
  const curve = new THREE.CatmullRomCurve3(
    points,
    true,
    "centripetal",
    0.25,
  );
  const geometry = new THREE.TubeGeometry(
    curve,
    Math.max(64, points.length * 2),
    radius,
    6,
    true,
  );
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const tube = new THREE.Mesh(geometry, material);
  tube.renderOrder = 8;
  ringLayer.add(tube);
}

function perpendicularBasis(axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const reference =
    Math.abs(axis.y) < 0.82
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
  const first = new THREE.Vector3().crossVectors(axis, reference).normalize();
  const second = new THREE.Vector3().crossVectors(axis, first).normalize();
  return [first, second];
}

function coneSurface(
  start: THREE.Vector3,
  axis: THREE.Vector3,
  displayLength: number,
  displayToPhysicalKm: number,
  slope: number,
  color: number,
  opacity: number,
  radiusMultiplier = 1,
): THREE.Mesh {
  const radialSegments = 72;
  const lengthSegments = 42;
  const [first, second] = perpendicularBasis(axis);
  const positions: number[] = [];
  const indices: number[] = [];
  for (let alongIndex = 0; alongIndex <= lengthSegments; alongIndex += 1) {
    const along = (displayLength * alongIndex) / lengthSegments;
    const physicalAlongKm = along * displayToPhysicalKm;
    const physicalRadiusKm =
      MOON_RADIUS_KM + slope * physicalAlongKm;
    const displayRadius =
      (Math.abs(physicalRadiusKm) / EARTH_MEAN_RADIUS_KM) *
      radiusMultiplier;
    const center = start.clone().addScaledVector(axis, along);
    for (let radialIndex = 0; radialIndex <= radialSegments; radialIndex += 1) {
      const angle = (radialIndex / radialSegments) * Math.PI * 2;
      const point = center
        .clone()
        .addScaledVector(first, Math.cos(angle) * displayRadius)
        .addScaledVector(second, Math.sin(angle) * displayRadius);
      positions.push(point.x, point.y, point.z);
    }
  }
  const row = radialSegments + 1;
  for (let alongIndex = 0; alongIndex < lengthSegments; alongIndex += 1) {
    for (let radialIndex = 0; radialIndex < radialSegments; radialIndex += 1) {
      const firstIndex = alongIndex * row + radialIndex;
      const nextIndex = firstIndex + row;
      indices.push(
        firstIndex,
        nextIndex,
        firstIndex + 1,
        nextIndex,
        nextIndex + 1,
        firstIndex + 1,
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 3;
  return mesh;
}

function line(
  points: THREE.Vector3[],
  color: number,
  opacity: number,
  dashed = false,
): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = dashed
    ? new THREE.LineDashedMaterial({
        color,
        transparent: true,
        opacity,
        dashSize: 0.18,
        gapSize: 0.12,
      })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const result = new THREE.Line(geometry, material);
  if (dashed) result.computeLineDistances();
  return result;
}

function affineMatrix(axis: THREE.Vector3, axialScale: number): THREE.Matrix4 {
  const factor = axialScale - 1;
  const { x, y, z } = axis;
  return new THREE.Matrix4().set(
    1 + factor * x * x,
    factor * x * y,
    factor * x * z,
    0,
    factor * y * x,
    1 + factor * y * y,
    factor * y * z,
    0,
    factor * z * x,
    factor * z * y,
    1 + factor * z * z,
    0,
    0,
    0,
    0,
    1,
  );
}

function translatedAffineMatrix(
  position: THREE.Vector3,
  axis: THREE.Vector3,
  axialScale: number,
): THREE.Matrix4 {
  const matrix = affineMatrix(axis, axialScale);
  matrix.setPosition(position);
  return matrix;
}

function formatDistance(valueKm: number): string {
  return new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: valueKm > 1_000_000 ? 1 : 0,
    notation: valueKm > 1_000_000 ? "compact" : "standard",
  }).format(valueKm) + " km";
}

const worker = new Worker(
  new URL("./shadow-cones-worker.ts", import.meta.url),
  { type: "module" },
);
let frame: ShadowFrame | null = null;
let displayMode: DisplayMode = "readable";
let eventPeakMs = Date.parse("2026-08-12T17:45:46.794Z");
let rangeStartMs = eventPeakMs - 58 * 60 * 1000;
let rangeEndMs = eventPeakMs + 58 * 60 * 1000;
let requestId = 0;
let latestAppliedRequestId = 0;
let requestInFlight = false;
let queuedTimeMs: number | null = null;
let currentTimeMs = eventPeakMs;
let playing = false;
let previousRenderTimeMs = performance.now();
let previousGeometryRequestMs = 0;

function showError(message: string): void {
  loadingState.hidden = true;
  errorMessage.textContent = message;
  errorState.hidden = false;
}

function requestFrame(timeMs: number): void {
  queuedTimeMs = timeMs;
  if (requestInFlight) return;
  const atUtc = new Date(queuedTimeMs).toISOString();
  queuedTimeMs = null;
  requestInFlight = true;
  requestId += 1;
  worker.postMessage({ type: "frame", requestId, atUtc });
}

worker.addEventListener("message", (message: MessageEvent<WorkerResponse>) => {
  const response = message.data;
  if (response.type === "ready") {
    eventPeakMs = Date.parse(response.event.peakUtc);
    rangeStartMs = eventPeakMs - 58 * 60 * 1000;
    rangeEndMs = eventPeakMs + 58 * 60 * 1000;
    currentTimeMs = eventPeakMs;
    timeSlider.max = String((rangeEndMs - rangeStartMs) / 1000);
    timeSlider.value = String((currentTimeMs - rangeStartMs) / 1000);
    requestFrame(currentTimeMs);
    return;
  }
  requestInFlight = false;
  if (response.type === "error") {
    showError(response.message);
  } else if (response.requestId >= latestAppliedRequestId) {
    latestAppliedRequestId = response.requestId;
    frame = response.frame;
    loadingState.hidden = true;
    errorState.hidden = true;
    updateModel();
  }
  if (queuedTimeMs !== null) requestFrame(queuedTimeMs);
});

worker.addEventListener("error", (event) => {
  showError(event.message || "The eclipse worker stopped unexpectedly.");
});

function updateButtonState(): void {
  readableModeButton.classList.toggle("is-active", displayMode === "readable");
  affineModeButton.classList.toggle("is-active", displayMode === "affine");
  readableModeButton.setAttribute(
    "aria-pressed",
    String(displayMode === "readable"),
  );
  affineModeButton.setAttribute(
    "aria-pressed",
    String(displayMode === "affine"),
  );
}

function updateModel(): void {
  if (!frame) return;
  const axis = vector(frame.direction).normalize();
  const moonPhysical = vector(frame.moonEcefKm);
  const closestAxisPointKm = moonPhysical
    .clone()
    .addScaledVector(
      axis,
      -moonPhysical.dot(axis),
    );
  const closestAxisPoint = closestAxisPointKm.multiplyScalar(
    1 / EARTH_MEAN_RADIUS_KM,
  );
  const sceneMoonDistance = Number(spacingSlider.value);
  const physicalMoonPlaneDistanceEarthRadii =
    frame.axisDistanceToEarthPlaneKm / EARTH_MEAN_RADIUS_KM;
  const axialScale =
    sceneMoonDistance / physicalMoonPlaneDistanceEarthRadii;
  const moonPosition = closestAxisPoint
    .clone()
    .addScaledVector(axis, -sceneMoonDistance);
  const sunPosition = closestAxisPoint
    .clone()
    .addScaledVector(axis, -(sceneMoonDistance + 5.1 + sceneMoonDistance * 0.25));
  const coneLength = sceneMoonDistance + 2.1;
  const displayToPhysicalKm = EARTH_MEAN_RADIUS_KM / axialScale;
  const penumbraSlope =
    (SUN_RADIUS_KM + MOON_RADIUS_KM) / frame.sunMoonDistanceKm;
  const umbraSlope =
    -(SUN_RADIUS_KM - MOON_RADIUS_KM) / frame.sunMoonDistanceKm;
  const umbraMagnification = Number(umbraSlider.value);

  clearLayer(coneLayer);
  clearLayer(guideLayer);
  coneLayer.add(
    coneSurface(
      moonPosition,
      axis,
      coneLength,
      displayToPhysicalKm,
      penumbraSlope,
      0xf2b94d,
      0.115,
    ),
  );
  coneLayer.add(
    coneSurface(
      moonPosition,
      axis,
      coneLength,
      displayToPhysicalKm,
      umbraSlope,
      0x9d7cff,
      0.22,
      umbraMagnification,
    ),
  );
  guideLayer.add(
    line(
      [
        sunPosition.clone().addScaledVector(axis, 0.9),
        moonPosition.clone().addScaledVector(axis, -0.34),
      ],
      0xf8d88b,
      0.36,
      true,
    ),
  );
  guideLayer.add(
    line(
      [
        moonPosition.clone().addScaledVector(axis, 0.3),
        closestAxisPoint.clone().addScaledVector(axis, 2.0),
      ],
      0xc9d2e1,
      0.28,
      true,
    ),
  );

  const [breakFirst, breakSecond] = perpendicularBasis(axis);
  const breakCenter = sunPosition.clone().lerp(moonPosition, 0.55);
  for (const offset of [-0.13, 0.13]) {
    const center = breakCenter.clone().addScaledVector(axis, offset);
    guideLayer.add(
      line(
        [
          center
            .clone()
            .addScaledVector(breakFirst, -0.22)
            .addScaledVector(breakSecond, -0.13),
          center
            .clone()
            .addScaledVector(breakFirst, 0.22)
            .addScaledVector(breakSecond, 0.13),
        ],
        0xf2b94d,
        0.82,
      ),
    );
  }

  const earthMatrix =
    displayMode === "affine"
      ? affineMatrix(axis, axialScale)
      : new THREE.Matrix4();
  earthTransform.matrixAutoUpdate = false;
  earthTransform.matrix.copy(earthMatrix);
  moon.matrix.copy(
    displayMode === "affine"
      ? translatedAffineMatrix(moonPosition, axis, axialScale)
      : new THREE.Matrix4().setPosition(moonPosition),
  );
  sun.position.copy(sunPosition);
  sunLight.position.copy(sunPosition);

  clearLayer(ringLayer);
  for (const ring of frame.penumbraRings) {
    addRing(ring, 0x7ee7f2, 0.009);
  }
  for (const ring of frame.centralRings) {
    addRing(ring, 0xd1c5ff, 0.016);
  }

  const earthSurfacePosition = new THREE.Vector3(0, 1.35, 0);
  if (displayMode === "affine") earthSurfacePosition.applyMatrix4(earthMatrix);
  sunLabel.position.copy(sunPosition).add(new THREE.Vector3(0, 1.25, 0));
  moonLabel.position.copy(moonPosition).add(new THREE.Vector3(0, 0.68, 0));
  earthLabel.position.copy(earthSurfacePosition);
  spainLabel.position.copy(spainPosition);
  if (displayMode === "affine") spainLabel.position.applyMatrix4(earthMatrix);
  spainLabel.position.multiplyScalar(1.08);

  const date = new Date(frame.atUtc);
  dateLabel.textContent = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
  timeLabel.textContent = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
    hourCycle: "h23",
  }).format(date);
  const centralVisible = frame.centralKind !== null;
  statusDot.classList.toggle("is-central", centralVisible);
  shadowKind.textContent = centralVisible
    ? frame.centralKind === "umbra"
      ? "Total-eclipse umbra reaches Earth"
      : "Annular-eclipse antumbra reaches Earth"
    : "Only the penumbra reaches Earth";
  const diameterKm = Math.abs(frame.umbraRadiusAtEarthPlaneKm) * 2;
  umbraWidth.textContent = centralVisible
    ? `${diameterKm.toFixed(0)} km axial cone diameter`
    : "Central cone misses the surface";
  moonDistance.textContent = formatDistance(frame.moonEarthDistanceKm);
  sunDistance.textContent = formatDistance(frame.sunMoonDistanceKm);
  spacingOutput.textContent =
    sceneMoonDistance < 4.5
      ? "compact"
      : sceneMoonDistance > 6.2
        ? "expanded"
        : "balanced";
  umbraOutput.textContent = `${umbraMagnification.toFixed(0)}×`;
}

function setMode(mode: DisplayMode): void {
  displayMode = mode;
  updateButtonState();
  updateModel();
}

readableModeButton.addEventListener("click", () => setMode("readable"));
affineModeButton.addEventListener("click", () => setMode("affine"));

spacingSlider.addEventListener("input", updateModel);
umbraSlider.addEventListener("input", updateModel);

timeSlider.addEventListener("input", () => {
  playing = false;
  playButton.classList.remove("is-playing");
  playButton.querySelector("span")!.textContent = "▶";
  playButton.setAttribute("aria-label", "Play eclipse");
  currentTimeMs = rangeStartMs + Number(timeSlider.value) * 1000;
  requestFrame(currentTimeMs);
});

playButton.addEventListener("click", () => {
  playing = !playing;
  playButton.classList.toggle("is-playing", playing);
  playButton.querySelector("span")!.textContent = playing ? "Ⅱ" : "▶";
  playButton.setAttribute(
    "aria-label",
    playing ? "Pause eclipse" : "Play eclipse",
  );
});

renderer.domElement.addEventListener("dblclick", () => {
  controls.target.set(-1.2, 0, 0);
  camera.position.set(9.2, 5.7, 11.5);
  controls.update();
});

const vrButton = VRButton.createButton(renderer);
vrSlot.append(vrButton);
renderer.xr.addEventListener("sessionstart", () => {
  controls.enabled = false;
  modelRoot.position.set(0, 1.45, -6.4);
  modelRoot.scale.setScalar(0.58);
});
renderer.xr.addEventListener("sessionend", () => {
  controls.enabled = true;
  modelRoot.position.set(0, 0, 0);
  modelRoot.scale.setScalar(1);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

document.addEventListener("visibilitychange", () => {
  previousRenderTimeMs = performance.now();
});

function render(nowMs: number): void {
  const elapsedMs = Math.min(100, nowMs - previousRenderTimeMs);
  previousRenderTimeMs = nowMs;
  if (playing) {
    currentTimeMs += elapsedMs * 180;
    if (currentTimeMs > rangeEndMs) currentTimeMs = rangeStartMs;
    timeSlider.value = String((currentTimeMs - rangeStartMs) / 1000);
    if (nowMs - previousGeometryRequestMs > 160) {
      previousGeometryRequestMs = nowMs;
      requestFrame(currentTimeMs);
    }
  }
  controls.update();
  sun.rotation.y += elapsedMs * 0.00006;
  renderer.render(scene, camera);
}

updateButtonState();
renderer.setAnimationLoop(render);
