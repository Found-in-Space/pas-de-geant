import "./spacefarer.css";

import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import {
  EARTH_MEAN_RADIUS_KM,
  MOON_RADIUS_KM,
  SUN_RADIUS_KM,
  type CartesianVector,
  type EclipseSummary,
} from "@found-in-space/shadowline";
import type { CartesianBasis } from "./celestial-frame.js";
import {
  WGS84_DISPLAY_AXES,
  createGeodeticEllipsoidGeometry,
  ecefKmToDisplay,
  geodeticDisplayPosition,
  projectDirectionToWgs84Display,
} from "./earth-ellipsoid.js";
import { FreeSpaceControls } from "./free-space-controls.js";
import { inwardSurfaceRibbon } from "./surface-ribbon.js";

interface ShadowFrame {
  event: EclipseSummary;
  atUtc: string;
  sunEcefKm: CartesianVector;
  moonEcefKm: CartesianVector;
  direction: CartesianVector;
  ecefToEquatorialJ2000: CartesianBasis;
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
  | { type: "range"; startUtc: string; endUtc: string }
  | { type: "range-error"; message: string }
  | { type: "frame"; requestId: number; frame: ShadowFrame }
  | { type: "error"; requestId: number; message: string };

type ViewPreset = "system" | "earth" | "moon" | "shadow";

const SUN_DISC_DISTANCE = 650;
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
const dateLabel = element<HTMLSpanElement>("date-label");
const timeLabel = element<HTMLElement>("time-label");
const shadowKind = element<HTMLSpanElement>("shadow-kind");
const umbraWidth = element<HTMLElement>("umbra-width");
const statusDot = element<HTMLSpanElement>("status-dot");
const moonDistance = element<HTMLElement>("moon-distance");
const moonDistanceRadii = element<HTMLElement>("moon-distance-radii");
const sunAngle = element<HTMLElement>("sun-angle");
const presetButtons: Record<ViewPreset, HTMLButtonElement> = {
  system: element<HTMLButtonElement>("system-view"),
  earth: element<HTMLButtonElement>("earth-view"),
  moon: element<HTMLButtonElement>("moon-view"),
  shadow: element<HTMLButtonElement>("shadow-view"),
};

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  logarithmicDepthBuffer: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.xr.enabled = true;
sceneRoot.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.02,
  1200,
);
camera.position.set(0, 17, 52);
camera.lookAt(-30, 0, 0);

const controls = new FreeSpaceControls(camera, renderer.domElement, {
  navigationScale,
  onNavigate: () => setActivePreset(null),
});

const modelRoot = new THREE.Group();
const physicalRoot = new THREE.Group();
modelRoot.add(physicalRoot);
scene.add(modelRoot);

scene.add(new THREE.HemisphereLight(0x7998c2, 0x05050a, 0.42));
const sunLight = new THREE.DirectionalLight(0xffe6ae, 3.8);
sunLight.target.position.set(0, 0, 0);
physicalRoot.add(sunLight, sunLight.target);

function vector(value: CartesianVector, scaleValue = 1): THREE.Vector3 {
  return new THREE.Vector3(
    value.x * scaleValue,
    value.z * scaleValue,
    -value.y * scaleValue,
  );
}

function ecefToInertialMatrix(basis: CartesianBasis): THREE.Matrix4 {
  const localX = vector(basis.x).normalize();
  const localY = vector(basis.z).normalize();
  const localZ = vector(basis.y).multiplyScalar(-1).normalize();
  return new THREE.Matrix4().makeBasis(localX, localY, localZ);
}

function stageOrientation(earthFromSun: THREE.Vector3): THREE.Matrix4 {
  const stageX = earthFromSun.clone().normalize();
  const inertialNorth = new THREE.Vector3(0, 1, 0);
  let stageY = inertialNorth
    .clone()
    .addScaledVector(stageX, -inertialNorth.dot(stageX));
  if (stageY.lengthSq() < 1e-8) {
    stageY = new THREE.Vector3(0, 0, 1).addScaledVector(stageX, -stageX.z);
  }
  stageY.normalize();
  const stageZ = new THREE.Vector3().crossVectors(stageX, stageY).normalize();
  return new THREE.Matrix4().set(
    stageX.x,
    stageX.y,
    stageX.z,
    0,
    stageY.x,
    stageY.y,
    stageY.z,
    0,
    stageZ.x,
    stageZ.y,
    stageZ.z,
    0,
    0,
    0,
    0,
    1,
  );
}

function withLogarithmicDepthBias<T extends THREE.Material>(
  material: T,
  bias: number,
  cacheKey: string,
): T {
  const existingCompile = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, webglRenderer) => {
    existingCompile(shader, webglRenderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <logdepthbuf_fragment>",
      `#include <logdepthbuf_fragment>
#if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
  gl_FragDepth = max( 0.0, gl_FragDepth - ${bias.toExponential(8)} );
#endif`,
    );
  };
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

function deterministicStars(): THREE.Points {
  let seed = 975318642;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();
  for (let index = 0; index < 1250; index += 1) {
    const cosine = random() * 2 - 1;
    const sine = Math.sqrt(1 - cosine * cosine);
    const angle = random() * Math.PI * 2;
    positions.push(
      720 * sine * Math.cos(angle),
      720 * cosine,
      720 * sine * Math.sin(angle),
    );
    color.setHSL(0.54 + random() * 0.1, 0.2, 0.55 + random() * 0.4);
    colors.push(color.r, color.g, color.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: 0.9,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    }),
  );
}

function sunTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas textures are unavailable.");
  const glow = context.createRadialGradient(128, 128, 6, 128, 128, 128);
  glow.addColorStop(0, "rgba(255,255,242,1)");
  glow.addColorStop(0.43, "rgba(255,224,138,1)");
  glow.addColorStop(0.5, "rgba(255,184,70,0.98)");
  glow.addColorStop(0.58, "rgba(255,177,62,0.24)");
  glow.addColorStop(0.77, "rgba(255,143,38,0.06)");
  glow.addColorStop(1, "rgba(255,120,24,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const celestialLayer = new THREE.Group();
const stars = deterministicStars();
const sunDisc = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: sunTexture(),
    color: 0xffffff,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
sunDisc.renderOrder = -5;
celestialLayer.add(stars, sunDisc);
scene.add(celestialLayer);

const earthFixedGroup = new THREE.Group();
earthFixedGroup.matrixAutoUpdate = false;
physicalRoot.add(earthFixedGroup);

const earthTexture = new THREE.TextureLoader().load("/bluemarble-2048.png");
earthTexture.colorSpace = THREE.SRGBColorSpace;
earthTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const earth = new THREE.Mesh(
  createGeodeticEllipsoidGeometry(256, 128),
  new THREE.MeshStandardMaterial({
    map: earthTexture,
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.01,
    emissive: 0x07111a,
    emissiveMap: earthTexture,
    emissiveIntensity: 0.16,
  }),
);
earthFixedGroup.add(earth);

const atmosphere = new THREE.Mesh(
  createGeodeticEllipsoidGeometry(128, 64, 100),
  new THREE.MeshBasicMaterial({
    color: 0x79ddeb,
    transparent: true,
    opacity: 0.095,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
earthFixedGroup.add(atmosphere);

function graticule(): THREE.LineSegments {
  const positions: number[] = [];
  const addSegment = (first: THREE.Vector3, second: THREE.Vector3) => {
    positions.push(first.x, first.y, first.z, second.x, second.y, second.z);
  };
  const spherePoint = (latitude: number, longitude: number) => {
    return geodeticDisplayPosition(latitude, longitude);
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
  const result = new THREE.LineSegments(
    geometry,
    withLogarithmicDepthBias(
      new THREE.LineBasicMaterial({
        color: 0xa7edf3,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      2e-7,
      "spacefarer-graticule-depth-bias-v1",
    ),
  );
  result.renderOrder = 4;
  return result;
}
earthFixedGroup.add(graticule());

const moonTexture = new THREE.TextureLoader().load("/lroc-color-2k.jpg");
moonTexture.colorSpace = THREE.SRGBColorSpace;
moonTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const moon = new THREE.Mesh(
  new THREE.SphereGeometry(MOON_RADIUS_KM / EARTH_MEAN_RADIUS_KM, 64, 40),
  new THREE.MeshStandardMaterial({
    map: moonTexture,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    emissive: 0x080808,
    emissiveMap: moonTexture,
    emissiveIntensity: 0.12,
  }),
);
physicalRoot.add(moon);

const ringLayer = new THREE.Group();
earthFixedGroup.add(ringLayer);
const coneLayer = new THREE.Group();
const guideLayer = new THREE.Group();
physicalRoot.add(coneLayer, guideLayer);
const stageToEarthFixed = new THREE.Matrix4();

function disposeObject(object: THREE.Object3D): void {
  const candidate = object as THREE.Mesh | THREE.Line;
  candidate.geometry?.dispose();
  const material = candidate.material;
  if (Array.isArray(material)) {
    for (const item of material) item.dispose();
  } else {
    material?.dispose();
  }
}

function clearLayer(layer: THREE.Group): void {
  for (const child of [...layer.children]) {
    child.traverse(disposeObject);
    layer.remove(child);
  }
}

function addSurfaceBoundary(
  points: CartesianVector[],
  color: number,
  maximumWidthRadians: number,
  renderOrder: number,
): void {
  const ribbon = inwardSurfaceRibbon(
    points.map((point) => ecefKmToDisplay(point)),
    maximumWidthRadians,
    projectDirectionToWgs84Display,
  );
  if (ribbon.boundary.length < 3) return;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const boundaryColor = new THREE.Color(color);
  for (let index = 0; index < ribbon.boundary.length; index += 1) {
    const outer = ribbon.boundary[index]!;
    const inner = ribbon.inset[index]!;
    positions.push(outer.x, outer.y, outer.z, inner.x, inner.y, inner.z);
    colors.push(
      boundaryColor.r,
      boundaryColor.g,
      boundaryColor.b,
      1,
      boundaryColor.r,
      boundaryColor.g,
      boundaryColor.b,
      0,
    );
  }
  for (let index = 0; index < ribbon.boundary.length; index += 1) {
    const next = (index + 1) % ribbon.boundary.length;
    const outer = index * 2;
    const inner = outer + 1;
    const nextOuter = next * 2;
    const nextInner = nextOuter + 1;
    indices.push(outer, inner, nextOuter, nextOuter, inner, nextInner);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  const material = withLogarithmicDepthBias(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.94,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      alphaToCoverage: true,
    }),
    4e-7,
    "spacefarer-surface-boundary-depth-bias-v1",
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = renderOrder;
  ringLayer.add(mesh);
}

function perpendicularBasis(
  axis: THREE.Vector3,
): [THREE.Vector3, THREE.Vector3] {
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
  slope: number,
  color: number,
  opacity: number,
): THREE.Mesh {
  const radialSegments = 180;
  const lengthSegments = 96;
  const [first, second] = perpendicularBasis(axis);
  const positions: number[] = [];
  const coneRayDirections: number[] = [];
  const indices: number[] = [];
  for (let alongIndex = 0; alongIndex <= lengthSegments; alongIndex += 1) {
    const along = (displayLength * alongIndex) / lengthSegments;
    const physicalAlongKm = along * EARTH_MEAN_RADIUS_KM;
    const physicalRadiusKm = MOON_RADIUS_KM + slope * physicalAlongKm;
    const displayRadius = Math.abs(physicalRadiusKm) / EARTH_MEAN_RADIUS_KM;
    const radiusSign = physicalRadiusKm < 0 ? -1 : 1;
    const center = start.clone().addScaledVector(axis, along);
    for (let radialIndex = 0; radialIndex <= radialSegments; radialIndex += 1) {
      const angle = (radialIndex / radialSegments) * Math.PI * 2;
      const radialDirection = first
        .clone()
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(second, Math.sin(angle));
      const point = center
        .clone()
        .addScaledVector(radialDirection, displayRadius);
      const coneRayDirection = axis
        .clone()
        .addScaledVector(radialDirection, slope * radiusSign)
        .normalize();
      positions.push(point.x, point.y, point.z);
      coneRayDirections.push(
        coneRayDirection.x,
        coneRayDirection.y,
        coneRayDirection.z,
      );
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
  geometry.setAttribute(
    "coneRayDirection",
    new THREE.Float32BufferAttribute(coneRayDirections, 3),
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
  material.onBeforeCompile = (shader) => {
    shader.uniforms["stageToEarthFixed"] = {
      value: stageToEarthFixed,
    };
    shader.uniforms["wgs84DisplayAxes"] = {
      value: WGS84_DISPLAY_AXES,
    };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec3 coneRayDirection;
varying vec3 vStagePosition;
varying vec3 vConeRayDirection;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vStagePosition = transformed;
vConeRayDirection = coneRayDirection;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform mat4 stageToEarthFixed;
uniform vec3 wgs84DisplayAxes;
varying vec3 vStagePosition;
varying vec3 vConeRayDirection;`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
vec3 earthFixedPosition =
  ( stageToEarthFixed * vec4( vStagePosition, 1.0 ) ).xyz;
vec3 ellipsoidPosition = earthFixedPosition / wgs84DisplayAxes;
vec3 earthFixedRayDirection =
  ( stageToEarthFixed * vec4( normalize( vConeRayDirection ), 0.0 ) ).xyz;
vec3 ellipsoidRayDirection =
  normalize( earthFixedRayDirection / wgs84DisplayAxes );
float rayProjection = dot( ellipsoidPosition, ellipsoidRayDirection );
float rayDiscriminant =
  rayProjection * rayProjection -
  ( dot( ellipsoidPosition, ellipsoidPosition ) - 1.0 );
if (
  rayDiscriminant >= 0.0 &&
  rayProjection + sqrt( max( 0.0, rayDiscriminant ) ) > 0.00001
) discard;`,
      );
  };
  material.customProgramCacheKey = () =>
    "spacefarer-wgs84-cone-interception-v2";
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
        dashSize: 0.24,
        gapSize: 0.16,
      })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
  const result = new THREE.Line(geometry, material);
  if (dashed) result.computeLineDistances();
  return result;
}

function formatDistance(valueKm: number): string {
  return `${new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 0,
  }).format(valueKm)} km`;
}

let inertialToStage: THREE.Matrix4 | null = null;
let frame: ShadowFrame | null = null;
let moonStagePosition = new THREE.Vector3(-60, 0, 0);
let shadowAxisStage = new THREE.Vector3(1, 0, 0);
let sunDirectionStage = new THREE.Vector3(-1, 0, 0);
let sunAngularRadiusRad = THREE.MathUtils.degToRad(0.266);
let activePreset: ViewPreset | null = "system";
let initialViewApplied = false;

function nearestSurfaceDistance(): number {
  const earthSurfaceDistance = Math.abs(camera.position.length() - 1);
  const moonSurfaceDistance = Math.abs(
    camera.position.distanceTo(moonStagePosition) -
      MOON_RADIUS_KM / EARTH_MEAN_RADIUS_KM,
  );
  return Math.min(earthSurfaceDistance, moonSurfaceDistance);
}

function navigationScale(): number {
  return Math.max(0.0002, nearestSurfaceDistance() * 0.12);
}

function updateCameraClipping(): void {
  const earthDistance = camera.position.length() + 1;
  const moonDistance =
    camera.position.distanceTo(moonStagePosition) +
    MOON_RADIUS_KM / EARTH_MEAN_RADIUS_KM;
  const nextNear = Math.max(
    0.00001,
    Math.min(0.02, nearestSurfaceDistance() * 0.003),
  );
  const nextFar = Math.max(1200, earthDistance * 3, moonDistance * 3);
  const nearChanged = Math.abs(camera.near - nextNear) > nextNear * 0.08;
  const farChanged = Math.abs(camera.far - nextFar) > nextFar * 0.08;
  if (nearChanged || farChanged) {
    camera.near = nextNear;
    camera.far = nextFar;
    camera.updateProjectionMatrix();
  }
}

function updateStage(frameValue: ShadowFrame): void {
  const ecefToInertial = ecefToInertialMatrix(frameValue.ecefToEquatorialJ2000);
  if (!inertialToStage) {
    const earthFromSun = vector(frameValue.sunEcefKm)
      .applyMatrix4(ecefToInertial)
      .multiplyScalar(-1);
    inertialToStage = stageOrientation(earthFromSun);
  }
  const earthFixedToStage = inertialToStage.clone().multiply(ecefToInertial);
  stageToEarthFixed.copy(earthFixedToStage).invert();
  earthFixedGroup.matrix.copy(earthFixedToStage);
  earthFixedGroup.matrixWorldNeedsUpdate = true;
  moonStagePosition = ecefKmToDisplay(frameValue.moonEcefKm).applyMatrix4(
    earthFixedToStage,
  );
  shadowAxisStage = vector(frameValue.direction)
    .transformDirection(earthFixedToStage)
    .normalize();
  sunDirectionStage = vector(frameValue.sunEcefKm)
    .transformDirection(earthFixedToStage)
    .normalize();
  moon.position.copy(moonStagePosition);
  moon.quaternion.setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    moonStagePosition.clone().negate().normalize(),
  );
  sunAngularRadiusRad = Math.asin(SUN_RADIUS_KM / frameValue.sunMoonDistanceKm);
  sunLight.position.copy(sunDirectionStage).multiplyScalar(100);
}

function updateCones(frameValue: ShadowFrame): void {
  clearLayer(coneLayer);
  clearLayer(guideLayer);
  const coneLength =
    frameValue.axisDistanceToEarthPlaneKm / EARTH_MEAN_RADIUS_KM + 2.3;
  const penumbraSlope =
    (SUN_RADIUS_KM + MOON_RADIUS_KM) / frameValue.sunMoonDistanceKm;
  const umbraSlope =
    -(SUN_RADIUS_KM - MOON_RADIUS_KM) / frameValue.sunMoonDistanceKm;
  coneLayer.add(
    coneSurface(
      moonStagePosition,
      shadowAxisStage,
      coneLength,
      penumbraSlope,
      0xf2b94d,
      0.13,
    ),
  );
  coneLayer.add(
    coneSurface(
      moonStagePosition,
      shadowAxisStage,
      coneLength,
      umbraSlope,
      0x9d7cff,
      0.26,
    ),
  );
  guideLayer.add(
    line(
      [
        moonStagePosition.clone().addScaledVector(shadowAxisStage, -5),
        moonStagePosition.clone(),
      ],
      0xffe3a1,
      0.7,
      true,
    ),
  );
  guideLayer.add(
    line(
      [
        moonStagePosition.clone(),
        moonStagePosition.clone().addScaledVector(shadowAxisStage, coneLength),
      ],
      0xcad5e9,
      0.25,
      true,
    ),
  );
}

function updateFootprints(frameValue: ShadowFrame): void {
  clearLayer(ringLayer);
  for (const ring of frameValue.penumbraRings) {
    addSurfaceBoundary(ring, 0x7ee7f2, 0.0012, 5);
  }
  for (const ring of frameValue.centralRings) {
    addSurfaceBoundary(ring, 0xd1c5ff, 0.0012, 6);
  }
}

function updateReadout(frameValue: ShadowFrame): void {
  const date = new Date(frameValue.atUtc);
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
  const centralVisible = frameValue.centralKind !== null;
  statusDot.classList.toggle("is-central", centralVisible);
  shadowKind.textContent = centralVisible
    ? frameValue.centralKind === "umbra"
      ? "Total-eclipse umbra reaches Earth"
      : "Annular-eclipse antumbra reaches Earth"
    : frameValue.penumbraRings.length > 0
      ? "Only the penumbra reaches Earth"
      : "Penumbral cone is tangent to Earth";
  const diameterKm = Math.abs(frameValue.umbraRadiusAtEarthPlaneKm) * 2;
  umbraWidth.textContent = centralVisible
    ? `${diameterKm.toFixed(0)} km axial cone diameter`
    : "Central cone misses the surface";
  moonDistance.textContent = formatDistance(frameValue.moonEarthDistanceKm);
  moonDistanceRadii.textContent = `${(
    frameValue.moonEarthDistanceKm / EARTH_MEAN_RADIUS_KM
  ).toFixed(2)} R⊕`;
  sunAngle.textContent = `${THREE.MathUtils.radToDeg(
    sunAngularRadiusRad * 2,
  ).toFixed(3)}° diameter`;
}

function updateModel(): void {
  if (!frame) return;
  updateStage(frame);
  updateCones(frame);
  updateFootprints(frame);
  updateReadout(frame);
  if (!initialViewApplied) {
    initialViewApplied = true;
    applyViewPreset("system");
  }
}

function setActivePreset(preset: ViewPreset | null): void {
  activePreset = preset;
  for (const [name, button] of Object.entries(presetButtons)) {
    const isActive = name === preset;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

function applyViewPreset(preset: ViewPreset): void {
  setActivePreset(preset);
  const separation = Math.max(1, moonStagePosition.length());
  const [side, up] = perpendicularBasis(shadowAxisStage);
  let target: THREE.Vector3;
  let position: THREE.Vector3;
  if (preset === "earth") {
    target = new THREE.Vector3();
    position = target
      .clone()
      .addScaledVector(side, 7.4)
      .addScaledVector(up, 3.2);
  } else if (preset === "moon") {
    target = moonStagePosition.clone();
    position = target
      .clone()
      .addScaledVector(side, 2.35)
      .addScaledVector(up, 0.9);
  } else if (preset === "shadow") {
    position = moonStagePosition
      .clone()
      .multiplyScalar(0.58)
      .addScaledVector(side, 2.1)
      .addScaledVector(up, 0.5);
    target = new THREE.Vector3();
  } else {
    target = moonStagePosition.clone().multiplyScalar(0.5);
    position = target
      .clone()
      .addScaledVector(side, separation * 0.82)
      .addScaledVector(up, separation * 0.29);
  }
  camera.position.copy(position);
  camera.lookAt(target);
  updateCameraClipping();
}

for (const [name, button] of Object.entries(presetButtons)) {
  button.addEventListener("click", () => applyViewPreset(name as ViewPreset));
}

const worker = new Worker(
  new URL("./shadow-cones-worker.ts", import.meta.url),
  { type: "module" },
);
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
  worker.postMessage({
    type: "frame",
    requestId,
    atUtc,
    angularIntervalDegrees: 0.25,
  });
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
    worker.postMessage({ type: "range" });
    return;
  }
  if (response.type === "range") {
    const startMs = Date.parse(response.startUtc);
    const endMs = Date.parse(response.endUtc);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs >= eventPeakMs ||
      endMs <= eventPeakMs
    ) {
      console.error("The worker returned an invalid eclipse extent.", response);
      return;
    }
    rangeStartMs = startMs;
    rangeEndMs = endMs;
    currentTimeMs = Math.max(
      rangeStartMs,
      Math.min(rangeEndMs, currentTimeMs),
    );
    timeSlider.max = String((rangeEndMs - rangeStartMs) / 1000);
    timeSlider.value = String((currentTimeMs - rangeStartMs) / 1000);
    return;
  }
  if (response.type === "range-error") {
    console.error("Could not calculate the full eclipse extent:", response.message);
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
  applyViewPreset("system");
});

const vrButton = VRButton.createButton(renderer);
vrSlot.append(vrButton);
renderer.xr.addEventListener("sessionstart", () => {
  controls.enabled = false;
  modelRoot.scale.setScalar(0.09);
  modelRoot.position.set(2.7, 1.35, -5.8);
});
renderer.xr.addEventListener("sessionend", () => {
  controls.enabled = true;
  modelRoot.position.set(0, 0, 0);
  modelRoot.scale.setScalar(1);
});

const xrForward = new THREE.Vector3();
const xrRight = new THREE.Vector3();
const xrUp = new THREE.Vector3();
const xrMovement = new THREE.Vector3();
const xrViewQuaternion = new THREE.Quaternion();

function xrStick(source: XRInputSource | undefined): [number, number] {
  const axes = source?.gamepad?.axes;
  if (!axes || axes.length < 2) return [0, 0];
  const offset = axes.length >= 4 ? axes.length - 2 : 0;
  return [deadzone(axes[offset] ?? 0), deadzone(axes[offset + 1] ?? 0)];
}

function deadzone(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude < 0.16) return 0;
  return (Math.sign(value) * (magnitude - 0.16)) / 0.84;
}

function updateXrNavigation(deltaSeconds: number): void {
  const session = renderer.xr.getSession();
  if (!session) return;
  const sources = [...session.inputSources].filter(
    (source) => source.gamepad !== undefined,
  );
  const primary =
    sources.find((source) => source.handedness === "left") ?? sources[0];
  const verticalSource = sources.find(
    (source) => source !== primary && source.handedness === "right",
  );
  const [sideways, forwardAxis] = xrStick(primary);
  const [, verticalAxis] = xrStick(verticalSource);
  if (sideways === 0 && forwardAxis === 0 && verticalAxis === 0) return;

  renderer.xr.getCamera().getWorldQuaternion(xrViewQuaternion);
  xrForward.set(0, 0, -1).applyQuaternion(xrViewQuaternion);
  xrRight.set(1, 0, 0).applyQuaternion(xrViewQuaternion);
  xrUp.set(0, 1, 0).applyQuaternion(xrViewQuaternion);
  xrMovement
    .set(0, 0, 0)
    .addScaledVector(xrRight, sideways)
    .addScaledVector(xrForward, -forwardAxis)
    .addScaledVector(xrUp, -verticalAxis);
  if (xrMovement.lengthSq() > 1) xrMovement.normalize();

  const boost = primary?.gamepad?.buttons.some((button) => button.pressed)
    ? 2.8
    : 1;
  modelRoot.position.addScaledVector(xrMovement, -1.25 * boost * deltaSeconds);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

document.addEventListener("visibilitychange", () => {
  previousRenderTimeMs = performance.now();
});

const cameraWorldPosition = new THREE.Vector3();
function updateCelestialLayer(): void {
  const viewCamera = renderer.xr.isPresenting
    ? renderer.xr.getCamera()
    : camera;
  viewCamera.getWorldPosition(cameraWorldPosition);
  stars.position.copy(cameraWorldPosition);
  sunDisc.position
    .copy(cameraWorldPosition)
    .addScaledVector(sunDirectionStage, SUN_DISC_DISTANCE);
  const planeSize = 4 * SUN_DISC_DISTANCE * Math.tan(sunAngularRadiusRad);
  sunDisc.scale.set(planeSize, planeSize, 1);
}

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
  controls.update(elapsedMs / 1000);
  if (renderer.xr.isPresenting) updateXrNavigation(elapsedMs / 1000);
  updateCameraClipping();
  updateCelestialLayer();
  renderer.render(scene, camera);
}

setActivePreset(activePreset);
renderer.setAnimationLoop(render);
