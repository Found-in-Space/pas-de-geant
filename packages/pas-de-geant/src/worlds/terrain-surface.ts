import type { WorldWorkerFactory } from "./workers.js";
import * as THREE from "three";
import { ImageTexturePool } from "./image-texture-pool.js";
import type { ImageTileResource } from "./image-tile-provider.js";
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
  FlatElevationTileProvider,
  type TerrainElevationProvider,
  type ElevationTileResource,
} from "./elevation-tile-provider.js";
import {
  projectedTilePoint,
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
  tileTopologySelectionChanged,
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
  plannerHorizonCandidates,
  type TileHorizonView,
} from "./tile-horizon-culling.js";
import {
  normalizeTerrainLodOptions,
  terrainRefinementLimits,
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
import {
  decodeHeightMetres,
  EARTH_SURFACE_MODEL,
  type SurfaceModel,
} from "./surface-model.js";
import {
  meshCellAngularRadius,
  surfaceDisplacementBounds,
  TERRAIN_SKIRT_DEPTH_WORLD_METRES,
} from "./surface-visibility-geometry.js";

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const SKIRT_DEPTH_WORLD_METRES = TERRAIN_SKIRT_DEPTH_WORLD_METRES;
const TRANSIENT_RETRY_MAX_DELAY_MS = 5 * 60_000;
/** Geometry LOD density; deliberately independent from imagery texel density. */
export const TERRAIN_TARGET_SCREEN_PIXELS_PER_ELEVATION_PIXEL =
  DEFAULT_TERRAIN_SCREEN_PIXELS_PER_SOURCE_PIXEL;

export interface TerrainSurfaceView {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly displayRadiusM: number;
  readonly terrainMultiplier: number;
  /** Eye height above the local terrain contact in render metres. */
  readonly observerHeightWorldM: number;
  readonly focalLengthPixels: number;
  readonly projection?: "web-mercator" | "geographic";
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

/** Optional output presentation for photographic surfaces, shared by base and detail. */
export interface TerrainDisplayPresentation {
  /** Neutral omits the final solar modulation and blue fill, retaining image shading. */
  readonly lighting: "scene" | "neutral";
  /** Linear-light gain applied before conversion to the renderer's output colour space. */
  readonly gain: number;
  /** Output-space sigmoid slope; 1 is identity, greater values increase contrast. */
  readonly contrast: number;
  /** Output-space value left fixed by the contrast curve, strictly between 0 and 1. */
  readonly contrastPivot: number;
}

export interface TerrainSurfaceOptions {
  readonly workers?: WorldWorkerFactory;
  readonly renderer: THREE.WebGLRenderer;
  readonly baseTexture: THREE.Texture;
  readonly imageryProvider?: ImageryProvider;
  readonly elevationProvider?: TerrainElevationProvider;
  readonly surfaceModel?: SurfaceModel;
  readonly terrainLod?: TerrainLodOptions;
  /** Uniform linear-light presentation curve; 1 preserves source values. */
  readonly albedoToneExponent?: number;
  /** Enables explicit display conversion and grading; omit to retain the existing presentation. */
  readonly displayPresentation?: TerrainDisplayPresentation;
  readonly initialView: TerrainSurfaceView;
}

interface SurfaceMesh {
  readonly tile: TileIdentity;
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly visibilityEntry: TerrainRenderVisibilityEntry;
  elevationResource?: ElevationTileResource;
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
  projection: "web-mercator" | "geographic" = "web-mercator",
): SourceUv {
  const projectedY = projection === "geographic"
    ? (latitude: number) => (90 - latitude) / 180
    : normalizedMercatorYForLatitude;
  const north = projectedY(bounds.north);
  const south = projectedY(bounds.south);
  return {
    u: (longitudeDegrees - bounds.west) / (bounds.east - bounds.west),
    v:
      south === north
        ? 0
        : (projectedY(latitudeDegrees) - north) /
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
  return sampleEncodedElevationMetres(
    pixels,
    width,
    height,
    u,
    v,
    { kind: "terrarium" },
  );
}

export function sampleEncodedElevationMetres(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  u: number,
  v: number,
  encoding: SurfaceModel["heightEncoding"],
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
    return decodeHeightMetres(
      encoding,
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

function bilinearTexelRange(
  offset: number,
  scale: number,
  size: number,
): { readonly first: number; readonly last: number } {
  const firstSample = Math.max(
    0,
    Math.min(size - 1, offset / scale * size - 0.5),
  );
  const lastSample = Math.max(
    0,
    Math.min(size - 1, (offset + 1) / scale * size - 0.5),
  );
  return {
    first: Math.floor(firstSample),
    last: Math.ceil(lastSample),
  };
}

/**
 * Conservative extrema for every source texel that can contribute to the
 * tile's manually bilinear shader samples, including overzoom crop edges.
 */
export function elevationBoundsForTile(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  resource: Pick<
    ImageTileResource,
    "sourceScale" | "sourceOffsetX" | "sourceOffsetY"
  >,
  encoding: SurfaceModel["heightEncoding"],
): { readonly minimum: number; readonly maximum: number } {
  const columns = bilinearTexelRange(
    resource.sourceOffsetX,
    resource.sourceScale,
    width,
  );
  const rows = bilinearTexelRange(
    resource.sourceOffsetY,
    resource.sourceScale,
    height,
  );
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let y = rows.first; y <= rows.last; y += 1) {
    for (let x = columns.first; x <= columns.last; x += 1) {
      const offset = (y * width + x) * 4;
      const elevation = decodeHeightMetres(
        encoding,
        pixels[offset]!,
        pixels[offset + 1]!,
        pixels[offset + 2]!,
      );
      minimum = Math.min(minimum, elevation);
      maximum = Math.max(maximum, elevation);
    }
  }
  return Object.freeze({ minimum, maximum });
}

export function terrainTargetForView(
  view: TerrainSurfaceView,
  tilePixels: number,
  options: {
    readonly targetScreenPixelsPerSourcePixel?: number;
    readonly maxTopologyZoom?: number | null;
    readonly projection?: "web-mercator" | "geographic";
    readonly previousZoom?: number;
    readonly coarsenHysteresisWorldM?: number;
  } = {},
): TileLayoutTarget {
  const selectedZoom = observerTileZoom({
    projection: options.projection ?? view.projection,
    observerHeightWorldM: view.observerHeightWorldM,
    displayRadiusM: view.displayRadiusM,
    latitudeDegrees: view.latitudeDegrees,
    projectedFocalLengthPixels: view.focalLengthPixels,
    tilePixels,
    targetScreenPixelsPerSourcePixel:
      options.targetScreenPixelsPerSourcePixel ??
      TERRAIN_TARGET_SCREEN_PIXELS_PER_ELEVATION_PIXEL,
    previousZoom: options.previousZoom,
    maximumZoom: options.maxTopologyZoom,
    coarsenHysteresisWorldM: options.coarsenHysteresisWorldM,
  }).zoom;
  return normalizeTileLayoutTarget({
    maxZoom: selectedZoom,
    latitudeDegrees: view.latitudeDegrees,
    longitudeDegrees: view.longitudeDegrees,
    projection: options.projection ?? view.projection,
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

export function terrainPatchGeometry(
  bounds: { west: number; east: number; north: number; south: number },
  columns: number,
  rows: number,
  includeSkirts = true,
  surfaceModel: SurfaceModel = EARTH_SURFACE_MODEL,
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
    skirt: number,
  ): number => {
    const vertex = surfaceModel.positionAndNormal(latitude, longitude);
    positions.push(vertex.position.x, vertex.position.y, vertex.position.z);
    normals.push(vertex.normal.x, vertex.normal.y, vertex.normal.z);
    const baseUv = surfaceModel.baseTextureUv(latitude, longitude);
    baseUvs.push(baseUv.u, baseUv.v);
    const imageryUv = imageryUvForGeographicPoint(
      bounds,
      latitude,
      longitude,
      surfaceModel.projection,
    );
    // Elevation and imagery share a grid. Mesh rows are uniform in latitude,
    // so Mercator elevation UVs must also use projected Y, as CPU sampling does.
    tileUvs.push(imageryUv.u, 1 - imageryUv.v);
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

/** Bounds the chord error of the complete committed and incoming mesh cut. */
export function terrainMeshAngularMargin(
  model: SurfaceModel,
  tiles: readonly TileIdentity[],
  lod: NormalizedTerrainLodOptions,
): number {
  let margin = 0;
  const candidates = tiles.length > 0 ? tiles : [{ z: 0, x: 0, y: 0 }];
  for (const tile of candidates) {
    margin = Math.max(margin, meshCellAngularRadius(
      model.visibilityGeometry, model.tileBounds(tile),
      terrainSegmentsForZoom(tile.z, lod.segmentTiers, model.minimumProjectedWorldSegments),
    ));
  }
  if (model.hasPolarCaps) {
    margin = Math.max(margin, meshCellAngularRadius(model.visibilityGeometry, {
      west: -180, east: 180, north: 90, south: WEB_MERCATOR_MAX_LATITUDE,
    }, 128, 8));
  }
  return margin;
}

const VERTEX_SHADER = `
  #include <common>
  #include <logdepthbuf_pars_vertex>

  in vec2 baseUv;
  in vec2 tileUv;
  in vec2 imageryUv;
  in float skirt;
  uniform sampler2D elevationMap;
  uniform float elevationEnabled;
  uniform float bodyLocalUnitsPerElevationMetre;
  uniform float bodyLocalSkirtDepth;
  uniform vec4 elevationUvTransform;
  uniform float heightEncodingKind;
  uniform float heightScaleM;
  uniform float heightOffsetM;
  out vec2 vBlueMarbleUv;
  out vec2 vTileUv;
  out vec2 vImageryUv;
  out vec3 vBaseWorldPosition;
  out vec3 vWorldPosition;
  out vec3 vBaseNormal;
  out float vElevationHeightWorld;
  out float vSkirt;

  float decodeTerrarium(vec3 encoded) {
    vec3 bytes = floor(encoded * 255.0 + 0.5);
    return bytes.r * 256.0 + bytes.g + bytes.b / 256.0 - 32768.0;
  }

  float decodeHeight(vec3 encoded) {
    if (heightEncodingKind < 0.5) return decodeTerrarium(encoded);
    vec3 bytes = floor(encoded * 255.0 + 0.5);
    return (bytes.r * 256.0 + bytes.g) * heightScaleM + heightOffsetM;
  }

  float elevationAt(vec2 uv) {
    ivec2 size = textureSize(elevationMap, 0);
    vec2 pixel = clamp(uv * vec2(size) - 0.5, vec2(0.0), vec2(size - 1));
    ivec2 northWest = ivec2(floor(pixel));
    ivec2 southEast = min(northWest + ivec2(1), size - 1);
    vec2 amount = fract(pixel);
    float north = mix(
      decodeHeight(texelFetch(elevationMap, northWest, 0).rgb),
      decodeHeight(texelFetch(elevationMap, ivec2(southEast.x, northWest.y), 0).rgb),
      amount.x
    );
    float south = mix(
      decodeHeight(texelFetch(elevationMap, ivec2(northWest.x, southEast.y), 0).rgb),
      decodeHeight(texelFetch(elevationMap, southEast, 0).rgb),
      amount.x
    );
    return mix(north, south, amount.y);
  }

  void main() {
    vec2 elevationUv = tileUv * elevationUvTransform.xy + elevationUvTransform.zw;
    float heightM = elevationEnabled > 0.5 ? elevationAt(elevationUv) : 0.0;
    vec3 baseNormalWorld = normalize(mat3(modelMatrix) * normal);
    vec3 elevationOffsetWorld = mat3(modelMatrix) *
      (normal * heightM * bodyLocalUnitsPerElevationMetre);
    vec3 displaced =
      position + normal * heightM * bodyLocalUnitsPerElevationMetre -
      normal * bodyLocalSkirtDepth * skirt;
    vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
    vBlueMarbleUv = baseUv;
    vTileUv = tileUv;
    vImageryUv = imageryUv;
    vBaseWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    vWorldPosition = worldPosition.xyz;
    vBaseNormal = baseNormalWorld;
    vElevationHeightWorld = dot(elevationOffsetWorld, baseNormalWorld);
    vSkirt = skirt;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
    #include <logdepthbuf_vertex>
  }
`;

const FRAGMENT_SHADER = `
  #include <logdepthbuf_pars_fragment>

  ${IMAGERY_FRAGMENT_DECLARATIONS}
  uniform float photographicImageryAllowed;
  uniform float tileOverlayVisible;
  uniform float textureOverlayVisible;
  uniform sampler2D surfaceOverlayMap;
  uniform float surfaceOverlayVisible;
  uniform vec4 surfaceOverlayUvTransform;
  uniform vec3 tileTint;
  uniform vec3 sunlight;
  uniform float albedoToneExponent;
  #ifdef SURFACE_DISPLAY_PRESENTATION
    uniform float neutralLighting;
    uniform float displayGain;
    uniform float displayContrast;
    uniform float displayContrastPivot;
  #endif
  in vec2 vTileUv;
  in vec3 vBaseWorldPosition;
  in vec3 vWorldPosition;
  in vec3 vBaseNormal;
  in float vElevationHeightWorld;
  in float vSkirt;
  out vec4 surfaceColour;

  vec3 outwardFaceNormal(vec3 baseNormal) {
    vec3 faceNormal = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
    return dot(faceNormal, baseNormal) < 0.0 ? -faceNormal : faceNormal;
  }

  vec3 smoothDisplacedNormal(vec3 baseNormal) {
    // Keep body curvature smooth, then perturb it only by the rendered height
    // field. Derivatives of the fully displaced position would flatten the
    // entire body to one lighting normal per geometry triangle.
    vec3 positionDx = dFdx(vBaseWorldPosition);
    vec3 positionDy = dFdy(vBaseWorldPosition);
    vec3 gradientAcrossX = cross(positionDy, baseNormal);
    vec3 gradientAcrossY = cross(baseNormal, positionDx);
    float determinant = dot(positionDx, gradientAcrossX);
    float tangentProduct = length(positionDx) * length(positionDy);
    if (
      tangentProduct == 0.0 ||
      abs(determinant) < tangentProduct * 1e-5
    ) return baseNormal;
    vec3 heightGradient = sign(determinant) * (
      dFdx(vElevationHeightWorld) * gradientAcrossX +
      dFdy(vElevationHeightWorld) * gradientAcrossY
    );
    vec3 reconstructed = abs(determinant) * baseNormal - heightGradient;
    float reconstructedLengthSquared = dot(reconstructed, reconstructed);
    return reconstructedLengthSquared > 0.0
      ? reconstructed * inversesqrt(reconstructedLengthSquared)
      : baseNormal;
  }

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
    #include <logdepthbuf_fragment>

    vec3 albedo = photographicImageryAllowed > 0.5
      ? resolvedImageryAlbedo()
      : texture(blueMarbleMap, vBlueMarbleUv).rgb;
    albedo = pow(max(albedo, vec3(0.0)), vec3(albedoToneExponent));
    if (surfaceOverlayVisible > 0.5 && vSkirt < 0.5) {
      vec2 overlayUv =
        vBlueMarbleUv * surfaceOverlayUvTransform.xy +
        surfaceOverlayUvTransform.zw;
      if (
        all(greaterThanEqual(overlayUv, vec2(0.0))) &&
        all(lessThanEqual(overlayUv, vec2(1.0)))
      ) {
        vec4 surfaceOverlay = texture(surfaceOverlayMap, overlayUv);
        albedo = mix(albedo, surfaceOverlay.rgb, surfaceOverlay.a);
      }
    }
    vec3 baseNormal = normalize(vBaseNormal);
    vec3 smoothNormal = smoothDisplacedNormal(baseNormal);
    vec3 lightingNormal = vSkirt > 0.0
      ? outwardFaceNormal(baseNormal)
      : smoothNormal;
    float direct = max(0.0, dot(lightingNormal, normalize(sunlight)));
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
    #ifdef SURFACE_DISPLAY_PRESENTATION
      colour = mix(colour, balanced, neutralLighting);
    #endif
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
    #ifdef SURFACE_DISPLAY_PRESENTATION
      // ShaderMaterial supplies this function but does not call it automatically.
      // Keep the reviewed gain/contrast curve independent of renderer tone mapping.
      surfaceColour = linearToOutputTexel(vec4(colour * displayGain, 1.0));
      vec3 encoded = clamp(surfaceColour.rgb, vec3(0.0), vec3(1.0));
      vec3 low = pow(encoded, vec3(displayContrast));
      vec3 high = pow(vec3(1.0) - encoded, vec3(displayContrast));
      float pivotOdds = pow(
        displayContrastPivot / (1.0 - displayContrastPivot),
        displayContrast - 1.0
      );
      surfaceColour.rgb = low / (low + high * pivotOdds);
    #else
      surfaceColour = vec4(colour, 1.0);
    #endif
  }
`;

/** Atomic terrain topology renderer with late-bound photographic imagery. */
export class TerrainSurface {
  readonly group = new THREE.Group();
  private loadingSuspended = false;
  private readonly provider: TerrainElevationProvider;
  private readonly surfaceModel: SurfaceModel;
  private readonly imagery: ImageryVirtualTexture;
  private readonly scheduler: TileWorkerScheduler<ElevationTileResource>;
  private readonly meshes = new Map<string, SurfaceMesh>();
  private readonly elevationTextures = new ImageTexturePool<
    HTMLImageElement,
    THREE.Texture
  >();
  private readonly stagedElevations = new Map<string, HTMLImageElement>();
  private readonly elevationPixels = new WeakMap<HTMLImageElement, ImageData>();
  private readonly transientElevationPixels = new WeakMap<HTMLImageElement, ImageData>();
  private readonly transientPixelReleases = new WeakSet<HTMLImageElement>();
  private readonly elevationBoundsByImage = new WeakMap<HTMLImageElement,
    Map<string, { readonly minimum: number; readonly maximum: number }>>();
  private readonly elevationSamplingCanvas: HTMLCanvasElement;
  private readonly elevationSamplingContext: CanvasRenderingContext2D;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly terrainLod: NormalizedTerrainLodOptions;
  private readonly renderVisibility: TerrainRenderVisibility;
  private readonly polarVisibilityEntries: TerrainRenderVisibilityEntry[] = [];
  private readonly emptyTexture: THREE.DataTexture;
  private readonly sharedUniforms: Record<string, THREE.IUniform>;
  private readonly displayPresentationEnabled: boolean;
  private readonly unsubscribe: () => void;
  private snapshot: SchedulerSnapshot<TileLayoutTarget>;
  private currentTarget: TileLayoutTarget;
  private desiredZoom: number | undefined;
  private maximumMeshZoom = 0;
  private readonly horizonCulling = new TileHorizonCulling();
  private horizonView: TileHorizonView;
  private meshAngularMargin: number;
  private resourceCamera: THREE.Camera | undefined;
  private readonly resourceObserverPositions: THREE.Vector3[] = [];
  private readonly resourceTerrainWorldInverse = new THREE.Matrix4();
  private readonly resourceObserverPosition = new THREE.Vector3();
  private readonly resourceEyePositions: THREE.Vector3[] = [];
  private resourceObserverRadius = 0;
  private debugControls: TileDebugControls = createTileDebugControls();
  private latestView: TerrainSurfaceView;

  constructor(options: TerrainSurfaceOptions) {
    const albedoToneExponent = options.albedoToneExponent ?? 1;
    if (!Number.isFinite(albedoToneExponent) || albedoToneExponent <= 0) {
      throw new RangeError("Surface albedo tone exponent must be positive.");
    }
    const display = options.displayPresentation;
    if (display && (
      !Number.isFinite(display.gain) || display.gain < 0 ||
      !Number.isFinite(display.contrast) || display.contrast <= 0 ||
      !Number.isFinite(display.contrastPivot) ||
      display.contrastPivot <= 0 || display.contrastPivot >= 1
    )) {
      throw new RangeError("Surface display presentation requires a nonnegative gain, positive contrast, and pivot between 0 and 1.");
    }
    this.displayPresentationEnabled = display !== undefined;
    this.renderer = options.renderer;
    this.surfaceModel = options.surfaceModel ?? EARTH_SURFACE_MODEL;
    const initialView: TerrainSurfaceView = {
      ...options.initialView,
      projection: this.surfaceModel.projection,
    };
    this.terrainLod = normalizeTerrainLodOptions(
      this.surfaceModel.elevationMetadata,
      options.terrainLod,
    );
    this.meshAngularMargin = terrainMeshAngularMargin(this.surfaceModel, [], this.terrainLod);
    this.latestView = initialView;
    this.renderVisibility = new TerrainRenderVisibility(
      this.group,
      this.surfaceModel.elevationMetadata.elevationBoundsMetres,
      this.surfaceModel.visibilityGeometry,
    );
    this.renderVisibility.updateDisplacement(
      initialView.terrainMultiplier,
      initialView.displayRadiusM,
      Math.cos(this.meshAngularMargin),
    );
    this.horizonView = this.createHorizonView(initialView);
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

    const elevationProvider = options.elevationProvider ?? new FlatElevationTileProvider(
      this.surfaceModel.elevationMetadata.tilePixels,
    );
    this.imagery = new ImageryVirtualTexture(
      options.renderer,
      options.baseTexture,
      options.imageryProvider,
      initialView,
      this.horizonView,
      options.workers,
    );
    this.provider = elevationProvider;
    this.currentTarget = terrainTargetForView(
      initialView,
      this.provider.tilePixels,
      {
        targetScreenPixelsPerSourcePixel:
          this.debugControls.terrain.screenPixelsPerSourcePixel,
        maxTopologyZoom: this.debugControls.terrain.maxZoom,
        projection: this.surfaceModel.projection,
      },
    );
    this.desiredZoom = this.currentTarget.maxZoom;
    this.scheduler = new TileWorkerScheduler(this.currentTarget, {
      createWorker: options.workers ? () => options.workers!("terrain-scheduler", new URL("./tile-scheduler.worker.js", import.meta.url)) : undefined,
      provider: this.provider,
      refinementLimits: this.provider.coverage ? terrainRefinementLimits(
        this.provider.coverage, this.provider.tilePixels, this.terrainLod.segmentTiers,
        this.surfaceModel.minimumProjectedWorldSegments,
      ) : undefined,
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
      bodyLocalUnitsPerElevationMetre: {
        value:
          initialView.terrainMultiplier / this.surfaceModel.referenceRadiusM,
      },
      bodyLocalSkirtDepth: {
        value: SKIRT_DEPTH_WORLD_METRES / initialView.displayRadiusM,
      },
      tileOverlayVisible: { value: 0 },
      textureOverlayVisible: { value: 0 },
      surfaceOverlayMap: { value: this.emptyTexture },
      surfaceOverlayVisible: { value: 0 },
      surfaceOverlayUvTransform: {
        value: new THREE.Vector4(1, 1, 0, 0),
      },
      sunlight: { value: new THREE.Vector3(-0.38, 0.82, 0.42).normalize() },
      albedoToneExponent: { value: albedoToneExponent },
      neutralLighting: { value: display?.lighting === "neutral" ? 1 : 0 },
      displayGain: { value: display?.gain ?? 1 },
      displayContrast: { value: display?.contrast ?? 1 },
      displayContrastPivot: { value: display?.contrastPivot ?? 0.5 },
      heightEncodingKind: {
        value: this.surfaceModel.heightEncoding.kind === "terrarium" ? 0 : 1,
      },
      heightScaleM: {
        value: this.surfaceModel.heightEncoding.kind === "rg16"
          ? this.surfaceModel.heightEncoding.scaleM
          : 1,
      },
      heightOffsetM: {
        value: this.surfaceModel.heightEncoding.kind === "rg16"
          ? this.surfaceModel.heightEncoding.offsetM
          : 0,
      },
    };
    if (this.surfaceModel.hasPolarCaps) this.addPolarCaps();
    this.syncRenderVisibilityEntries();
    this.imagery.update(initialView, this.horizonView);
    this.unsubscribe = this.scheduler.subscribe((snapshot, event) => {
      const committedChanged =
        !event && !sameCut(this.snapshot.committedCut, snapshot.committedCut);
      this.snapshot = snapshot;
      this.refreshSurfaceBounds();
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
    view = { ...view, projection: this.surfaceModel.projection };
    this.latestView = view;
    this.sharedUniforms.bodyLocalUnitsPerElevationMetre!.value =
      view.terrainMultiplier / this.surfaceModel.referenceRadiusM;
    this.sharedUniforms.bodyLocalSkirtDepth!.value =
      SKIRT_DEPTH_WORLD_METRES / view.displayRadiusM;
    this.renderVisibility.updateDisplacement(
      view.terrainMultiplier,
      view.displayRadiusM,
      Math.cos(this.meshAngularMargin),
    );
    if (this.resourceCamera) this.captureObserverPositions(this.resourceCamera);
    this.horizonView = this.createHorizonView(view);
    if (this.loadingSuspended) return;
    this.imagery.update(view, this.horizonView, {
      recalculateTopology: this.debugControls.textures.recalculationEnabled,
    });
    this.applyHorizonCulling();
    if (!this.debugControls.terrain.recalculationEnabled) return;
    const target = terrainTargetForView(view, this.provider.tilePixels, {
      targetScreenPixelsPerSourcePixel:
        this.debugControls.terrain.screenPixelsPerSourcePixel,
      maxTopologyZoom: this.debugControls.terrain.maxZoom,
      projection: this.surfaceModel.projection,
      previousZoom: this.desiredZoom,
    });
    this.desiredZoom = target.maxZoom;
    if (this.scheduler.updateTarget(target)) {
      this.currentTarget = target;
    }
  }

  /** Returns the elevation currently rendered at a geographic point. */
  sampleElevationMetres(
    latitudeDegrees: number,
    longitudeDegrees: number,
  ): number {
    if (
      this.surfaceModel.projection === "web-mercator" &&
      Math.abs(latitudeDegrees) > WEB_MERCATOR_MAX_LATITUDE
    ) return 0;
    // A coarser target may still be transitioning from finer visible meshes.
    for (let zoom = this.maximumMeshZoom; zoom >= 0; zoom -= 1) {
      const width = 2 ** zoom;
      const projected = projectedTilePoint(
        latitudeDegrees,
        longitudeDegrees,
        zoom,
        this.surfaceModel.projection,
      );
      const x = wrapTileX(Math.floor(projected.x), zoom);
      const y = Math.max(
        0, Math.min(width - 1, Math.floor(projected.y)),
      );
      const entry = this.meshes.get(tileIdentityKey({ z: zoom, x, y }));
      if (!entry) continue;
      if (!entry.elevation) return 0;
      const localUv = imageryUvForGeographicPoint(
        this.surfaceModel.tileBounds(entry.tile),
        latitudeDegrees,
        longitudeDegrees,
        this.surfaceModel.projection,
      );
      const sourceUv = sourceUvForTilePoint(
        entry.elevation,
        localUv.u,
        1 - localUv.v,
      );
      const pixels = this.pixelsForElevation(entry.elevation.image);
      return sampleEncodedElevationMetres(
        pixels.data,
        pixels.width,
        pixels.height,
        sourceUv.u,
        sourceUv.v,
        this.surfaceModel.heightEncoding,
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

  getTileFailureTotal(): number {
    return this.imagery.failureTotal + this.provider.failureTotal;
  }

  setTileOverlayVisible(visible: boolean): void {
    this.sharedUniforms.tileOverlayVisible!.value = visible ? 1 : 0;
  }

  setTextureTileOverlayVisible(visible: boolean): void {
    this.sharedUniforms.textureOverlayVisible!.value = visible ? 1 : 0;
  }

  /** Composites a geographic RGBA texture directly onto the displaced terrain. */
  setSurfaceOverlay(
    texture: THREE.Texture | null,
    uvTransform = new THREE.Vector4(1, 1, 0, 0),
  ): void {
    this.sharedUniforms.surfaceOverlayMap!.value = texture ?? this.emptyTexture;
    this.sharedUniforms.surfaceOverlayUvTransform!.value.copy(uvTransform);
    this.sharedUniforms.surfaceOverlayVisible!.value = texture ? 1 : 0;
  }

  setSunlightDirection(directionWorld: THREE.Vector3): void {
    const sunlight = this.sharedUniforms.sunlight!.value as THREE.Vector3;
    sunlight.copy(directionWorld).normalize();
  }

  get hasCommittedSurface(): boolean {
    return this.snapshot.committedCut.length > 0;
  }

  get hasCompleteImagery(): boolean {
    return this.imagery.hasCompleteImagery;
  }

  get hasImageryFailure(): boolean {
    return this.imagery.hasFailure;
  }

  /** Advances bounded imagery publication while the camera remains still. */
  processFrame(): void {
    this.imagery.processFrame();
  }

  get renderCullingEnabled(): boolean {
    return this.renderVisibility.enabled;
  }

  get isLoadingSuspended(): boolean {
    return this.loadingSuspended;
  }

  /** Retains the current surface while preventing new terrain or imagery demand. */
  setLoadingSuspended(suspended: boolean): boolean {
    if (this.loadingSuspended === suspended) return this.loadingSuspended;
    this.loadingSuspended = suspended;
    this.scheduler.setSuspended(suspended);
    this.imagery.setLoadingSuspended(suspended);
    if (!suspended) this.update(this.latestView);
    return this.loadingSuspended;
  }

  updateRenderVisibility(camera: THREE.Camera): void {
    if (!this.group.visible) return;
    this.resourceCamera = camera;
    if (this.captureObserverPositions(camera)) {
      this.horizonView = this.createHorizonView(this.latestView);
      if (!this.loadingSuspended) {
        this.imagery.updateHorizonView(this.horizonView);
        this.applyHorizonCulling();
      }
    }
    this.renderVisibility.update(camera);
  }

  private captureObserverPositions(camera: THREE.Camera): boolean {
    this.group.updateWorldMatrix(true, false);
    this.resourceTerrainWorldInverse.copy(this.group.matrixWorld).invert();
    const eyes = camera instanceof THREE.ArrayCamera && camera.cameras.length > 0
      ? camera.cameras : [camera];
    const centre = this.resourceObserverPosition.set(0, 0, 0);
    this.resourceEyePositions.length = eyes.length;
    for (let index = 0; index < eyes.length; index += 1) {
      const position = this.resourceEyePositions[index] ??= new THREE.Vector3();
      position
        .setFromMatrixPosition(eyes[index]!.matrixWorld)
        .applyMatrix4(this.resourceTerrainWorldInverse);
      centre.add(position);
    }
    centre.multiplyScalar(1 / eyes.length);
    let radius = 0;
    for (const eye of this.resourceEyePositions) radius = Math.max(radius, centre.distanceTo(eye));
    const previous = this.resourceObserverPositions[0];
    const changed = !previous || !previous.equals(centre) || radius !== this.resourceObserverRadius;
    if (previous) previous.copy(centre);
    else this.resourceObserverPositions.push(centre.clone());
    this.resourceObserverRadius = radius;
    return changed;
  }

  private createHorizonView(view: TerrainSurfaceView): TileHorizonView {
    return {
      ...view,
      projection: this.surfaceModel.projection,
      surfaceGeometry: this.surfaceModel.visibilityGeometry,
      displacementBounds: surfaceDisplacementBounds(
        this.surfaceModel.visibilityGeometry,
        this.surfaceModel.elevationMetadata.elevationBoundsMetres,
        view.terrainMultiplier, view.displayRadiusM,
        Math.cos(this.meshAngularMargin),
      ),
      meshAngularMargin: this.meshAngularMargin,
      observerPositions: this.resourceObserverPositions.length > 0
        ? this.resourceObserverPositions : undefined,
      observerRadius: this.resourceObserverRadius,
    };
  }

  private refreshSurfaceBounds(): void {
    this.meshAngularMargin = terrainMeshAngularMargin(this.surfaceModel,
      plannerHorizonCandidates(this.snapshot.committedCut, this.snapshot.graph.groups),
      this.terrainLod,
    );
    const view = this.latestView;
    this.renderVisibility.updateDisplacement(
      view.terrainMultiplier, view.displayRadiusM, Math.cos(this.meshAngularMargin),
    );
    this.horizonView = this.createHorizonView(view);
    this.imagery.updateHorizonView(this.horizonView);
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
          acquisition_active: provider.acquisitionActive,
          processing_queued: provider.processingQueued,
          processing_active: provider.processingActive,
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
    this.maximumMeshZoom = 0;
    const retained = new Set(
      this.snapshot.committedCut.map((tile) => tileIdentityKey(tile)),
    );
    const obsolete = [...this.meshes].filter(([key]) => !retained.has(key));
    for (const tile of this.snapshot.committedCut) {
      this.maximumMeshZoom = Math.max(this.maximumMeshZoom, tile.z);
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
    this.refreshMissingElevationBounds();
    this.provider.retainSourceTiles(this.scheduler.workingSetTiles);
  }

  private refreshMissingElevationBounds(): void {
    const workingSet = new Set(this.scheduler.workingSetTiles.map(tileIdentityKey));
    for (const [key, entry] of this.meshes) {
      if (entry.elevation || entry.elevationResource) continue;
      this.renderVisibility.setElevationBounds(entry.visibilityEntry,
        workingSet.has(key) ? undefined : { minimum: 0, maximum: 0 });
    }
  }

  private setDebugControls(
    controls: TileDebugControls,
  ): TileDebugControlsReadback {
    if (
      tileTopologySelectionChanged(
        this.debugControls.terrain,
        controls.terrain,
      )
    ) this.desiredZoom = undefined;
    this.debugControls = controls;
    this.imagery.setDebugControls(controls.textures);
    this.update(this.latestView);
    return this.getTileDebugControls();
  }

  private createTileMesh(tile: TileIdentity): SurfaceMesh {
    const segments = terrainSegmentsForZoom(
      tile.z,
      this.terrainLod.segmentTiers,
      this.surfaceModel.minimumProjectedWorldSegments,
    );
    const bounds = this.surfaceModel.tileBounds(tile);
    const imageryBounds = imageryBoundsForGeographicBounds(
      bounds,
      this.surfaceModel.projection,
    );
    const geometry = terrainPatchGeometry(
      bounds,
      segments,
      segments,
      true,
      this.surfaceModel,
    );
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
      visibilityEntry: createTerrainRenderVisibilityEntry(mesh, true, this.surfaceModel.visibilityGeometry),
    };
  }

  private addPolarCaps(): void {
    for (const bounds of [
      { west: -180, east: 180, north: 90, south: WEB_MERCATOR_MAX_LATITUDE },
      { west: -180, east: 180, north: -WEB_MERCATOR_MAX_LATITUDE, south: -90 },
    ]) {
      const mesh = new THREE.Mesh(
        terrainPatchGeometry(bounds, 128, 8, false, this.surfaceModel),
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
        createTerrainRenderVisibilityEntry(mesh, false, this.surfaceModel.visibilityGeometry),
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
      defines: this.displayPresentationEnabled ? { SURFACE_DISPLAY_PRESENTATION: 1 } : {},
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
    const pixels = this.readElevationPixels(image);
    this.elevationPixels.set(image, pixels);
    return pixels;
  }

  private pixelsForElevationBounds(image: HTMLImageElement): ImageData {
    const persistent = this.elevationPixels.get(image);
    if (persistent) return persistent;
    const existing = this.transientElevationPixels.get(image);
    if (existing) return existing;
    const pixels = this.readElevationPixels(image);
    this.transientElevationPixels.set(image, pixels);
    if (!this.transientPixelReleases.has(image)) {
      this.transientPixelReleases.add(image);
      queueMicrotask(() => {
        this.transientElevationPixels.delete(image);
        this.transientPixelReleases.delete(image);
      });
    }
    return pixels;
  }

  private readElevationPixels(image: HTMLImageElement): ImageData {
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
    return pixels;
  }

  private boundsForElevation(elevation: ImageTileResource): { readonly minimum: number; readonly maximum: number } {
    let boundsByCrop = this.elevationBoundsByImage.get(elevation.image);
    if (!boundsByCrop) {
      boundsByCrop = new Map();
      this.elevationBoundsByImage.set(elevation.image, boundsByCrop);
    }
    const cropKey = [elevation.sourceScale, elevation.sourceOffsetX, elevation.sourceOffsetY].join("/");
    const existing = boundsByCrop.get(cropKey);
    if (existing) return existing;
    const pixels = this.pixelsForElevationBounds(elevation.image);
    const bounds = elevationBoundsForTile(pixels.data, pixels.width, pixels.height,
      elevation, this.surfaceModel.heightEncoding);
    boundsByCrop.set(cropKey, bounds);
    return bounds;
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
    if (entry.elevationResource === resource) {
      this.consumeStagedElevation(entry.tile);
      return;
    }
    this.releaseTexture(this.elevationTextures, entry.elevation?.image);
    entry.elevationResource = resource;
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
    const workingSet = this.scheduler.workingSetTiles.some((tile) => tileIdentityKey(tile) === tileIdentityKey(entry.tile));
    this.renderVisibility.setElevationBounds(entry.visibilityEntry,
      elevation ? this.boundsForElevation(elevation) : resource || !workingSet
        ? { minimum: 0, maximum: 0 } : undefined);
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
