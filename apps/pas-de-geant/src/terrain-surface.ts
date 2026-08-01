import * as THREE from "three";
import {
  createElevationTileProvider,
  createImageryTileProvider,
  type ImageTileResource,
} from "./image-tile-provider.js";
import type { ImageryProvider } from "./imagery-provider.js";
import {
  observerTileZoom,
} from "./observer-tile-zoom.js";
import {
  normalizeTileTarget,
  TileOnionLayoutSource,
  type TileTarget,
} from "./tile-layout-source.js";
import {
  SurfaceTileProvider,
  type SurfaceTileResource,
} from "./surface-tile-provider.js";
import { mercatorPoint, tileBounds } from "./tile-onion-core.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";
import {
  TileTransitionScheduler,
  type SchedulerSnapshot,
} from "./tile-transition-scheduler.js";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
} from "./planet-state.js";

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const SKIRT_DEPTH_WORLD_METRES = 0.02;

export interface TerrainSurfaceView {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly displayRadiusM: number;
  readonly radialMultiplier: number;
  /** Eye height above the un-displaced, flat local surface in render metres. */
  readonly observerHeightWorldM: number;
  readonly focalLengthPixels: number;
}

export interface TerrainSurfaceOptions {
  readonly renderer: THREE.WebGLRenderer;
  readonly baseTexture: THREE.Texture;
  readonly imageryProvider?: ImageryProvider;
  readonly initialView: TerrainSurfaceView;
}

interface SurfaceMesh {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly resource?: SurfaceTileResource;
}

interface SourceUv {
  readonly u: number;
  readonly v: number;
}

/** Source-space UV for a draw tile, including overzoomed ancestor cropping. */
export function sourceUvForTilePoint(
  resource: Pick<
    ImageTileResource,
    "sourceScale" | "sourceOffsetX" | "sourceOffsetY"
  >,
  tileU: number,
  tileV: number,
): SourceUv {
  return {
    u: (resource.sourceOffsetX + tileU) / resource.sourceScale,
    v:
      1 -
      (resource.sourceOffsetY + 1 - tileV) / resource.sourceScale,
  };
}

/**
 * Converts room-space eye height to physical height for a uniformly scaled
 * globe. Terrain displacement is deliberately absent from this calculation.
 */
export function flatSurfaceObserverHeightMetres(
  observerHeightWorldM: number,
  displayRadiusM: number,
): number {
  return (
    observerHeightWorldM *
    EARTH_MEAN_RADIUS_KM *
    1_000 /
    displayRadiusM
  );
}

function targetForView(
  view: TerrainSurfaceView,
  tilePixels: number,
): TileTarget {
  const zoom = observerTileZoom({
    observerHeightMeters: flatSurfaceObserverHeightMetres(
      view.observerHeightWorldM,
      view.displayRadiusM,
    ),
    latitudeDegrees: view.latitudeDegrees,
    projectedFocalLengthPixels: view.focalLengthPixels,
    tilePixels,
  }).zoom;
  const point = mercatorPoint(
    view.latitudeDegrees,
    view.longitudeDegrees,
    zoom,
  );
  return normalizeTileTarget({
    z: zoom,
    x: Math.floor(point.x),
    y: Math.floor(point.y),
  });
}

function geodeticVertex(
  latitudeDegrees: number,
  longitudeDegrees: number,
): { position: THREE.Vector3; normal: THREE.Vector3 } {
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
  };
}

function segmentsForTile(tile: TileIdentity): number {
  if (tile.z >= 10) return 64;
  if (tile.z >= 7) return 32;
  return 16;
}

function patchGeometry(
  bounds: { west: number; east: number; north: number; south: number },
  columns: number,
  rows: number,
  elevation?: ImageTileResource,
  imagery?: ImageTileResource,
  includeSkirts = true,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const baseUvs: number[] = [];
  const tileUvs: number[] = [];
  const elevationUvs: number[] = [];
  const imageryUvs: number[] = [];
  const skirts: number[] = [];
  const indices: number[] = [];
  const rowLength = columns + 1;

  const appendVertex = (
    latitude: number,
    longitude: number,
    tileU: number,
    tileV: number,
    skirt: number,
  ): number => {
    const vertex = geodeticVertex(latitude, longitude);
    positions.push(vertex.position.x, vertex.position.y, vertex.position.z);
    normals.push(vertex.normal.x, vertex.normal.y, vertex.normal.z);
    baseUvs.push((longitude + 180) / 360, (90 - latitude) / 180);
    tileUvs.push(tileU, tileV);
    const elevationUv = elevation
      ? sourceUvForTilePoint(elevation, tileU, tileV)
      : { u: tileU, v: tileV };
    const imageryUv = imagery
      ? sourceUvForTilePoint(imagery, tileU, tileV)
      : { u: tileU, v: tileV };
    elevationUvs.push(elevationUv.u, elevationUv.v);
    imageryUvs.push(imageryUv.u, imageryUv.v);
    skirts.push(skirt);
    return positions.length / 3 - 1;
  };

  for (let row = 0; row <= rows; row += 1) {
    const rowFraction = row / rows;
    const latitude = THREE.MathUtils.lerp(
      bounds.north,
      bounds.south,
      rowFraction,
    );
    for (let column = 0; column <= columns; column += 1) {
      const columnFraction = column / columns;
      appendVertex(
        latitude,
        THREE.MathUtils.lerp(bounds.west, bounds.east, columnFraction),
        columnFraction,
        1 - rowFraction,
        0,
      );
    }
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
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

  if (includeSkirts) {
    const edges = [
      Array.from({ length: columns + 1 }, (_, index) => index),
      Array.from(
        { length: rows + 1 },
        (_, index) => index * rowLength + columns,
      ),
      Array.from(
        { length: columns + 1 },
        (_, index) => rows * rowLength + columns - index,
      ),
      Array.from(
        { length: rows + 1 },
        (_, index) => (rows - index) * rowLength,
      ),
    ];
    for (const edge of edges) {
      const skirtEdge = edge.map((sourceIndex) => {
        const positionOffset = sourceIndex * 3;
        const uvOffset = sourceIndex * 2;
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
        baseUvs.push(baseUvs[uvOffset]!, baseUvs[uvOffset + 1]!);
        tileUvs.push(tileUvs[uvOffset]!, tileUvs[uvOffset + 1]!);
        elevationUvs.push(
          elevationUvs[uvOffset]!,
          elevationUvs[uvOffset + 1]!,
        );
        imageryUvs.push(imageryUvs[uvOffset]!, imageryUvs[uvOffset + 1]!);
        skirts.push(1);
        return positions.length / 3 - 1;
      });
      for (let index = 0; index < edge.length - 1; index += 1) {
        const first = edge[index]!;
        const second = edge[index + 1]!;
        const firstSkirt = skirtEdge[index]!;
        const secondSkirt = skirtEdge[index + 1]!;
        indices.push(first, firstSkirt, second, second, firstSkirt, secondSkirt);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("baseUv", new THREE.Float32BufferAttribute(baseUvs, 2));
  geometry.setAttribute("tileUv", new THREE.Float32BufferAttribute(tileUvs, 2));
  geometry.setAttribute(
    "elevationUv",
    new THREE.Float32BufferAttribute(elevationUvs, 2),
  );
  geometry.setAttribute(
    "imageryUv",
    new THREE.Float32BufferAttribute(imageryUvs, 2),
  );
  geometry.setAttribute("skirt", new THREE.Float32BufferAttribute(skirts, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function tileTint(zoom: number): THREE.Color {
  return new THREE.Color().setHSL(((zoom * 0.137) % 1 + 1) % 1, 0.7, 0.48);
}

const VERTEX_SHADER = `
  in vec2 baseUv;
  in vec2 tileUv;
  in vec2 elevationUv;
  in vec2 imageryUv;
  in float skirt;
  uniform sampler2D elevationMap;
  uniform float elevationEnabled;
  uniform float normalizedRadialMetres;
  uniform float normalizedSkirtDepth;
  out vec2 vBaseUv;
  out vec2 vTileUv;
  out vec2 vImageryUv;
  out vec3 vWorldPosition;
  out vec3 vBaseNormal;

  float decodeTerrarium(vec3 encoded) {
    vec3 bytes = floor(encoded * 255.0 + 0.5);
    return bytes.r * 256.0 + bytes.g + bytes.b / 256.0 - 32768.0;
  }

  float elevationAt(vec2 uv) {
    ivec2 size = textureSize(elevationMap, 0);
    vec2 pixel = clamp(uv * vec2(size) - 0.5, vec2(0.0), vec2(size - 1));
    ivec2 northWest = ivec2(floor(pixel));
    ivec2 southEast = min(northWest + ivec2(1), size - 1);
    vec2 amount = fract(pixel);
    float north = mix(
      decodeTerrarium(texelFetch(elevationMap, northWest, 0).rgb),
      decodeTerrarium(texelFetch(elevationMap, ivec2(southEast.x, northWest.y), 0).rgb),
      amount.x
    );
    float south = mix(
      decodeTerrarium(texelFetch(elevationMap, ivec2(northWest.x, southEast.y), 0).rgb),
      decodeTerrarium(texelFetch(elevationMap, southEast, 0).rgb),
      amount.x
    );
    return mix(north, south, amount.y);
  }

  void main() {
    float heightM = elevationEnabled > 0.5 ? elevationAt(elevationUv) : 0.0;
    vec3 displaced =
      position + normal * heightM * normalizedRadialMetres -
      normal * normalizedSkirtDepth * skirt;
    vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
    vBaseUv = baseUv;
    vTileUv = tileUv;
    vImageryUv = imageryUv;
    vWorldPosition = worldPosition.xyz;
    vBaseNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const FRAGMENT_SHADER = `
  uniform sampler2D baseMap;
  uniform sampler2D imageryMap;
  uniform float imageryEnabled;
  uniform float tileOverlayVisible;
  uniform float textureOverlayVisible;
  uniform vec3 tileTint;
  uniform vec3 sunlight;
  in vec2 vBaseUv;
  in vec2 vTileUv;
  in vec2 vImageryUv;
  in vec3 vWorldPosition;
  in vec3 vBaseNormal;
  out vec4 surfaceColour;

  float edgeOverlay(vec2 uv) {
    vec2 edgeDistance = min(uv, 1.0 - uv);
    float distanceToEdge = min(edgeDistance.x, edgeDistance.y);
    return 1.0 - smoothstep(
      0.0,
      max(0.0005, fwidth(distanceToEdge) * 2.0),
      distanceToEdge
    );
  }

  void main() {
    vec3 albedo = imageryEnabled > 0.5
      ? texture(imageryMap, vImageryUv).rgb
      : texture(baseMap, vBaseUv).rgb;
    vec3 derivedNormal = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
    if (dot(derivedNormal, vBaseNormal) < 0.0) derivedNormal *= -1.0;
    float direct = max(0.0, dot(derivedNormal, normalize(sunlight)));
    float luminance = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    float darkSurface = 1.0 - smoothstep(0.12, 0.5, luminance);
    float liftedLuminance = mix(
      luminance,
      sqrt(max(luminance, 0.0)),
      0.16 * darkSurface * mix(1.0, 0.35, direct)
    );
    vec3 balanced = albedo * liftedLuminance / max(luminance, 0.001);
    balanced = mix(balanced, sqrt(max(balanced, vec3(0.0))), 0.24);
    float shadowLift = 0.18 * darkSurface;
    vec3 colour = balanced * (0.58 + shadowLift + direct * (0.6 - shadowLift));
    colour += vec3(0.025, 0.045, 0.065) * (1.0 - direct);
    float tileEdge = edgeOverlay(vTileUv);
    colour = mix(colour, tileTint, tileOverlayVisible * (0.14 + tileEdge * 0.72));
    if (imageryEnabled > 0.5) {
      float sourceEdge = edgeOverlay(vImageryUv);
      colour = mix(
        colour,
        vec3(0.0, 0.843, 1.0),
        textureOverlayVisible * sourceEdge * 0.88
      );
    }
    surfaceColour = vec4(colour, 1.0);
  }
`;

/** Atomic, provider-neutral terrain and imagery surface renderer. */
export class TerrainSurface {
  readonly group = new THREE.Group();
  private readonly provider: SurfaceTileProvider;
  private readonly scheduler: TileTransitionScheduler<
    TileTarget,
    SurfaceTileResource
  >;
  private readonly meshes = new Map<string, SurfaceMesh>();
  private readonly imageryTextures = new Map<HTMLImageElement, THREE.Texture>();
  private readonly elevationTextures = new Map<HTMLImageElement, THREE.Texture>();
  private readonly emptyTexture: THREE.DataTexture;
  private readonly maximumAnisotropy: number;
  private readonly sharedUniforms: Record<string, THREE.IUniform>;
  private readonly unsubscribe: () => void;
  private snapshot: SchedulerSnapshot<TileTarget>;
  private currentTarget: TileTarget;

  constructor(options: TerrainSurfaceOptions) {
    this.group.name = "terrain-surface";
    this.maximumAnisotropy = options.renderer.capabilities.getMaxAnisotropy();
    options.baseTexture.wrapS = THREE.RepeatWrapping;
    options.baseTexture.wrapT = THREE.ClampToEdgeWrapping;
    options.baseTexture.needsUpdate = true;

    const elevationProvider = createElevationTileProvider();
    const imageryProvider = options.imageryProvider
      ? createImageryTileProvider(options.imageryProvider)
      : undefined;
    this.provider = new SurfaceTileProvider(
      elevationProvider,
      imageryProvider,
      options.imageryProvider?.minZoom,
    );
    this.currentTarget = targetForView(options.initialView, this.provider.tilePixels);
    this.scheduler = new TileTransitionScheduler(
      this.currentTarget,
      new TileOnionLayoutSource(),
      this.provider,
      { hydrateInitialResources: true },
    );
    this.snapshot = this.scheduler.snapshot;
    this.emptyTexture = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    this.emptyTexture.needsUpdate = true;
    this.sharedUniforms = {
      baseMap: { value: options.baseTexture },
      normalizedRadialMetres: {
        value: options.initialView.radialMultiplier /
          (EARTH_MEAN_RADIUS_KM * 1_000),
      },
      normalizedSkirtDepth: {
        value: SKIRT_DEPTH_WORLD_METRES / options.initialView.displayRadiusM,
      },
      tileOverlayVisible: { value: 0 },
      textureOverlayVisible: { value: 0 },
      sunlight: { value: new THREE.Vector3(-0.38, 0.82, 0.42).normalize() },
    };
    this.addPolarCaps();
    this.unsubscribe = this.scheduler.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.syncMeshes();
    });
  }

  update(view: TerrainSurfaceView): void {
    this.sharedUniforms.normalizedRadialMetres!.value =
      view.radialMultiplier / (EARTH_MEAN_RADIUS_KM * 1_000);
    this.sharedUniforms.normalizedSkirtDepth!.value =
      SKIRT_DEPTH_WORLD_METRES / view.displayRadiusM;
    const target = targetForView(view, this.provider.tilePixels);
    if (
      target.z !== this.currentTarget.z ||
      target.x !== this.currentTarget.x ||
      target.y !== this.currentTarget.y
    ) {
      this.currentTarget = target;
      this.scheduler.updateTarget(target);
    }
  }

  getLodStatus(): { minZoom: number; maxZoom: number; budgetLimited: boolean } {
    const zooms = this.snapshot.committedCut.map(({ z }) => z);
    return {
      minZoom: zooms.length > 0 ? Math.min(...zooms) : 0,
      maxZoom: zooms.length > 0 ? Math.max(...zooms) : 0,
      budgetLimited: false,
    };
  }

  setTileOverlayVisible(visible: boolean): void {
    this.sharedUniforms.tileOverlayVisible!.value = visible ? 1 : 0;
  }

  setTextureTileOverlayVisible(visible: boolean): void {
    this.sharedUniforms.textureOverlayVisible!.value = visible ? 1 : 0;
  }

  retryFailed(): void {
    this.scheduler.retryFailed();
  }

  dispose(): void {
    this.unsubscribe();
    this.scheduler.dispose();
    this.provider.dispose();
    for (const entry of this.meshes.values()) {
      this.group.remove(entry.mesh);
      this.disposeMesh(entry.mesh);
    }
    this.meshes.clear();
    for (const texture of this.imageryTextures.values()) texture.dispose();
    for (const texture of this.elevationTextures.values()) texture.dispose();
    this.imageryTextures.clear();
    this.elevationTextures.clear();
    this.emptyTexture.dispose();
    for (const child of [...this.group.children]) {
      if (!(child instanceof THREE.Mesh)) continue;
      this.group.remove(child);
      this.disposeMesh(child as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>);
    }
  }

  private syncMeshes(): void {
    const retained = new Set(
      this.snapshot.committedCut.map((tile) => tileIdentityKey(tile)),
    );
    for (const [key, entry] of [...this.meshes]) {
      if (retained.has(key)) continue;
      this.meshes.delete(key);
      this.group.remove(entry.mesh);
      this.disposeMesh(entry.mesh);
    }
    for (const tile of this.snapshot.committedCut) {
      const key = tileIdentityKey(tile);
      const resource = this.scheduler.committedResource(tile);
      const current = this.meshes.get(key);
      if (current && current.resource === resource) continue;
      if (current) {
        this.group.remove(current.mesh);
        this.disposeMesh(current.mesh);
      }
      const mesh = this.createTileMesh(tile, resource);
      this.meshes.set(key, { mesh, resource });
      this.group.add(mesh);
    }
  }

  private createTileMesh(
    tile: TileIdentity,
    resource?: SurfaceTileResource,
  ): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
    const segments = segmentsForTile(tile);
    const geometry = patchGeometry(
      tileBounds(tile),
      segments,
      segments,
      resource?.elevation,
      resource?.imagery,
    );
    const elevationMap = resource
      ? this.textureForElevation(resource.elevation)
      : this.emptyTexture;
    const imageryMap = resource?.imagery
      ? this.textureForImagery(resource.imagery)
      : this.emptyTexture;
    const material = this.surfaceMaterial({
      elevationMap,
      elevationEnabled: resource ? 1 : 0,
      imageryMap,
      imageryEnabled: resource?.imagery ? 1 : 0,
      tileTint: tileTint(tile.z),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `surface-tile:${tileIdentityKey(tile)}`;
    mesh.frustumCulled = false;
    return mesh;
  }

  private addPolarCaps(): void {
    for (const bounds of [
      { west: -180, east: 180, north: 90, south: WEB_MERCATOR_MAX_LATITUDE },
      { west: -180, east: 180, north: -WEB_MERCATOR_MAX_LATITUDE, south: -90 },
    ]) {
      const mesh = new THREE.Mesh(
        patchGeometry(bounds, 128, 8, undefined, undefined, false),
        this.surfaceMaterial({
          elevationMap: this.emptyTexture,
          elevationEnabled: 0,
          imageryMap: this.emptyTexture,
          imageryEnabled: 0,
          tileTint: new THREE.Color(0x3d8a95),
        }),
      );
      mesh.name = "flat-polar-cap";
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  private surfaceMaterial(values: {
    elevationMap: THREE.Texture;
    elevationEnabled: number;
    imageryMap: THREE.Texture;
    imageryEnabled: number;
    tileTint: THREE.Color;
  }): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      uniforms: {
        ...this.sharedUniforms,
        elevationMap: { value: values.elevationMap },
        elevationEnabled: { value: values.elevationEnabled },
        imageryMap: { value: values.imageryMap },
        imageryEnabled: { value: values.imageryEnabled },
        tileTint: { value: values.tileTint },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });
  }

  private textureForImagery(resource: ImageTileResource): THREE.Texture {
    const existing = this.imageryTextures.get(resource.image);
    if (existing) return existing;
    const texture = new THREE.Texture(resource.image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.maximumAnisotropy;
    texture.needsUpdate = true;
    this.imageryTextures.set(resource.image, texture);
    return texture;
  }

  private textureForElevation(resource: ImageTileResource): THREE.Texture {
    const existing = this.elevationTextures.get(resource.image);
    if (existing) return existing;
    const texture = new THREE.Texture(resource.image);
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.elevationTextures.set(resource.image, texture);
    return texture;
  }

  private disposeMesh(
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>,
  ): void {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}
