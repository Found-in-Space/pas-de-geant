import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
  normalizedRadialOffsetForMetres,
  radialWorldMetresForKilometres,
} from "./planet-state.js";
import type { ReliefDataset } from "./relief.js";

const GIBS_WMS =
  "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
const TILE_SEGMENTS = 24;
const SKIRT_DEPTH_WORLD_M = 0.02;
const TILE_CACHE_LIMIT = 32;
const IMAGERY_RETRY_DELAY_MS = 30_000;
const FALLBACK_MAX_ELEVATION_M = 8_849;

interface TileAddress {
  z: number;
  x: number;
  y: number;
}

interface TileBounds {
  west: number;
  east: number;
  north: number;
  south: number;
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
}

const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin("anonymous");

function tileKey(address: TileAddress): string {
  return `${address.z}/${address.x}/${address.y}`;
}

export function imageryUrlForTile(address: TileAddress): string {
  const bounds = boundsForTile(address);
  const parameters = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.1.1",
    LAYERS: "BlueMarble_ShadedRelief_Bathymetry",
    STYLES: "",
    SRS: "EPSG:4326",
    BBOX: [
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north,
    ].join(","),
    WIDTH: "512",
    HEIGHT: "512",
    FORMAT: "image/jpeg",
    TRANSPARENT: "FALSE",
  });
  return `${GIBS_WMS}?${parameters.toString()}`;
}

export function boundsForTile(address: TileAddress): TileBounds {
  const rows = 2 ** address.z;
  const columns = rows * 2;
  const longitudeSpan = 360 / columns;
  const latitudeSpan = 180 / rows;
  return {
    west: -180 + address.x * longitudeSpan,
    east: -180 + (address.x + 1) * longitudeSpan,
    north: 90 - address.y * latitudeSpan,
    south: 90 - (address.y + 1) * latitudeSpan,
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
      displayRadiusM > 180 ? 6 : 5;
    if (
      nearVisibleCap &&
      address.z < maximumLevel &&
      edgeLengthM > targetEdgeM
    ) {
      const nextZ = address.z + 1;
      const nextX = address.x * 2;
      const nextY = address.y * 2;
      visit({ z: nextZ, x: nextX, y: nextY });
      visit({ z: nextZ, x: nextX + 1, y: nextY });
      visit({ z: nextZ, x: nextX, y: nextY + 1 });
      visit({ z: nextZ, x: nextX + 1, y: nextY + 1 });
      return;
    }
    result.push(address);
  };
  visit({ z: 0, x: 0, y: 0 });
  visit({ z: 0, x: 1, y: 0 });
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
    const v = row / TILE_SEGMENTS;
    const latitude = THREE.MathUtils.lerp(bounds.north, bounds.south, v);
    for (let column = 0; column <= TILE_SEGMENTS; column += 1) {
      const u = column / TILE_SEGMENTS;
      const longitude = THREE.MathUtils.lerp(bounds.west, bounds.east, u);
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
