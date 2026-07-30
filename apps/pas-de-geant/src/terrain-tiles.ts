import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
  normalizedRadialOffsetForMetres,
} from "./planet-state.js";
import { LocalTerrainRenderer } from "./local-terrain.js";
import type { ReliefDataset } from "./relief.js";
import { terrainHorizonDegrees } from "./terrain-horizon.js";

export { terrainHorizonDegrees } from "./terrain-horizon.js";

const GLOBAL_TILE_ROOT_SPAN_DEGREES = 288;
const GLOBAL_TILE_REFERENCE_TEXELS = 512;
const GLOBAL_TILE_PROJECTED_TEXEL_TARGET_M = 0.01;
const TILE_SEGMENTS = 24;
const SKIRT_DEPTH_WORLD_M = 0.02;
const OCCLUDER_SEGMENTS = 96;
const OCCLUDER_MARGIN_SOURCE_M = 500;
const OCCLUDER_MARGIN_WORLD_M = 0.002;
const FALLBACK_MAX_ELEVATION_M = 8_849;
export const MIN_GLOBAL_TERRAIN_LEVEL = 0;
export const MAX_GLOBAL_TERRAIN_LEVEL = 7;
const FINE_REFINEMENT_RADIUS_DEGREES = 8;
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

interface RenderedTile {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  lastUsedAt: number;
  baseBoundingRadius: number;
}

export function tileKey(address: TileAddress): string {
  return `${address.z}/${address.x}/${address.y}`;
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
      ((GLOBAL_TILE_ROOT_SPAN_DEGREES / 2 ** level) * Math.PI) / 180;
    const projectedTexelM =
      (Math.max(0.001, displayRadiusM) *
        Math.max(0, Math.cos(latitudeRadians)) *
        tileSpanRadians) /
      GLOBAL_TILE_REFERENCE_TEXELS;
    if (projectedTexelM <= GLOBAL_TILE_PROJECTED_TEXEL_TARGET_M) {
      return level;
    }
  }
  return MAX_GLOBAL_TERRAIN_LEVEL;
}

export function tileMatrixDimensions(level: number): {
  columns: number;
  rows: number;
} {
  const span = GLOBAL_TILE_ROOT_SPAN_DEGREES / 2 ** level;
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
  const span = GLOBAL_TILE_ROOT_SPAN_DEGREES / 2 ** address.z;
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
  const positions: number[] = [];
  const normals: number[] = [];
  const heightUvs: number[] = [];
  const skirts: number[] = [];
  const indices: number[] = [];
  const rowLength = TILE_SEGMENTS + 1;
  const addVertex = (
    latitude: number,
    longitude: number,
    skirt: number,
  ): number => {
    const vertex = geodeticVertex(latitude, longitude);
    positions.push(vertex.position.x, vertex.position.y, vertex.position.z);
    normals.push(vertex.normal.x, vertex.normal.y, vertex.normal.z);
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
    for (let column = 0; column <= TILE_SEGMENTS; column += 1) {
      const fractionU = column / TILE_SEGMENTS;
      const longitude = THREE.MathUtils.lerp(
        bounds.west,
        bounds.east,
        fractionU,
      );
      addVertex(latitude, longitude, 0);
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
  blueMarbleTexture: THREE.Texture,
  stencilAvailable: boolean,
): THREE.ShaderMaterial {
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
      blueMarbleMap: { value: blueMarbleTexture },
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
      varying vec2 vBlueMarbleUv;
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
        vBlueMarbleUv = heightUv;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D blueMarbleMap;
      uniform vec3 sunlight;
      varying vec2 vBlueMarbleUv;
      varying vec3 vWorldPosition;
      varying vec3 vBaseNormal;
      void main() {
        vec3 albedo = texture2D(blueMarbleMap, vBlueMarbleUv).rgb;
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

export class TerrainTileRenderer {
  readonly group = new THREE.Group();
  private readonly relief: ReliefDataset;
  private readonly occluder = terrainOccluder();
  private readonly localTerrain: LocalTerrainRenderer;
  private readonly rendered = new Map<string, RenderedTile>();
  private selectionGeneration = 0;
  private lastSelectionSignature = "";

  constructor(
    relief: ReliefDataset,
    private readonly blueMarbleTexture: THREE.Texture,
    private readonly stencilAvailable = true,
  ) {
    this.relief = relief;
    this.localTerrain = new LocalTerrainRenderer(
      relief,
      blueMarbleTexture,
      stencilAvailable,
    );
    this.group.add(this.occluder);
    this.group.add(this.localTerrain.group);
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
      this.selectionGeneration += 1;
      const now = this.selectionGeneration;
      const selected = selectTerrainTiles(
        latitudeDegrees,
        longitudeDegrees,
        displayRadiusM,
      );
      for (const address of selected) {
        const key = tileKey(address);
        let tile = this.rendered.get(key);
        if (!tile) {
          const material = terrainMaterial(
            this.relief,
            this.blueMarbleTexture,
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
            lastUsedAt: now,
            baseBoundingRadius,
          };
          this.rendered.set(key, tile);
          this.group.add(mesh);
        }
        tile.lastUsedAt = now;
        tile.mesh.visible = true;
      }
      for (const [key, tile] of this.rendered) {
        if (tile.lastUsedAt === now) continue;
        this.group.remove(tile.mesh);
        tile.mesh.geometry.dispose();
        tile.mesh.material.dispose();
        this.rendered.delete(key);
      }
    }
    this.localTerrain.update(
      latitudeDegrees,
      longitudeDegrees,
      displayRadiusM,
      radialMultiplier,
      localTerrainLodBias,
      eyeHeightWorldM,
      focalLengthPixels,
    );
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
    for (const tile of this.rendered.values()) {
      tile.mesh.geometry.dispose();
      tile.mesh.material.dispose();
    }
    this.rendered.clear();
    this.occluder.geometry.dispose();
    this.occluder.material.dispose();
  }
}
