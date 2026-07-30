import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
  normalizedRadialOffsetForMetres,
} from "./planet-state.js";
import {
  LocalTerrainRenderer,
  type LocalTerrainImageryPatch,
} from "./local-terrain.js";
import type { ReliefDataset } from "./relief.js";
import { terrainHorizonDegrees } from "./terrain-horizon.js";

export { terrainHorizonDegrees } from "./terrain-horizon.js";

const GIBS_WMTS =
  "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/" +
  "BlueMarble_ShadedRelief_Bathymetry/default/500m";
const GIBS_ROOT_TILE_SPAN_DEGREES = 288;
const GIBS_TILE_SIZE = 512;
const GIBS_PROJECTED_TEXEL_TARGET_M = 0.01;
const PROGRESSIVE_GIBS_IMAGERY_ENABLED = false;
const TILE_SEGMENTS = 24;
const SKIRT_DEPTH_WORLD_M = 0.02;
const OCCLUDER_SEGMENTS = 96;
const OCCLUDER_MARGIN_SOURCE_M = 500;
const OCCLUDER_MARGIN_WORLD_M = 0.002;
const FALLBACK_MAX_ELEVATION_M = 8_849;
export const DETAIL_TILE_LIMIT = 32;
export const IMAGERY_CACHE_LIMIT = 48;
export const MAX_CONCURRENT_IMAGERY_REQUESTS = 6;
export const IMAGERY_RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;
export const MIN_GLOBAL_TERRAIN_LEVEL = 0;
export const MAX_GLOBAL_TERRAIN_LEVEL = 7;
const FINE_REFINEMENT_RADIUS_DEGREES = 8;
const EXACT_IMAGERY_PRIORITY_OFFSET = 1_000;
const LAND_AMBIENT_LIGHT = 0.46;
const LAND_DIRECT_LIGHT = 0.72;
const LAND_DARK_SHADOW_LIFT = 0.18;
const LAND_DARK_LUMINANCE = 0.12;
const LAND_BRIGHT_LUMINANCE = 0.5;
const LAND_DARK_TONE_LIFT = 0.16;
const LAND_LIT_TONE_FRACTION = 0.35;

export interface TileAddress {
  z: number;
  x: number;
  y: number;
}

export interface TileBounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

export interface UvTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

interface CachedImagery {
  texture: THREE.Texture;
  usedAt: number;
}

interface RenderedTile {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  lastUsedAt: number;
  address: TileAddress;
  baseBoundingRadius: number;
  imagerySource?: TileAddress;
}

export interface ImageryLoadTask {
  address: TileAddress;
  priority: number;
}

export function tileKey(address: TileAddress): string {
  return `${address.z}/${address.x}/${address.y}`;
}

export function imageryUrlForTile(address: TileAddress): string {
  return `${GIBS_WMTS}/${address.z}/${address.y}/${address.x}.jpeg`;
}

export function imageryRetryDelayMs(failedAttempts: number): number {
  const index = Math.max(
    0,
    Math.min(
      IMAGERY_RETRY_DELAYS_MS.length - 1,
      Math.floor(failedAttempts) - 1,
    ),
  );
  return IMAGERY_RETRY_DELAYS_MS[index]!;
}

export function terrainMaximumLevel(
  displayRadiusM: number,
  latitudeDegrees = 0,
): number {
  const latitudeRadians =
    (Math.max(-90, Math.min(90, latitudeDegrees)) * Math.PI) / 180;
  for (
    let level = MIN_GLOBAL_TERRAIN_LEVEL;
    level <= MAX_GLOBAL_TERRAIN_LEVEL;
    level += 1
  ) {
    const tileSpanRadians =
      ((GIBS_ROOT_TILE_SPAN_DEGREES / 2 ** level) * Math.PI) / 180;
    const projectedTexelM =
      (Math.max(0.001, displayRadiusM) *
        Math.max(0, Math.cos(latitudeRadians)) *
        tileSpanRadians) /
      GIBS_TILE_SIZE;
    if (projectedTexelM <= GIBS_PROJECTED_TEXEL_TARGET_M) {
      return level;
    }
  }
  return MAX_GLOBAL_TERRAIN_LEVEL;
}

export function tileMatrixDimensions(level: number): {
  columns: number;
  rows: number;
} {
  const span = GIBS_ROOT_TILE_SPAN_DEGREES / 2 ** level;
  return {
    columns: Math.ceil(360 / span),
    rows: Math.ceil(180 / span),
  };
}

function isValidTileAddress(address: TileAddress): boolean {
  const dimensions = tileMatrixDimensions(address.z);
  return (
    address.z >= 0 &&
    address.x >= 0 &&
    address.y >= 0 &&
    address.x < dimensions.columns &&
    address.y < dimensions.rows
  );
}

export function rawBoundsForTile(address: TileAddress): TileBounds {
  const span = GIBS_ROOT_TILE_SPAN_DEGREES / 2 ** address.z;
  const west = -180 + address.x * span;
  const north = 90 - address.y * span;
  return {
    west,
    east: west + span,
    north,
    south: north - span,
  };
}

export function boundsForTile(address: TileAddress): TileBounds {
  const raw = rawBoundsForTile(address);
  return {
    west: Math.max(-180, raw.west),
    east: Math.min(180, raw.east),
    north: Math.min(90, raw.north),
    south: Math.max(-90, raw.south),
  };
}

export function childrenForTile(address: TileAddress): TileAddress[] {
  const nextZ = address.z + 1;
  const children: TileAddress[] = [];
  for (const y of [address.y * 2, address.y * 2 + 1]) {
    for (const x of [address.x * 2, address.x * 2 + 1]) {
      const child = { z: nextZ, x, y };
      if (isValidTileAddress(child)) children.push(child);
    }
  }
  return children;
}

export function previewAddressForTile(
  address: TileAddress,
  levelsCoarser = 2,
): TileAddress {
  const z = Math.max(0, address.z - levelsCoarser);
  const divisor = 2 ** (address.z - z);
  return {
    z,
    x: Math.floor(address.x / divisor),
    y: Math.floor(address.y / divisor),
  };
}

export function imageryUvTransform(
  address: TileAddress,
  source: TileAddress,
): UvTransform {
  if (source.z > address.z) {
    throw new Error("Imagery source must be the tile or one of its ancestors.");
  }
  const divisor = 2 ** (address.z - source.z);
  if (
    Math.floor(address.x / divisor) !== source.x ||
    Math.floor(address.y / divisor) !== source.y
  ) {
    throw new Error("Imagery source does not contain the terrain tile.");
  }
  return {
    scaleX: 1 / divisor,
    scaleY: 1 / divisor,
    offsetX: (address.x - source.x * divisor) / divisor,
    offsetY: (address.y - source.y * divisor) / divisor,
  };
}

export function isTileAncestor(
  possibleAncestor: TileAddress,
  address: TileAddress,
): boolean {
  if (possibleAncestor.z > address.z) return false;
  const divisor = 2 ** (address.z - possibleAncestor.z);
  return (
    Math.floor(address.x / divisor) === possibleAncestor.x &&
    Math.floor(address.y / divisor) === possibleAncestor.y
  );
}

export function fallbackUvTransform(address: TileAddress): UvTransform {
  const raw = rawBoundsForTile(address);
  return {
    scaleX: (raw.east - raw.west) / 360,
    scaleY: (raw.north - raw.south) / 180,
    offsetX: (raw.west + 180) / 360,
    offsetY: (90 - raw.north) / 180,
  };
}

export function adaptiveLandLight(
  luminance: number,
  directLight: number,
): number {
  const lightness = Math.max(0, Math.min(1, luminance));
  const direct = Math.max(0, Math.min(1, directLight));
  const darkSurface = darkSurfaceFactor(lightness);
  const shadowLift = LAND_DARK_SHADOW_LIFT * darkSurface;
  return (
    LAND_AMBIENT_LIGHT + shadowLift + direct * (LAND_DIRECT_LIGHT - shadowLift)
  );
}

export function adaptiveLandLuminance(
  luminance: number,
  directLight: number,
): number {
  const lightness = Math.max(0, Math.min(1, luminance));
  const direct = Math.max(0, Math.min(1, directLight));
  const toneLift =
    LAND_DARK_TONE_LIFT *
    darkSurfaceFactor(lightness) *
    THREE.MathUtils.lerp(1, LAND_LIT_TONE_FRACTION, direct);
  return THREE.MathUtils.lerp(lightness, Math.sqrt(lightness), toneLift);
}

function darkSurfaceFactor(luminance: number): number {
  const fraction = Math.max(
    0,
    Math.min(
      1,
      (luminance - LAND_DARK_LUMINANCE) /
        (LAND_BRIGHT_LUMINANCE - LAND_DARK_LUMINANCE),
    ),
  );
  const smoothFraction = fraction * fraction * (3 - 2 * fraction);
  return 1 - smoothFraction;
}

function angularDistanceDegrees(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const latA = THREE.MathUtils.degToRad(latitudeA);
  const latB = THREE.MathUtils.degToRad(latitudeB);
  const deltaLongitude = THREE.MathUtils.degToRad(longitudeB - longitudeA);
  return THREE.MathUtils.radToDeg(
    Math.acos(
      Math.max(
        -1,
        Math.min(
          1,
          Math.sin(latA) * Math.sin(latB) +
            Math.cos(latA) * Math.cos(latB) * Math.cos(deltaLongitude),
        ),
      ),
    ),
  );
}

function tileAngularRadius(bounds: TileBounds): number {
  return Math.hypot(
    (bounds.east - bounds.west) * 0.5,
    (bounds.north - bounds.south) * 0.5,
  );
}

function distanceFromTile(
  address: TileAddress,
  latitudeDegrees: number,
  longitudeDegrees: number,
): number {
  const bounds = boundsForTile(address);
  return angularDistanceDegrees(
    latitudeDegrees,
    longitudeDegrees,
    (bounds.north + bounds.south) * 0.5,
    (bounds.west + bounds.east) * 0.5,
  );
}

export function prioritizeTerrainTiles(
  addresses: TileAddress[],
  latitudeDegrees: number,
  longitudeDegrees: number,
): TileAddress[] {
  return [...addresses].sort((first, second) => {
    const distance =
      distanceFromTile(first, latitudeDegrees, longitudeDegrees) -
      distanceFromTile(second, latitudeDegrees, longitudeDegrees);
    return distance || second.z - first.z;
  });
}

export function imageryLoadTasksForTiles(
  prioritizedAddresses: TileAddress[],
): ImageryLoadTask[] {
  const previews = new Map<string, ImageryLoadTask>();
  const exact: ImageryLoadTask[] = [];
  prioritizedAddresses.forEach((address, index) => {
    const preview = previewAddressForTile(address);
    const previewKey = tileKey(preview);
    const existing = previews.get(previewKey);
    if (!existing || index < existing.priority) {
      previews.set(previewKey, { address: preview, priority: index });
    }
    exact.push({
      address,
      priority: EXACT_IMAGERY_PRIORITY_OFFSET + index,
    });
  });
  return [
    ...[...previews.values()].sort(
      (first, second) => first.priority - second.priority,
    ),
    ...exact,
  ];
}

export function selectTerrainTiles(
  latitudeDegrees: number,
  longitudeDegrees: number,
  displayRadiusM: number,
): TileAddress[] {
  const result: TileAddress[] = [];
  const horizonDegrees = terrainHorizonDegrees(displayRadiusM);
  const maximumLevel = terrainMaximumLevel(displayRadiusM, latitudeDegrees);
  const targetEdgeM = displayRadiusM < 4 ? 0.045 : 0.14;
  const visit = (address: TileAddress): void => {
    if (!isValidTileAddress(address)) return;
    const bounds = boundsForTile(address);
    const centreLatitude = (bounds.north + bounds.south) * 0.5;
    const centreLongitude = (bounds.west + bounds.east) * 0.5;
    const distance = angularDistanceDegrees(
      latitudeDegrees,
      longitudeDegrees,
      centreLatitude,
      centreLongitude,
    );
    const angularRadius = tileAngularRadius(bounds);
    const nearVisibleCap =
      distance <= Math.min(180, horizonDegrees + angularRadius * 1.05 + 1);
    const edgeLengthM =
      (THREE.MathUtils.degToRad(bounds.east - bounds.west) * displayRadiusM) /
      TILE_SEGMENTS;
    const withinFineRefinementCap =
      address.z + 1 < maximumLevel ||
      distance <= FINE_REFINEMENT_RADIUS_DEGREES + angularRadius;
    if (
      nearVisibleCap &&
      address.z < maximumLevel &&
      edgeLengthM > targetEdgeM &&
      withinFineRefinementCap
    ) {
      for (const child of childrenForTile(address)) visit(child);
      return;
    }
    result.push(address);
  };
  const rootDimensions = tileMatrixDimensions(0);
  for (let y = 0; y < rootDimensions.rows; y += 1) {
    for (let x = 0; x < rootDimensions.columns; x += 1) {
      visit({ z: 0, x, y });
    }
  }
  return result;
}

export function terrainBoundingExpansion(
  maximumAbsoluteElevationM: number,
  displayRadiusM: number,
  radialMultiplier: number,
): number {
  return (
    Math.abs(
      normalizedRadialOffsetForMetres(
        maximumAbsoluteElevationM,
        radialMultiplier,
      ),
    ) +
    SKIRT_DEPTH_WORLD_M / displayRadiusM
  );
}

function geodeticVertex(
  latitudeDegrees: number,
  longitudeDegrees: number,
): { position: THREE.Vector3; normal: THREE.Vector3; heightUv: THREE.Vector2 } {
  const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
  const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
  const sineLatitude = Math.sin(latitude);
  const cosineLatitude = Math.cos(latitude);
  const eccentricitySquared =
    1 - (WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);
  const primeVerticalRadius =
    WGS84_A_KM /
    Math.sqrt(1 - eccentricitySquared * sineLatitude * sineLatitude);
  return {
    position: new THREE.Vector3(
      primeVerticalRadius * cosineLatitude * Math.cos(longitude),
      primeVerticalRadius * (1 - eccentricitySquared) * sineLatitude,
      -primeVerticalRadius * cosineLatitude * Math.sin(longitude),
    ).multiplyScalar(1 / EARTH_MEAN_RADIUS_KM),
    normal: new THREE.Vector3(
      cosineLatitude * Math.cos(longitude),
      sineLatitude,
      -cosineLatitude * Math.sin(longitude),
    ).normalize(),
    heightUv: new THREE.Vector2(
      (longitudeDegrees + 180) / 360,
      (90 - latitudeDegrees) / 180,
    ),
  };
}

function geometryForTile(address: TileAddress): THREE.BufferGeometry {
  const bounds = boundsForTile(address);
  const rawBounds = rawBoundsForTile(address);
  const rawWidth = rawBounds.east - rawBounds.west;
  const rawHeight = rawBounds.north - rawBounds.south;
  const positions: number[] = [];
  const normals: number[] = [];
  const localUvs: number[] = [];
  const heightUvs: number[] = [];
  const skirts: number[] = [];
  const indices: number[] = [];
  const rowLength = TILE_SEGMENTS + 1;
  const addVertex = (
    latitude: number,
    longitude: number,
    u: number,
    v: number,
    skirt: number,
  ): number => {
    const vertex = geodeticVertex(latitude, longitude);
    positions.push(vertex.position.x, vertex.position.y, vertex.position.z);
    normals.push(vertex.normal.x, vertex.normal.y, vertex.normal.z);
    localUvs.push(u, v);
    heightUvs.push(vertex.heightUv.x, vertex.heightUv.y);
    skirts.push(skirt);
    return skirts.length - 1;
  };
  for (let row = 0; row <= TILE_SEGMENTS; row += 1) {
    const fractionV = row / TILE_SEGMENTS;
    const latitude = THREE.MathUtils.lerp(
      bounds.north,
      bounds.south,
      fractionV,
    );
    const v = (rawBounds.north - latitude) / rawHeight;
    for (let column = 0; column <= TILE_SEGMENTS; column += 1) {
      const fractionU = column / TILE_SEGMENTS;
      const longitude = THREE.MathUtils.lerp(
        bounds.west,
        bounds.east,
        fractionU,
      );
      const u = (longitude - rawBounds.west) / rawWidth;
      addVertex(latitude, longitude, u, v, 0);
    }
  }
  for (let row = 0; row < TILE_SEGMENTS; row += 1) {
    for (let column = 0; column < TILE_SEGMENTS; column += 1) {
      const northWest = row * rowLength + column;
      const southWest = northWest + rowLength;
      indices.push(
        northWest,
        southWest,
        northWest + 1,
        northWest + 1,
        southWest,
        southWest + 1,
      );
    }
  }
  const edges: number[][] = [
    Array.from({ length: rowLength }, (_, index) => index),
    Array.from(
      { length: rowLength },
      (_, index) => index * rowLength + TILE_SEGMENTS,
    ),
    Array.from(
      { length: rowLength },
      (_, index) => TILE_SEGMENTS * rowLength + TILE_SEGMENTS - index,
    ),
    Array.from(
      { length: rowLength },
      (_, index) => (TILE_SEGMENTS - index) * rowLength,
    ),
  ];
  for (const edge of edges) {
    const duplicates: number[] = [];
    for (const original of edge) {
      const positionOffset = original * 3;
      const uvOffset = original * 2;
      positions.push(
        positions[positionOffset]!,
        positions[positionOffset + 1]!,
        positions[positionOffset + 2]!,
      );
      normals.push(
        normals[positionOffset]!,
        normals[positionOffset + 1]!,
        normals[positionOffset + 2]!,
      );
      localUvs.push(localUvs[uvOffset]!, localUvs[uvOffset + 1]!);
      heightUvs.push(heightUvs[uvOffset]!, heightUvs[uvOffset + 1]!);
      skirts.push(1);
      duplicates.push(skirts.length - 1);
    }
    for (let index = 0; index < edge.length - 1; index += 1) {
      indices.push(
        edge[index]!,
        duplicates[index]!,
        edge[index + 1]!,
        edge[index + 1]!,
        duplicates[index]!,
        duplicates[index + 1]!,
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(localUvs, 2));
  geometry.setAttribute(
    "heightUv",
    new THREE.Float32BufferAttribute(heightUvs, 2),
  );
  geometry.setAttribute("skirt", new THREE.Float32BufferAttribute(skirts, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function terrainMaterial(
  relief: ReliefDataset,
  fallbackTexture: THREE.Texture,
  address: TileAddress,
  stencilAvailable: boolean,
): THREE.ShaderMaterial {
  const fallbackTransform = fallbackUvTransform(address);
  return new THREE.ShaderMaterial({
    side: THREE.FrontSide,
    depthTest: true,
    depthWrite: true,
    stencilWrite: stencilAvailable,
    stencilWriteMask: 0x00,
    stencilRef: 1,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFuncMask: 0xff,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
    uniforms: {
      heightMap: { value: relief.texture },
      imageMap: { value: fallbackTexture },
      imageScale: {
        value: new THREE.Vector2(
          fallbackTransform.scaleX,
          fallbackTransform.scaleY,
        ),
      },
      imageOffset: {
        value: new THREE.Vector2(
          fallbackTransform.offsetX,
          fallbackTransform.offsetY,
        ),
      },
      normalizedRadialMetres: { value: 0 },
      heightOffsetM: { value: relief.metadata.offsetMetres },
      heightScaleM: { value: relief.metadata.scaleMetres },
      normalizedSkirtDepth: { value: 0 },
      sunlight: { value: new THREE.Vector3(-0.38, 0.82, 0.42).normalize() },
    },
    vertexShader: `
      attribute vec2 heightUv;
      attribute float skirt;
      uniform sampler2D heightMap;
      uniform float normalizedRadialMetres;
      uniform float heightOffsetM;
      uniform float heightScaleM;
      uniform float normalizedSkirtDepth;
      varying vec2 vImageUv;
      varying vec3 vWorldPosition;
      varying vec3 vBaseNormal;
      void main() {
        vec2 packedHeight = texture2D(heightMap, heightUv).rg;
        float encodedHeight =
          packedHeight.r * 255.0 + packedHeight.g * 65280.0;
        float heightM = encodedHeight * heightScaleM + heightOffsetM;
        vec3 displaced =
          position +
          normal * heightM * normalizedRadialMetres -
          normal * normalizedSkirtDepth * skirt;
        vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
        vWorldPosition = worldPosition.xyz;
        vBaseNormal = normalize(mat3(modelMatrix) * normal);
        vImageUv = uv;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D imageMap;
      uniform vec2 imageScale;
      uniform vec2 imageOffset;
      uniform vec3 sunlight;
      varying vec2 vImageUv;
      varying vec3 vWorldPosition;
      varying vec3 vBaseNormal;
      void main() {
        vec2 imageUv = imageOffset + vImageUv * imageScale;
        vec3 albedo = texture2D(imageMap, imageUv).rgb;
        vec3 reliefNormal = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
        if (dot(reliefNormal, vBaseNormal) < 0.0) reliefNormal *= -1.0;
        float direct = max(0.0, dot(reliefNormal, normalize(sunlight)));
        float luminance = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
        float darkSurface = 1.0 - smoothstep(
          ${LAND_DARK_LUMINANCE.toFixed(2)},
          ${LAND_BRIGHT_LUMINANCE.toFixed(2)},
          luminance
        );
        float toneLift =
          ${LAND_DARK_TONE_LIFT.toFixed(2)} *
          darkSurface *
          mix(1.0, ${LAND_LIT_TONE_FRACTION.toFixed(2)}, direct);
        float liftedLuminance = mix(
          luminance,
          sqrt(max(luminance, 0.0)),
          toneLift
        );
        vec3 balancedAlbedo =
          albedo * (liftedLuminance / max(luminance, 0.001));
        float shadowLift =
          ${LAND_DARK_SHADOW_LIFT.toFixed(2)} * darkSurface;
        float light =
          ${LAND_AMBIENT_LIGHT.toFixed(2)} +
          shadowLift +
          direct * (${LAND_DIRECT_LIGHT.toFixed(2)} - shadowLift);
        vec3 colour = balancedAlbedo * light;
        colour += vec3(0.025, 0.045, 0.065) * (1.0 - direct);
        gl_FragColor = vec4(colour, 1.0);
      }
    `,
  });
}

export function terrainOccluderRadius(
  displayRadiusM: number,
  maximumDepthM: number,
  radialMultiplier: number,
): number {
  const polarSeaLevelRadius = WGS84_B_KM / EARTH_MEAN_RADIUS_KM;
  const terrainInset = Math.abs(
    normalizedRadialOffsetForMetres(
      Math.max(0, maximumDepthM) + OCCLUDER_MARGIN_SOURCE_M,
      radialMultiplier,
    ),
  );
  const roomInset = OCCLUDER_MARGIN_WORLD_M / Math.max(0.001, displayRadiusM);
  return Math.max(0.001, polarSeaLevelRadius - terrainInset - roomInset);
}

function terrainOccluder(): THREE.Mesh<
  THREE.SphereGeometry,
  THREE.MeshBasicMaterial
> {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(
      1,
      OCCLUDER_SEGMENTS,
      Math.floor(OCCLUDER_SEGMENTS / 2),
    ),
    new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthTest: true,
      depthWrite: true,
      side: THREE.FrontSide,
    }),
  );
  mesh.name = "terrain-inner-occluder";
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  return mesh;
}

function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The imagery request was aborted.", "AbortError");
  }
  const error = new Error("The imagery request was aborted.");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function imageryEvictionKeys(
  items: Array<{ key: string; usedAt: number }>,
  pinned: ReadonlySet<string>,
  limit = IMAGERY_CACHE_LIMIT,
): string[] {
  const removeCount = Math.max(0, items.length - limit);
  return items
    .filter((item) => !pinned.has(item.key))
    .sort((first, second) => first.usedAt - second.usedAt)
    .slice(0, removeCount)
    .map((item) => item.key);
}

export class ImageryLoadQueue<T> {
  private readonly wanted = new Map<string, ImageryLoadTask>();
  private readonly active = new Map<
    string,
    { task: ImageryLoadTask; controller: AbortController }
  >();

  constructor(
    private readonly load: (
      address: TileAddress,
      signal: AbortSignal,
    ) => Promise<T>,
    private readonly onLoaded: (task: ImageryLoadTask, value: T) => void,
    private readonly onFailed: (task: ImageryLoadTask, error: unknown) => void,
    readonly concurrency = MAX_CONCURRENT_IMAGERY_REQUESTS,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  get queuedCount(): number {
    let queued = 0;
    for (const key of this.wanted.keys()) {
      if (!this.active.has(key)) queued += 1;
    }
    return queued;
  }

  sync(tasks: ImageryLoadTask[]): void {
    this.wanted.clear();
    for (const task of tasks) {
      const key = tileKey(task.address);
      const existing = this.wanted.get(key);
      if (!existing || task.priority < existing.priority) {
        this.wanted.set(key, task);
      }
    }
    for (const [key, request] of this.active) {
      if (!this.wanted.has(key)) request.controller.abort();
    }
    this.pump();
  }

  dispose(): void {
    this.wanted.clear();
    for (const request of this.active.values()) {
      request.controller.abort();
    }
  }

  private pump(): void {
    while (this.active.size < this.concurrency) {
      const next = [...this.wanted.entries()]
        .filter(([key]) => !this.active.has(key))
        .sort((first, second) => {
          const priority = first[1].priority - second[1].priority;
          return priority || first[0].localeCompare(second[0]);
        })[0];
      if (!next) return;
      const [key, task] = next;
      const controller = new AbortController();
      this.active.set(key, { task, controller });
      void this.load(task.address, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) this.onLoaded(task, value);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) this.onFailed(task, error);
        })
        .finally(() => {
          this.active.delete(key);
          const wanted = this.wanted.get(key);
          if (wanted === task) this.wanted.delete(key);
          this.pump();
        });
    }
  }
}

async function imageElementForBlob(
  blob: Blob,
  signal: AbortSignal,
): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const cleanup = (): void => {
        signal.removeEventListener("abort", handleAbort);
      };
      const handleAbort = (): void => {
        cleanup();
        image.src = "";
        reject(abortError());
      };
      signal.addEventListener("abort", handleAbort, { once: true });
      image.addEventListener(
        "load",
        () => {
          cleanup();
          resolve(image);
        },
        { once: true },
      );
      image.addEventListener(
        "error",
        () => {
          cleanup();
          reject(new Error("The imagery tile could not be decoded."));
        },
        { once: true },
      );
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadImageryTexture(
  address: TileAddress,
  signal: AbortSignal,
): Promise<THREE.Texture> {
  const response = await fetch(imageryUrlForTile(address), {
    cache: "default",
    mode: "cors",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Imagery tile request failed with ${response.status}.`);
  }
  const blob = await response.blob();
  if (signal.aborted) throw abortError();
  let texture: THREE.Texture;
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    if (signal.aborted) {
      bitmap.close();
      throw abortError();
    }
    texture = new THREE.Texture(bitmap);
    texture.addEventListener("dispose", () => bitmap.close());
  } else {
    texture = new THREE.Texture(await imageElementForBlob(blob, signal));
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export class TerrainTileRenderer {
  readonly group = new THREE.Group();
  private readonly relief: ReliefDataset;
  private readonly fallbackTexture: THREE.Texture;
  private readonly occluder = terrainOccluder();
  private readonly localTerrain: LocalTerrainRenderer;
  private readonly rendered = new Map<string, RenderedTile>();
  private readonly imagery = new Map<string, CachedImagery>();
  private readonly failedImageryUntil = new Map<string, number>();
  private readonly imageryRetryCounts = new Map<string, number>();
  private readonly imageryTargets = new Map<string, TileAddress>();
  private readonly loadQueue: ImageryLoadQueue<THREE.Texture>;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private lastSelectionSignature = "";
  private imageryLevel = MIN_GLOBAL_TERRAIN_LEVEL;

  constructor(
    relief: ReliefDataset,
    fallbackTexture: THREE.Texture,
    private readonly stencilAvailable = true,
  ) {
    this.relief = relief;
    this.fallbackTexture = fallbackTexture;
    this.localTerrain = new LocalTerrainRenderer(
      relief,
      fallbackTexture,
      stencilAvailable,
    );
    this.group.add(this.occluder);
    this.group.add(this.localTerrain.group);
    this.loadQueue = new ImageryLoadQueue(
      loadImageryTexture,
      (task, texture) => this.handleImageryLoaded(task, texture),
      (task, error) => this.handleImageryFailed(task, error),
    );
  }

  update(
    latitudeDegrees: number,
    longitudeDegrees: number,
    displayRadiusM: number,
    radialMultiplier: number,
    localTerrainLodBias = 0,
    eyeHeightWorldM = 1.65,
    focalLengthPixels = 1_000,
  ): void {
    const normalizedRadialMetres = normalizedRadialOffsetForMetres(
      1,
      radialMultiplier,
    );
    const normalizedSkirtDepth = SKIRT_DEPTH_WORLD_M / displayRadiusM;
    const elevationRange = this.relief.metadata.outputElevationRangeMetres ?? [
      -12_000,
      FALLBACK_MAX_ELEVATION_M,
    ];
    const maximumDepthM = Math.max(0, -elevationRange[0]);
    const maximumAbsoluteElevationM = Math.max(
      Math.abs(elevationRange[0]),
      Math.abs(elevationRange[1]),
    );
    const maximumNormalizedDisplacement = terrainBoundingExpansion(
      maximumAbsoluteElevationM,
      displayRadiusM,
      radialMultiplier,
    );
    this.occluder.scale.setScalar(
      terrainOccluderRadius(displayRadiusM, maximumDepthM, radialMultiplier),
    );
    const signature = [
      latitudeDegrees.toFixed(1),
      longitudeDegrees.toFixed(1),
      Math.log2(displayRadiusM).toFixed(2),
    ].join(":");
    for (const tile of this.rendered.values()) {
      tile.mesh.material.uniforms.normalizedRadialMetres!.value =
        normalizedRadialMetres;
      tile.mesh.material.uniforms.normalizedSkirtDepth!.value =
        normalizedSkirtDepth;
      if (tile.mesh.geometry.boundingSphere) {
        tile.mesh.geometry.boundingSphere.radius =
          tile.baseBoundingRadius + maximumNormalizedDisplacement;
      }
    }
    if (signature !== this.lastSelectionSignature) {
      this.lastSelectionSignature = signature;
      this.generation += 1;
      const now = this.generation;
      this.imageryLevel = terrainMaximumLevel(displayRadiusM, latitudeDegrees);
      const selected = selectTerrainTiles(
        latitudeDegrees,
        longitudeDegrees,
        displayRadiusM,
      );
      const imageryAddresses = PROGRESSIVE_GIBS_IMAGERY_ENABLED
        ? prioritizeTerrainTiles(
            selected,
            latitudeDegrees,
            longitudeDegrees,
          ).slice(0, DETAIL_TILE_LIMIT)
        : [];
      this.imageryTargets.clear();
      for (const address of imageryAddresses) {
        this.imageryTargets.set(tileKey(address), address);
      }
      const imageryKeys = new Set(
        imageryAddresses.map((address) => tileKey(address)),
      );
      for (const address of selected) {
        const key = tileKey(address);
        let tile = this.rendered.get(key);
        if (!tile) {
          const material = terrainMaterial(
            this.relief,
            this.fallbackTexture,
            address,
            this.stencilAvailable,
          );
          material.uniforms.normalizedRadialMetres!.value =
            normalizedRadialMetres;
          material.uniforms.normalizedSkirtDepth!.value = normalizedSkirtDepth;
          const geometry = geometryForTile(address);
          const baseBoundingRadius = geometry.boundingSphere?.radius ?? 0;
          if (geometry.boundingSphere) {
            geometry.boundingSphere.radius =
              baseBoundingRadius + maximumNormalizedDisplacement;
          }
          const mesh = new THREE.Mesh(geometry, material);
          mesh.frustumCulled = true;
          tile = {
            mesh,
            address,
            lastUsedAt: now,
            baseBoundingRadius,
          };
          this.rendered.set(key, tile);
          this.group.add(mesh);
        }
        tile.lastUsedAt = now;
        tile.mesh.visible = true;
        if (imageryKeys.has(key)) {
          this.applyBestCachedImagery(tile);
        } else {
          this.applyFallbackImagery(tile);
        }
      }
      for (const [key, tile] of this.rendered) {
        if (tile.lastUsedAt === now) continue;
        this.group.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        tile.mesh.material.dispose();
        this.rendered.delete(key);
      }
      this.scheduleImagery();
      this.evictImagery();
    }
    this.syncLocalImageryPatches();
    this.localTerrain.update(
      latitudeDegrees,
      longitudeDegrees,
      displayRadiusM,
      radialMultiplier,
      localTerrainLodBias,
      eyeHeightWorldM,
      focalLengthPixels,
    );
    this.updateImageryDiagnostics();
  }

  getLodStatus(): {
    minZoom: number;
    maxZoom: number;
    bias: number;
    budgetLimited: boolean;
  } {
    return this.localTerrain.getLodStatus();
  }

  dispose(): void {
    this.localTerrain.dispose();
    this.loadQueue.dispose();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    for (const tile of this.rendered.values()) {
      tile.mesh.geometry.dispose();
      tile.mesh.material.dispose();
    }
    for (const item of this.imagery.values()) item.texture.dispose();
    this.rendered.clear();
    this.imagery.clear();
    this.imageryTargets.clear();
    this.failedImageryUntil.clear();
    this.imageryRetryCounts.clear();
    this.occluder.geometry.dispose();
    this.occluder.material.dispose();
  }

  private scheduleImagery(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const unresolvedTargets = [...this.imageryTargets.values()].filter(
      (address) => !this.imagery.has(tileKey(address)),
    );
    const tasks = imageryLoadTasksForTiles(unresolvedTargets);
    const taskKeys = new Set(tasks.map((task) => tileKey(task.address)));
    for (const key of this.failedImageryUntil.keys()) {
      if (!taskKeys.has(key)) this.failedImageryUntil.delete(key);
    }
    for (const key of this.imageryRetryCounts.keys()) {
      if (!taskKeys.has(key)) this.imageryRetryCounts.delete(key);
    }
    const ready: ImageryLoadTask[] = [];
    const now = Date.now();
    let earliestRetry = Infinity;
    for (const task of tasks) {
      const key = tileKey(task.address);
      if (this.imagery.has(key)) continue;
      const retryAt = this.failedImageryUntil.get(key) ?? 0;
      if (retryAt > now) {
        earliestRetry = Math.min(earliestRetry, retryAt);
      } else {
        this.failedImageryUntil.delete(key);
        ready.push(task);
      }
    }
    this.loadQueue.sync(ready);
    if (earliestRetry < Infinity) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.scheduleImagery();
      }, Math.max(0, earliestRetry - now));
    }
  }

  private handleImageryLoaded(
    task: ImageryLoadTask,
    texture: THREE.Texture,
  ): void {
    const key = tileKey(task.address);
    const existing = this.imagery.get(key);
    if (existing) {
      texture.dispose();
      existing.usedAt = this.generation;
    } else {
      this.imagery.set(key, { texture, usedAt: this.generation });
    }
    this.failedImageryUntil.delete(key);
    this.imageryRetryCounts.delete(key);
    const cachedTexture = this.imagery.get(key)?.texture;
    if (cachedTexture) {
      for (const [targetKey, targetAddress] of this.imageryTargets) {
        if (!isTileAncestor(task.address, targetAddress)) continue;
        const tile = this.rendered.get(targetKey);
        if (tile) this.applyImagery(tile, task.address, cachedTexture);
      }
    }
    this.evictImagery();
    this.scheduleImagery();
  }

  private handleImageryFailed(task: ImageryLoadTask, error: unknown): void {
    if (isAbortError(error)) return;
    const key = tileKey(task.address);
    const failedAttempts = (this.imageryRetryCounts.get(key) ?? 0) + 1;
    this.imageryRetryCounts.set(key, failedAttempts);
    this.failedImageryUntil.set(
      key,
      Date.now() + imageryRetryDelayMs(failedAttempts),
    );
    this.scheduleImagery();
  }

  private applyBestCachedImagery(tile: RenderedTile): void {
    for (let level = tile.address.z; level >= 0; level -= 1) {
      const source = previewAddressForTile(
        tile.address,
        tile.address.z - level,
      );
      const cached = this.imagery.get(tileKey(source));
      if (!cached) continue;
      cached.usedAt = this.generation;
      this.applyImagery(tile, source, cached.texture);
      return;
    }
    this.applyFallbackImagery(tile);
  }

  private applyImagery(
    tile: RenderedTile,
    source: TileAddress,
    texture: THREE.Texture,
  ): void {
    if (tile.imagerySource && tile.imagerySource.z > source.z) {
      return;
    }
    const transform = imageryUvTransform(tile.address, source);
    tile.mesh.material.uniforms.imageMap!.value = texture;
    tile.mesh.material.uniforms.imageScale!.value.set(
      transform.scaleX,
      transform.scaleY,
    );
    tile.mesh.material.uniforms.imageOffset!.value.set(
      transform.offsetX,
      transform.offsetY,
    );
    tile.imagerySource = source;
  }

  private applyFallbackImagery(tile: RenderedTile): void {
    const transform = fallbackUvTransform(tile.address);
    tile.mesh.material.uniforms.imageMap!.value = this.fallbackTexture;
    tile.mesh.material.uniforms.imageScale!.value.set(
      transform.scaleX,
      transform.scaleY,
    );
    tile.mesh.material.uniforms.imageOffset!.value.set(
      transform.offsetX,
      transform.offsetY,
    );
    tile.imagerySource = undefined;
  }

  private evictImagery(): void {
    const pinned = new Set(
      [...this.rendered.values()]
        .map((tile) => tile.imagerySource)
        .filter((address): address is TileAddress => address !== undefined)
        .map(tileKey),
    );
    const localTextureUuids = this.localTerrain.getImageryTextureUuidsInUse();
    for (const [key, item] of this.imagery) {
      if (localTextureUuids.has(item.texture.uuid)) pinned.add(key);
    }
    const evictions = imageryEvictionKeys(
      [...this.imagery].map(([key, item]) => ({
        key,
        usedAt: item.usedAt,
      })),
      pinned,
    );
    for (const key of evictions) {
      this.imagery.get(key)?.texture.dispose();
      this.imagery.delete(key);
    }
  }

  private syncLocalImageryPatches(): void {
    const patches: LocalTerrainImageryPatch[] = [];
    for (const [targetKey, targetAddress] of this.imageryTargets) {
      const tile = this.rendered.get(targetKey);
      const source = tile?.imagerySource;
      if (!source) continue;
      const texture = this.imagery.get(tileKey(source))?.texture;
      if (!texture) continue;
      patches.push({
        key: `${targetKey}:${tileKey(source)}`,
        texture,
        targetBounds: boundsForTile(targetAddress),
        sourceBounds: rawBoundsForTile(source),
      });
    }
    this.localTerrain.setImageryPatches(patches);
  }

  private updateImageryDiagnostics(): void {
    if (typeof document === "undefined") return;
    document.body.dataset.gibsImageryCache = String(this.imagery.size);
    document.body.dataset.gibsImageryActive = String(
      this.loadQueue.activeCount,
    );
    document.body.dataset.gibsImageryQueued = String(
      this.loadQueue.queuedCount,
    );
    document.body.dataset.gibsImageryFailures = String(
      this.failedImageryUntil.size,
    );
    document.body.dataset.gibsImageryLevel = String(this.imageryLevel);
  }
}
