import * as THREE from "three";
import { earthTextureUv } from "./earth-texture-projection.js";
import { ImageTexturePool } from "./image-texture-pool.js";
import {
  createElevationTileProvider,
  MAPTERHORN_ELEVATION_PROVIDER_METADATA,
  type ImageTileResource,
} from "./image-tile-provider.js";
import type { ImageryProvider } from "./imagery-provider.js";
import {
  IMAGERY_FRAGMENT_DECLARATIONS,
  ImageryVirtualTexture,
  imageryBoundsForGeographicBounds,
  normalizedMercatorYForLatitude,
} from "./imagery.js";
import { observerTileZoom } from "./observer-tile-zoom.js";
import {
  normalizeTileLayoutTarget,
  type TileLayoutTarget,
} from "./tile-layout-source.js";
import {
  ElevationTileProvider,
  type ElevationTileResource,
} from "./elevation-tile-provider.js";
import {
  mercatorTileX,
  mercatorTileY,
  tileBounds,
  wrapTileX,
} from "./tile-onion-core.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";
import type { SchedulerSnapshot } from "./tile-transition-scheduler.js";
import { TileWorkerScheduler } from "./tile-worker-scheduler.js";
import { summarizeTilePlannerSnapshot } from "./tile-planner-state.js";
import {
  createTileDebugControls,
  DEFAULT_TERRAIN_SCREEN_PIXELS_PER_SOURCE_PIXEL,
  tileDebugControlsReadback,
  withTileMaxZoom,
  withTilePixelRatio,
  withTileRecalculation,
  type TileDebugControls,
  type TileDebugControlsReadback,
  type TileOptionalZoomArguments,
  type TilePixelRatioArguments,
  type TileRecalculationArguments,
} from "./tile-debug-controls.js";
import {
  TileHorizonCulling,
  type TileHorizonView,
} from "./tile-horizon-culling.js";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
} from "./planet-state.js";
import {
  normalizeTerrainLodOptions,
  terrainSegmentsForZoom,
  type NormalizedTerrainLodOptions,
  type TerrainLodOptions,
} from "./terrain-lod.js";
import {
  createTerrainRenderVisibilityEntry,
  TerrainRenderVisibility,
  type TerrainRenderVisibilityEntry,
  type TerrainRenderVisibilityMetrics,
} from "./terrain-render-visibility.js";

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const SKIRT_DEPTH_WORLD_METRES = 0.02;
const TRANSIENT_RETRY_MAX_DELAY_MS = 5 * 60_000;
/** Geometry LOD density; deliberately independent from imagery texel density. */
export const TERRAIN_TARGET_SCREEN_PIXELS_PER_ELEVATION_PIXEL =
  DEFAULT_TERRAIN_SCREEN_PIXELS_PER_SOURCE_PIXEL;

export interface TerrainSurfaceView {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly displayRadiusM: number;
  readonly radialMultiplier: number;
  /** Eye height above the un-displaced, flat local surface in render metres. */
  readonly observerHeightWorldM: number;
  readonly focalLengthPixels: number;
}

export interface TerrainRuntimeMetrics {
  readonly committedLeafCount: number;
  readonly horizonTerrainTileCount: number;
  readonly horizonClassificationTotal: number;
  readonly renderVisibility: TerrainRenderVisibilityMetrics;
  readonly imagery: ReturnType<ImageryVirtualTexture["getMetrics"]>;
  readonly elevation: {
    readonly decodedSourceCount: number;
    readonly textureCount: number;
    readonly requestTotal: number;
    readonly sourceLoadTotal: number;
    readonly estimatedCpuBytes: number;
    readonly estimatedGpuBytes: number;
  };
}

export interface TerrainSurfaceOptions {
  readonly renderer: THREE.WebGLRenderer;
  readonly baseTexture: THREE.Texture;
  readonly imageryProvider?: ImageryProvider;
  readonly terrainLod?: TerrainLodOptions;
  readonly initialView: TerrainSurfaceView;
}

interface SurfaceMesh {
  readonly tile: TileIdentity;
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly visibilityEntry: TerrainRenderVisibilityEntry;
  elevation?: ImageTileResource;
  elevationTexture?: THREE.Texture;
}

interface SourceUv {
  readonly u: number;
  readonly v: number;
}

/** Local Web Mercator UV; this is intentionally not the Blue Marble UV. */
export function imageryUvForGeographicPoint(
  bounds: { west: number; east: number; north: number; south: number },
  latitudeDegrees: number,
  longitudeDegrees: number,
): SourceUv {
  const north = normalizedMercatorYForLatitude(bounds.north);
  const south = normalizedMercatorYForLatitude(bounds.south);
  return {
    u: (longitudeDegrees - bounds.west) / (bounds.east - bounds.west),
    v:
      south === north
        ? 0
        : (normalizedMercatorYForLatitude(latitudeDegrees) - north) /
          (south - north),
  };
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
    v: 1 - (resource.sourceOffsetY + 1 - tileV) / resource.sourceScale,
  };
}

export function decodeTerrariumElevationMetres(
  red: number,
  green: number,
  blue: number,
): number {
  return red * 256 + green + blue / 256 - 32_768;
}

/** Samples the same manually bilinear Terrarium surface used by the vertex shader. */
export function sampleTerrariumElevationMetres(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  u: number,
  v: number,
): number {
  const pixelX = Math.max(0, Math.min(width - 1, u * width - 0.5));
  // Three flips DOM images during texture upload, so texture-v 1 is image row 0.
  const pixelY = Math.max(0, Math.min(height - 1, (1 - v) * height - 0.5));
  const west = Math.floor(pixelX);
  const east = Math.min(west + 1, width - 1);
  const north = Math.floor(pixelY);
  const south = Math.min(north + 1, height - 1);
  const amountX = pixelX - west;
  const amountY = pixelY - north;
  const elevationAt = (x: number, y: number): number => {
    const offset = (y * width + x) * 4;
    return decodeTerrariumElevationMetres(
      pixels[offset]!,
      pixels[offset + 1]!,
      pixels[offset + 2]!,
    );
  };
  const northElevation = THREE.MathUtils.lerp(
    elevationAt(west, north),
    elevationAt(east, north),
    amountX,
  );
  const southElevation = THREE.MathUtils.lerp(
    elevationAt(west, south),
    elevationAt(east, south),
    amountX,
  );
  return THREE.MathUtils.lerp(northElevation, southElevation, amountY);
}

/**
 * Converts room-space eye height to physical height for a uniformly scaled
 * globe. Terrain displacement is deliberately absent from this calculation.
 */
export function flatSurfaceObserverHeightMetres(
  observerHeightWorldM: number,
  displayRadiusM: number,
): number {
  return (observerHeightWorldM * EARTH_MEAN_RADIUS_KM * 1_000) / displayRadiusM;
}

export function terrainTargetForView(
  view: TerrainSurfaceView,
  tilePixels: number,
  options: {
    readonly targetScreenPixelsPerSourcePixel?: number;
    readonly maxTopologyZoom?: number | null;
  } = {},
): TileLayoutTarget {
  const selectedZoom = observerTileZoom({
    observerHeightMeters: flatSurfaceObserverHeightMetres(
      view.observerHeightWorldM,
      view.displayRadiusM,
    ),
    latitudeDegrees: view.latitudeDegrees,
    projectedFocalLengthPixels: view.focalLengthPixels,
    tilePixels,
    targetScreenPixelsPerSourcePixel:
      options.targetScreenPixelsPerSourcePixel ??
      TERRAIN_TARGET_SCREEN_PIXELS_PER_ELEVATION_PIXEL,
  }).zoom;
  const zoom = options.maxTopologyZoom === undefined ||
      options.maxTopologyZoom === null
    ? selectedZoom
    : Math.min(selectedZoom, Math.max(0, Math.floor(options.maxTopologyZoom)));
  return normalizeTileLayoutTarget({
    maxZoom: zoom,
    latitudeDegrees: view.latitudeDegrees,
    longitudeDegrees: view.longitudeDegrees,
  });
}

function sameCut(
  first: readonly TileIdentity[],
  second: readonly TileIdentity[],
): boolean {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    if (tileIdentityKey(first[index]!) !== tileIdentityKey(second[index]!)) {
      return false;
    }
  }
  return true;
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

function patchGeometry(
  bounds: { west: number; east: number; north: number; south: number },
  columns: number,
  rows: number,
  includeSkirts = true,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const baseUvs: number[] = [];
  const tileUvs: number[] = [];
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
    const baseUv = earthTextureUv(latitude, longitude);
    baseUvs.push(baseUv.u, baseUv.v);
    tileUvs.push(tileU, tileV);
    const imageryUv = imageryUvForGeographicPoint(bounds, latitude, longitude);
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
        imageryUvs.push(imageryUvs[uvOffset]!, imageryUvs[uvOffset + 1]!);
        skirts.push(1);
        return positions.length / 3 - 1;
      });
      for (let index = 0; index < edge.length - 1; index += 1) {
        const first = edge[index]!;
        const second = edge[index + 1]!;
        const firstSkirt = skirtEdge[index]!;
        const secondSkirt = skirtEdge[index + 1]!;
        indices.push(
          first,
          firstSkirt,
          second,
          second,
          firstSkirt,
          secondSkirt,
        );
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("baseUv", new THREE.Float32BufferAttribute(baseUvs, 2));
  geometry.setAttribute("tileUv", new THREE.Float32BufferAttribute(tileUvs, 2));
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
  return new THREE.Color().setHSL((((zoom * 0.137) % 1) + 1) % 1, 0.7, 0.48);
}

const VERTEX_SHADER = `
  in vec2 baseUv;
  in vec2 tileUv;
  in vec2 imageryUv;
  in float skirt;
  uniform sampler2D elevationMap;
  uniform float elevationEnabled;
  uniform float normalizedRadialMetres;
  uniform float normalizedSkirtDepth;
  uniform vec4 elevationUvTransform;
  out vec2 vBlueMarbleUv;
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
    vec2 elevationUv = tileUv * elevationUvTransform.xy + elevationUvTransform.zw;
    float heightM = elevationEnabled > 0.5 ? elevationAt(elevationUv) : 0.0;
    vec3 displaced =
      position + normal * heightM * normalizedRadialMetres -
      normal * normalizedSkirtDepth * skirt;
    vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
    vBlueMarbleUv = baseUv;
    vTileUv = tileUv;
    vImageryUv = imageryUv;
    vWorldPosition = worldPosition.xyz;
    vBaseNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const FRAGMENT_SHADER = `
  ${IMAGERY_FRAGMENT_DECLARATIONS}
  uniform float photographicImageryAllowed;
  uniform float tileOverlayVisible;
  uniform float textureOverlayVisible;
  uniform vec3 tileTint;
  uniform vec3 sunlight;
  in vec2 vTileUv;
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
    vec3 albedo = photographicImageryAllowed > 0.5
      ? resolvedImageryAlbedo()
      : texture(blueMarbleMap, vBlueMarbleUv).rgb;
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
    vec4 imageryTileOverlay =
      photographicImageryAllowed > 0.5 && textureOverlayVisible > 0.0
      ? resolvedImageryTileOverlay()
      : vec4(0.0);
    colour = mix(
      colour,
      imageryTileOverlay.rgb,
      textureOverlayVisible * imageryTileOverlay.a
    );
    surfaceColour = vec4(colour, 1.0);
  }
`;

/** Atomic terrain topology renderer with late-bound photographic imagery. */
export class TerrainSurface {
  readonly group = new THREE.Group();
  private readonly provider: ElevationTileProvider;
  private readonly imagery: ImageryVirtualTexture;
  private readonly scheduler: TileWorkerScheduler<ElevationTileResource>;
  private readonly meshes = new Map<string, SurfaceMesh>();
  private readonly elevationTextures = new ImageTexturePool<
    HTMLImageElement,
    THREE.Texture
  >();
  private readonly stagedElevations = new Map<string, HTMLImageElement>();
  private readonly elevationPixels = new WeakMap<HTMLImageElement, ImageData>();
  private readonly elevationSamplingCanvas: HTMLCanvasElement;
  private readonly elevationSamplingContext: CanvasRenderingContext2D;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly terrainLod: NormalizedTerrainLodOptions;
  private readonly renderVisibility: TerrainRenderVisibility;
  private readonly polarVisibilityEntries: TerrainRenderVisibilityEntry[] = [];
  private readonly emptyTexture: THREE.DataTexture;
  private readonly sharedUniforms: Record<string, THREE.IUniform>;
  private readonly unsubscribe: () => void;
  private snapshot: SchedulerSnapshot<TileLayoutTarget>;
  private currentTarget: TileLayoutTarget;
  private readonly horizonCulling = new TileHorizonCulling();
  private horizonView: TileHorizonView;
  private debugControls: TileDebugControls = createTileDebugControls();
  private latestView: TerrainSurfaceView;

  constructor(options: TerrainSurfaceOptions) {
    this.renderer = options.renderer;
    this.terrainLod = normalizeTerrainLodOptions(
      MAPTERHORN_ELEVATION_PROVIDER_METADATA,
      options.terrainLod,
    );
    this.renderVisibility = new TerrainRenderVisibility(
      this.group,
      MAPTERHORN_ELEVATION_PROVIDER_METADATA.elevationBoundsMetres,
    );
    this.renderVisibility.updateDisplacement(
      options.initialView.radialMultiplier,
      options.initialView.displayRadiusM,
    );
    this.latestView = options.initialView;
    this.elevationSamplingCanvas = document.createElement("canvas");
    const elevationSamplingContext = this.elevationSamplingCanvas.getContext(
      "2d",
      { willReadFrequently: true },
    );
    if (!elevationSamplingContext) {
      throw new Error("Terrain elevation sampling requires a 2D canvas context.");
    }
    this.elevationSamplingContext = elevationSamplingContext;
    this.group.name = "terrain-surface";
    options.baseTexture.wrapS = THREE.RepeatWrapping;
    options.baseTexture.wrapT = THREE.ClampToEdgeWrapping;
    options.baseTexture.needsUpdate = true;

    const elevationProvider = createElevationTileProvider(
      MAPTERHORN_ELEVATION_PROVIDER_METADATA,
      this.terrainLod.maxElevationSourceZoom,
    );
    this.imagery = new ImageryVirtualTexture(
      options.renderer,
      options.baseTexture,
      options.imageryProvider,
      options.initialView,
    );
    this.provider = new ElevationTileProvider(elevationProvider);
    this.currentTarget = terrainTargetForView(
      options.initialView,
      this.provider.tilePixels,
      {
        targetScreenPixelsPerSourcePixel:
          this.debugControls.terrain.screenPixelsPerSourcePixel,
        maxTopologyZoom: this.debugControls.terrain.maxZoom,
      },
    );
    this.horizonView = options.initialView;
    this.scheduler = new TileWorkerScheduler(this.currentTarget, {
      provider: this.provider,
      retryDelayMs: 5_000,
      retryMaxDelayMs: TRANSIENT_RETRY_MAX_DELAY_MS,
    });
    this.snapshot = this.scheduler.snapshot;
    this.emptyTexture = new THREE.DataTexture(
      new Uint8Array([0, 0, 0, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    this.emptyTexture.needsUpdate = true;
    this.sharedUniforms = {
      normalizedRadialMetres: {
        value:
          options.initialView.radialMultiplier / (EARTH_MEAN_RADIUS_KM * 1_000),
      },
      normalizedSkirtDepth: {
        value: SKIRT_DEPTH_WORLD_METRES / options.initialView.displayRadiusM,
      },
      tileOverlayVisible: { value: 0 },
      textureOverlayVisible: { value: 0 },
      sunlight: { value: new THREE.Vector3(-0.38, 0.82, 0.42).normalize() },
    };
    this.addPolarCaps();
    this.syncRenderVisibilityEntries();
    this.imagery.update(options.initialView, this.horizonView);
    this.unsubscribe = this.scheduler.subscribe((snapshot, event) => {
      const committedChanged =
        !event && !sameCut(this.snapshot.committedCut, snapshot.committedCut);
      this.snapshot = snapshot;
      this.applyHorizonCulling();
      if (
        event?.kind === "atomic-swap" ||
        event?.sequence === -1 ||
        (!event && committedChanged)
      ) {
        this.syncMeshes();
      } else if (event?.kind === "response" && event.tile) {
        const resource = this.scheduler.committedResource(event.tile);
        this.stageElevation(event.tile, resource);
        const entry = this.meshes.get(tileIdentityKey(event.tile));
        if (entry) {
          this.updateElevation(entry, resource);
        }
      }
      this.pruneStagedElevations();
    });
  }

  update(view: TerrainSurfaceView): void {
    this.latestView = view;
    this.sharedUniforms.normalizedRadialMetres!.value =
      view.radialMultiplier / (EARTH_MEAN_RADIUS_KM * 1_000);
    this.sharedUniforms.normalizedSkirtDepth!.value =
      SKIRT_DEPTH_WORLD_METRES / view.displayRadiusM;
    this.renderVisibility.updateDisplacement(
      view.radialMultiplier,
      view.displayRadiusM,
    );
    this.horizonView = view;
    this.imagery.update(view, this.horizonView, {
      recalculateTopology: this.debugControls.textures.recalculationEnabled,
    });
    this.applyHorizonCulling();
    if (!this.debugControls.terrain.recalculationEnabled) return;
    const target = terrainTargetForView(view, this.provider.tilePixels, {
      targetScreenPixelsPerSourcePixel:
        this.debugControls.terrain.screenPixelsPerSourcePixel,
      maxTopologyZoom: this.debugControls.terrain.maxZoom,
    });
    if (this.scheduler.updateTarget(target)) {
      this.currentTarget = target;
    }
  }

  /** Returns the elevation currently rendered at a geographic point. */
  sampleElevationMetres(
    latitudeDegrees: number,
    longitudeDegrees: number,
  ): number {
    if (Math.abs(latitudeDegrees) > WEB_MERCATOR_MAX_LATITUDE) return 0;
    for (let zoom = this.currentTarget.maxZoom; zoom >= 0; zoom -= 1) {
      const width = 2 ** zoom;
      const x = wrapTileX(
        Math.floor(mercatorTileX(longitudeDegrees, zoom)),
        zoom,
      );
      const y = Math.max(
        0,
        Math.min(width - 1, Math.floor(mercatorTileY(latitudeDegrees, zoom))),
      );
      const entry = this.meshes.get(tileIdentityKey({ z: zoom, x, y }));
      if (!entry) continue;
      if (!entry.elevation) return 0;
      const localUv = imageryUvForGeographicPoint(
        tileBounds(entry.tile),
        latitudeDegrees,
        longitudeDegrees,
      );
      const sourceUv = sourceUvForTilePoint(
        entry.elevation,
        localUv.u,
        1 - localUv.v,
      );
      const pixels = this.pixelsForElevation(entry.elevation.image);
      return sampleTerrariumElevationMetres(
        pixels.data,
        pixels.width,
        pixels.height,
        sourceUv.u,
        sourceUv.v,
      );
    }
    return 0;
  }

  getLodStatus(): { minZoom: number; maxZoom: number; budgetLimited: boolean } {
    const zooms = this.snapshot.committedCut.map(({ z }) => z);
    return {
      minZoom: zooms.length > 0 ? Math.min(...zooms) : 0,
      maxZoom: zooms.length > 0 ? Math.max(...zooms) : 0,
      budgetLimited: false,
    };
  }

  getMetrics(): TerrainRuntimeMetrics {
    const elevation = this.provider.metrics;
    const horizon = this.horizonCulling.metrics;
    return {
      committedLeafCount: this.snapshot.committedCut.length,
      horizonTerrainTileCount: horizon.horizonTileCount,
      horizonClassificationTotal: horizon.classificationTotal,
      renderVisibility: this.renderVisibility.metrics,
      imagery: this.imagery.getMetrics(),
      elevation: {
        decodedSourceCount: elevation.decodedSourceCount,
        textureCount: this.elevationTextures.size,
        requestTotal: elevation.requestTotal,
        sourceLoadTotal: elevation.sourceLoadTotal,
        estimatedCpuBytes: elevation.estimatedDecodedBytes,
        estimatedGpuBytes:
          this.elevationTextures.size * this.provider.tilePixels *
          this.provider.tilePixels * 4,
      },
    };
  }

  setTileOverlayVisible(visible: boolean): void {
    this.sharedUniforms.tileOverlayVisible!.value = visible ? 1 : 0;
  }

  setTextureTileOverlayVisible(visible: boolean): void {
    this.sharedUniforms.textureOverlayVisible!.value = visible ? 1 : 0;
  }

  setSunlightDirection(directionWorld: THREE.Vector3): void {
    const sunlight = this.sharedUniforms.sunlight!.value as THREE.Vector3;
    sunlight.copy(directionWorld).normalize();
  }

  get hasCommittedSurface(): boolean {
    return this.snapshot.committedCut.length > 0;
  }

  get renderCullingEnabled(): boolean {
    return this.renderVisibility.enabled;
  }

  updateRenderVisibility(camera: THREE.Camera): void {
    if (!this.group.visible) return;
    this.renderVisibility.update(camera);
  }

  setRenderCullingEnabled(enabled: boolean): boolean {
    this.renderVisibility.setEnabled(enabled);
    return this.renderVisibility.enabled;
  }

  clearRenderVisibilityMetrics(): void {
    this.renderVisibility.clearMetrics();
  }

  getTileDebugControls(): TileDebugControlsReadback {
    return tileDebugControlsReadback(
      this.debugControls,
      this.currentTarget.maxZoom,
      this.imagery.getTargetZoom(),
    );
  }

  getTilePlannerState() {
    const payloadRequests = this.scheduler.debugState;
    const provider = this.provider.metrics;
    const horizon = this.horizonCulling.metrics;
    return {
      terrain: {
        recalculation_enabled:
          this.debugControls.terrain.recalculationEnabled,
        effective_target: { ...this.currentTarget },
        ...summarizeTilePlannerSnapshot(this.snapshot),
        payload_tile_requests: payloadRequests,
        source_jobs: {
          queued: provider.queued,
          network_deferred: provider.networkDeferred,
          in_flight: provider.inFlight,
        },
        horizon_culling: {
          retained_planner_tile_count: horizon.horizonTileCount,
          horizon_candidate_count:
            payloadRequests.horizon_candidate_count,
          committed_topology_tile_count: this.snapshot.committedCut.length,
        },
      },
      textures: this.imagery.getPlannerState(),
    };
  }

  setTilePixelRatio(
    argumentsValue: TilePixelRatioArguments,
  ): TileDebugControlsReadback {
    return this.setDebugControls(
      withTilePixelRatio(this.debugControls, argumentsValue),
    );
  }

  setTileMaxZoom(
    argumentsValue: TileOptionalZoomArguments,
  ): TileDebugControlsReadback {
    return this.setDebugControls(
      withTileMaxZoom(this.debugControls, argumentsValue),
    );
  }

  setTileRecalculation(
    argumentsValue: TileRecalculationArguments,
  ): TileDebugControlsReadback {
    return this.setDebugControls(
      withTileRecalculation(this.debugControls, argumentsValue),
    );
  }

  retryFailed(): void {
    this.scheduler.retryFailed();
  }

  dispose(): void {
    this.unsubscribe();
    this.scheduler.dispose();
    this.provider.dispose();
    this.imagery.dispose();
    for (const entry of this.meshes.values()) {
      this.releaseTexture(this.elevationTextures, entry.elevation?.image);
      this.group.remove(entry.mesh);
      this.disposeMesh(entry.mesh);
    }
    this.meshes.clear();
    for (const image of this.stagedElevations.values()) {
      this.releaseTexture(this.elevationTextures, image);
    }
    this.stagedElevations.clear();
    this.renderVisibility.setEntries([]);
    this.elevationTextures.dispose();
    this.emptyTexture.dispose();
    for (const child of [...this.group.children]) {
      if (!(child instanceof THREE.Mesh)) continue;
      this.group.remove(child);
      this.disposeMesh(
        child as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>,
      );
    }
  }

  private syncMeshes(): void {
    const retained = new Set(
      this.snapshot.committedCut.map((tile) => tileIdentityKey(tile)),
    );
    const obsolete = [...this.meshes].filter(([key]) => !retained.has(key));
    for (const tile of this.snapshot.committedCut) {
      const key = tileIdentityKey(tile);
      const current = this.meshes.get(key);
      if (current) {
        this.updateElevation(current, this.scheduler.committedResource(tile));
        continue;
      }
      const entry = this.createTileMesh(tile);
      this.meshes.set(key, entry);
      this.group.add(entry.mesh);
      this.updateElevation(entry, this.scheduler.committedResource(tile));
    }
    for (const [key, entry] of obsolete) {
      this.meshes.delete(key);
      this.releaseTexture(this.elevationTextures, entry.elevation?.image);
      this.group.remove(entry.mesh);
      this.disposeMesh(entry.mesh);
    }
    this.syncRenderVisibilityEntries();
  }

  private applyHorizonCulling(): void {
    if (
      this.snapshot.committedCut.length === 0
    ) return;
    const retainedTiles = this.horizonCulling.update({
      revision: this.snapshot.revision,
      committedTiles: this.snapshot.committedCut,
      replacementGroups: this.snapshot.graph.groups,
      view: this.horizonView,
    });
    if (retainedTiles) {
      this.scheduler.updateHorizonCulling(retainedTiles);
    }
    this.provider.retainSourceTiles(this.scheduler.workingSetTiles);
  }

  private setDebugControls(
    controls: TileDebugControls,
  ): TileDebugControlsReadback {
    this.debugControls = controls;
    this.imagery.setDebugControls(controls.textures);
    this.update(this.latestView);
    return this.getTileDebugControls();
  }

  private createTileMesh(tile: TileIdentity): SurfaceMesh {
    const segments = terrainSegmentsForZoom(
      tile.z,
      this.terrainLod.segmentTiers,
    );
    const bounds = tileBounds(tile);
    const imageryBounds = imageryBoundsForGeographicBounds(bounds);
    const geometry = patchGeometry(bounds, segments, segments);
    const elevationMap = this.emptyTexture;
    const material = this.surfaceMaterial({
      elevationMap,
      elevationEnabled: 0,
      tileTint: tileTint(tile.z),
    });
    this.imagery.configureMaterial(
      material,
      imageryBounds,
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `surface-tile:${tileIdentityKey(tile)}`;
    mesh.frustumCulled = false;
    return {
      tile: Object.freeze({ ...tile }),
      mesh,
      visibilityEntry: createTerrainRenderVisibilityEntry(mesh, true),
    };
  }

  private addPolarCaps(): void {
    for (const bounds of [
      { west: -180, east: 180, north: 90, south: WEB_MERCATOR_MAX_LATITUDE },
      { west: -180, east: 180, north: -WEB_MERCATOR_MAX_LATITUDE, south: -90 },
    ]) {
      const mesh = new THREE.Mesh(
        patchGeometry(bounds, 128, 8, false),
        this.surfaceMaterial({
          elevationMap: this.emptyTexture,
          elevationEnabled: 0,
          photographicImageryAllowed: false,
          tileTint: new THREE.Color(0x3d8a95),
        }),
      );
      mesh.name = "flat-polar-cap";
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.polarVisibilityEntries.push(
        createTerrainRenderVisibilityEntry(mesh, false),
      );
    }
  }

  private syncRenderVisibilityEntries(): void {
    const entries = [...this.polarVisibilityEntries];
    for (const mesh of this.meshes.values()) {
      entries.push(mesh.visibilityEntry);
    }
    this.renderVisibility.setEntries(entries);
  }

  private surfaceMaterial(values: {
    elevationMap: THREE.Texture;
    elevationEnabled: number;
    elevationUvTransform?: THREE.Vector4;
    photographicImageryAllowed?: boolean;
    tileTint: THREE.Color;
  }): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      uniforms: {
        ...this.sharedUniforms,
        ...this.imagery.materialUniforms(),
        elevationMap: { value: values.elevationMap },
        elevationEnabled: { value: values.elevationEnabled },
        elevationUvTransform: {
          value: values.elevationUvTransform ?? new THREE.Vector4(1, 1, 0, 0),
        },
        photographicImageryAllowed: {
          value: values.photographicImageryAllowed === false ? 0 : 1,
        },
        tileTint: { value: values.tileTint },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });
  }

  private textureForElevation(resource: ImageTileResource): THREE.Texture {
    return this.elevationTextures.acquire(resource.image, () => {
      const texture = new THREE.Texture(resource.image);
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      this.renderer.initTexture(texture);
      return texture;
    });
  }

  private pixelsForElevation(image: HTMLImageElement): ImageData {
    const existing = this.elevationPixels.get(image);
    if (existing) return existing;
    this.elevationSamplingCanvas.width = image.naturalWidth;
    this.elevationSamplingCanvas.height = image.naturalHeight;
    this.elevationSamplingContext.clearRect(
      0,
      0,
      image.naturalWidth,
      image.naturalHeight,
    );
    this.elevationSamplingContext.drawImage(image, 0, 0);
    const pixels = this.elevationSamplingContext.getImageData(
      0,
      0,
      image.naturalWidth,
      image.naturalHeight,
    );
    this.elevationPixels.set(image, pixels);
    return pixels;
  }

  private stageElevation(
    tile: TileIdentity,
    resource: ElevationTileResource | undefined,
  ): void {
    const key = tileIdentityKey(tile);
    const elevation = resource?.elevation;
    const previous = this.stagedElevations.get(key);
    if (previous === elevation?.image) return;
    if (previous) {
      this.stagedElevations.delete(key);
      this.releaseTexture(this.elevationTextures, previous);
    }
    if (!elevation) return;
    this.textureForElevation(elevation);
    this.stagedElevations.set(key, elevation.image);
  }

  private consumeStagedElevation(tile: TileIdentity): void {
    const key = tileIdentityKey(tile);
    const image = this.stagedElevations.get(key);
    if (!image) return;
    this.stagedElevations.delete(key);
    this.releaseTexture(this.elevationTextures, image);
  }

  private pruneStagedElevations(): void {
    if (this.stagedElevations.size === 0) return;
    const liveKeys = new Set(
      this.scheduler.workingSetTiles.map(tileIdentityKey),
    );
    for (const [key, image] of this.stagedElevations) {
      if (liveKeys.has(key)) continue;
      this.stagedElevations.delete(key);
      this.releaseTexture(this.elevationTextures, image);
    }
  }

  private sourceTransform(resource: ImageTileResource): THREE.Vector4 {
    return new THREE.Vector4(
      1 / resource.sourceScale,
      1 / resource.sourceScale,
      resource.sourceOffsetX / resource.sourceScale,
      (resource.sourceScale - resource.sourceOffsetY - 1) /
        resource.sourceScale,
    );
  }

  private updateElevation(
    entry: SurfaceMesh,
    resource: ElevationTileResource | undefined,
  ): void {
    const elevation = resource?.elevation;
    if (entry.elevation === elevation) {
      this.consumeStagedElevation(entry.tile);
      return;
    }
    this.releaseTexture(this.elevationTextures, entry.elevation?.image);
    entry.elevation = elevation;
    entry.elevationTexture = elevation
      ? this.textureForElevation(elevation)
      : undefined;
    this.consumeStagedElevation(entry.tile);
    entry.mesh.material.uniforms.elevationMap!.value =
      entry.elevationTexture ?? this.emptyTexture;
    entry.mesh.material.uniforms.elevationEnabled!.value = elevation ? 1 : 0;
    entry.mesh.material.uniforms.elevationUvTransform!.value = elevation
      ? this.sourceTransform(elevation)
      : new THREE.Vector4(1, 1, 0, 0);
  }

  private releaseTexture(
    textures: ImageTexturePool<HTMLImageElement, THREE.Texture>,
    image: HTMLImageElement | undefined,
  ): void {
    textures.release(image);
  }

  private disposeMesh(
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>,
  ): void {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}
