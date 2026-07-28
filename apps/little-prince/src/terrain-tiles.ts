import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
  normalizedRadialOffsetForMetres,
  radialWorldMetresForKilometres,
} from "./planet-state.js";
import type { ReliefDataset } from "./relief.js";

const GIBS_WMTS =
  "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/" +
  "BlueMarble_ShadedRelief_Bathymetry/default/500m";
const GIBS_ROOT_TILE_SPAN_DEGREES = 288;
const TILE_SEGMENTS = 24;
const SKIRT_DEPTH_WORLD_M = 0.02;
export const DETAIL_TILE_LIMIT = 32;
export const IMAGERY_CACHE_LIMIT = 48;
export const MAX_CONCURRENT_IMAGERY_REQUESTS = 6;
const IMAGERY_RETRY_DELAY_MS = 30_000;
const FALLBACK_MAX_ELEVATION_M = 8_849;
const FINE_REFINEMENT_RADIUS_DEGREES = 8;
const EXACT_IMAGERY_PRIORITY_OFFSET = 1_000;

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

export function fallbackUvTransform(address: TileAddress): UvTransform {
  const raw = rawBoundsForTile(address);
  return {
    scaleX: (raw.east - raw.west) / 360,
    scaleY: (raw.north - raw.south) / 180,
    offsetX: (raw.west + 180) / 360,
    offsetY: (90 - raw.north) / 180,
  };
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
  radialMultiplier = 1,
  eyeHeightM = 1.7,
  maximumElevationM = FALLBACK_MAX_ELEVATION_M,
): TileAddress[] {
  const result: TileAddress[] = [];
  const horizonDegrees = terrainHorizonDegrees(
    displayRadiusM,
    radialMultiplier,
    eyeHeightM,
    maximumElevationM,
  );
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
      THREE.MathUtils.degToRad(bounds.east - bounds.west) *
      displayRadiusM /
      TILE_SEGMENTS;
    const maximumLevel =
      displayRadiusM > 180 ? 7 : 6;
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

export function terrainHorizonDegrees(
  displayRadiusM: number,
  radialMultiplier: number,
  eyeHeightM = 1.7,
  maximumElevationM = FALLBACK_MAX_ELEVATION_M,
): number {
  const horizonAngle = (heightM: number): number =>
    Math.acos(
      displayRadiusM /
        Math.max(displayRadiusM + Math.max(0, heightM), displayRadiusM),
    );
  const maximumElevationWorldM = radialWorldMetresForKilometres(
    maximumElevationM / 1_000,
    displayRadiusM,
    radialMultiplier,
  );
  return THREE.MathUtils.radToDeg(
    horizonAngle(eyeHeightM) + horizonAngle(maximumElevationWorldM),
  );
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
  geometry.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(normals, 3),
  );
  geometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(localUvs, 2),
  );
  geometry.setAttribute(
    "heightUv",
    new THREE.Float32BufferAttribute(heightUvs, 2),
  );
  geometry.setAttribute(
    "skirt",
    new THREE.Float32BufferAttribute(skirts, 1),
  );
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function terrainMaterial(
  relief: ReliefDataset,
  fallbackTexture: THREE.Texture,
  address: TileAddress,
): THREE.ShaderMaterial {
  const rows = 2 ** address.z;
  const columns = rows * 2;
  return new THREE.ShaderMaterial({
    uniforms: {
      heightMap: { value: relief.texture },
      imageMap: { value: fallbackTexture },
      imageScale: { value: new THREE.Vector2(1 / columns, 1 / rows) },
      imageOffset: {
        value: new THREE.Vector2(address.x / columns, address.y / rows),
      },
      normalizedRadialMetres: { value: 0 },
      oceanSurface: { value: 1 },
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
      uniform float oceanSurface;
      uniform float heightOffsetM;
      uniform float heightScaleM;
      uniform float normalizedSkirtDepth;
      varying vec2 vImageUv;
      varying vec3 vWorldPosition;
      varying vec3 vBaseNormal;
      varying float vHeightM;
      void main() {
        vec2 packedHeight = texture2D(heightMap, heightUv).rg;
        float encodedHeight =
          packedHeight.r * 255.0 + packedHeight.g * 65280.0;
        float heightM = encodedHeight * heightScaleM + heightOffsetM;
        float displayedHeightM = heightM;
        if (oceanSurface > 0.5 && heightM < 0.0) displayedHeightM = 0.0;
        vec3 displaced =
          position +
          normal * displayedHeightM * normalizedRadialMetres -
          normal * normalizedSkirtDepth * skirt;
        vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
        vWorldPosition = worldPosition.xyz;
        vBaseNormal = normalize(mat3(modelMatrix) * normal);
        vImageUv = uv;
        vHeightM = heightM;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D imageMap;
      uniform vec2 imageScale;
      uniform vec2 imageOffset;
      uniform vec3 sunlight;
      uniform float oceanSurface;
      varying vec2 vImageUv;
      varying vec3 vWorldPosition;
      varying vec3 vBaseNormal;
      varying float vHeightM;
      void main() {
        vec2 imageUv = imageOffset + vImageUv * imageScale;
        vec3 albedo = texture2D(imageMap, imageUv).rgb;
        vec3 reliefNormal = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
        if (dot(reliefNormal, vBaseNormal) < 0.0) reliefNormal *= -1.0;
        float direct = max(0.0, dot(reliefNormal, normalize(sunlight)));
        float light = 0.46 + direct * 0.72;
        vec3 colour = albedo * light;
        if (oceanSurface > 0.5 && vHeightM < 0.0) {
          float depthTint = clamp(-vHeightM / 7000.0, 0.0, 1.0);
          vec3 water = mix(
            vec3(0.025, 0.22, 0.34),
            vec3(0.012, 0.075, 0.15),
            depthTint
          );
          colour = mix(water, albedo * 0.42, 0.18) * (0.72 + direct * 0.28);
        }
        colour += vec3(0.025, 0.045, 0.065) * (1.0 - direct);
        gl_FragColor = vec4(colour, 1.0);
      }
    `,
  });
}

export class TerrainTileRenderer {
  readonly group = new THREE.Group();
  private readonly relief: ReliefDataset;
  private readonly fallbackTexture: THREE.Texture;
  private readonly rendered = new Map<string, RenderedTile>();
  private readonly imagery = new Map<string, CachedImagery>();
  private readonly pendingImagery = new Set<string>();
  private readonly failedImageryUntil = new Map<string, number>();
  private generation = 0;
  private lastSelectionSignature = "";

  constructor(relief: ReliefDataset, fallbackTexture: THREE.Texture) {
    this.relief = relief;
    this.fallbackTexture = fallbackTexture;
  }

  update(
    latitudeDegrees: number,
    longitudeDegrees: number,
    displayRadiusM: number,
    radialMultiplier: number,
    oceanSurface: boolean,
  ): void {
    const normalizedRadialMetres =
      normalizedRadialOffsetForMetres(1, radialMultiplier);
    const normalizedSkirtDepth =
      SKIRT_DEPTH_WORLD_M / displayRadiusM;
    const elevationRange =
      this.relief.metadata.outputElevationRangeMetres ??
      [-12_000, FALLBACK_MAX_ELEVATION_M];
    const maximumElevationM = Math.max(0, elevationRange[1]);
    const maximumAbsoluteElevationM = Math.max(
      Math.abs(elevationRange[0]),
      Math.abs(elevationRange[1]),
    );
    const maximumNormalizedDisplacement = terrainBoundingExpansion(
      maximumAbsoluteElevationM,
      displayRadiusM,
      radialMultiplier,
    );
    const signature = [
      latitudeDegrees.toFixed(1),
      longitudeDegrees.toFixed(1),
      Math.log2(displayRadiusM).toFixed(2),
      radialMultiplier.toFixed(2),
    ].join(":");
    for (const tile of this.rendered.values()) {
      tile.mesh.material.uniforms.normalizedRadialMetres!.value =
        normalizedRadialMetres;
      tile.mesh.material.uniforms.oceanSurface!.value =
        oceanSurface ? 1 : 0;
      tile.mesh.material.uniforms.normalizedSkirtDepth!.value =
        normalizedSkirtDepth;
      if (tile.mesh.geometry.boundingSphere) {
        tile.mesh.geometry.boundingSphere.radius =
          tile.baseBoundingRadius + maximumNormalizedDisplacement;
      }
    }
    if (signature === this.lastSelectionSignature) return;
    this.lastSelectionSignature = signature;
    this.generation += 1;
    const now = this.generation;
    const selected = selectTerrainTiles(
      latitudeDegrees,
      longitudeDegrees,
      displayRadiusM,
      radialMultiplier,
      1.7,
      maximumElevationM,
    );
    const imageryKeys = new Set(
      [...selected]
        .filter((address) => address.z >= 2)
        .sort((first, second) => {
          if (first.z !== second.z) return second.z - first.z;
          const firstBounds = boundsForTile(first);
          const secondBounds = boundsForTile(second);
          return (
            angularDistanceDegrees(
              latitudeDegrees,
              longitudeDegrees,
              (firstBounds.north + firstBounds.south) * 0.5,
              (firstBounds.west + firstBounds.east) * 0.5,
            ) -
            angularDistanceDegrees(
              latitudeDegrees,
              longitudeDegrees,
              (secondBounds.north + secondBounds.south) * 0.5,
              (secondBounds.west + secondBounds.east) * 0.5,
            )
          );
        })
        .slice(0, TILE_CACHE_LIMIT)
        .map(tileKey),
    );
    for (const address of selected) {
      const key = tileKey(address);
      let tile = this.rendered.get(key);
      if (!tile) {
        const material = terrainMaterial(
          this.relief,
          this.fallbackTexture,
          address,
        );
        material.uniforms.normalizedRadialMetres!.value =
          normalizedRadialMetres;
        material.uniforms.oceanSurface!.value = oceanSurface ? 1 : 0;
        material.uniforms.normalizedSkirtDepth!.value =
          normalizedSkirtDepth;
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
      if (imageryKeys.has(key)) this.loadImagery(tile);
    }
    for (const [key, tile] of this.rendered) {
      if (tile.lastUsedAt === now) continue;
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      tile.mesh.material.dispose();
      this.rendered.delete(key);
    }
  }

  dispose(): void {
    for (const tile of this.rendered.values()) {
      tile.mesh.geometry.dispose();
      tile.mesh.material.dispose();
    }
    for (const item of this.imagery.values()) item.texture.dispose();
    this.rendered.clear();
    this.imagery.clear();
    this.pendingImagery.clear();
    this.failedImageryUntil.clear();
  }

  private loadImagery(tile: RenderedTile): void {
    const address = tile.address;
    const key = tileKey(address);
    const existing = this.imagery.get(key);
    if (existing) {
      existing.usedAt = this.generation;
      this.applyImagery(tile, existing.texture);
      return;
    }
    const retryAt = this.failedImageryUntil.get(key) ?? 0;
    if (retryAt > Date.now()) return;
    this.failedImageryUntil.delete(key);
    if (this.pendingImagery.has(key)) return;
    this.pendingImagery.add(key);
    textureLoader.load(
      imageryUrlForTile(address),
      (texture) => {
        this.pendingImagery.delete(key);
        this.failedImageryUntil.delete(key);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = false;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        this.imagery.set(key, { texture, usedAt: this.generation });
        const current = this.rendered.get(key);
        if (current) this.applyImagery(current, texture);
        this.evictImagery();
      },
      undefined,
      () => {
        this.pendingImagery.delete(key);
        this.failedImageryUntil.set(
          key,
          Date.now() + IMAGERY_RETRY_DELAY_MS,
        );
      },
    );
  }

  private applyImagery(tile: RenderedTile, texture: THREE.Texture): void {
    tile.mesh.material.uniforms.imageMap!.value = texture;
    tile.mesh.material.uniforms.imageScale!.value.set(1, 1);
    tile.mesh.material.uniforms.imageOffset!.value.set(0, 0);
  }

  private evictImagery(): void {
    if (this.imagery.size <= TILE_CACHE_LIMIT) return;
    const oldest = [...this.imagery.entries()]
      .sort((first, second) => first[1].usedAt - second[1].usedAt)
      .slice(0, this.imagery.size - TILE_CACHE_LIMIT);
    for (const [key, item] of oldest) {
      const tile = this.rendered.get(key);
      if (tile) {
        const address = tile.address;
        const rows = 2 ** address.z;
        const columns = rows * 2;
        tile.mesh.material.uniforms.imageMap!.value = this.fallbackTexture;
        tile.mesh.material.uniforms.imageScale!.value.set(
          1 / columns,
          1 / rows,
        );
        tile.mesh.material.uniforms.imageOffset!.value.set(
          address.x / columns,
          address.y / rows,
        );
      }
      item.texture.dispose();
      this.imagery.delete(key);
    }
  }
}
