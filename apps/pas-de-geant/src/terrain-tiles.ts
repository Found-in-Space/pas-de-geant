import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
  normalizedRadialOffsetForMetres,
} from "./planet-state.js";
import {
  IMAGERY_FRAGMENT_DECLARATIONS,
  ImageryVirtualTexture,
  imageryBoundsForGeographicBounds,
  normalizedMercatorYForLatitude,
} from "./imagery.js";
import { LocalTerrainRenderer } from "./local-terrain.js";
import type { ReliefDataset } from "./relief.js";

export { terrainHorizonDegrees } from "./terrain-horizon.js";

const GLOBAL_LONGITUDE_SEGMENTS = 256;
const GLOBAL_LATITUDE_SEGMENTS = 128;
const SKIRT_DEPTH_WORLD_M = 0.02;
const OCCLUDER_SEGMENTS = 96;
const OCCLUDER_MARGIN_SOURCE_M = 500;
const OCCLUDER_MARGIN_WORLD_M = 0.002;
const FALLBACK_MAX_ELEVATION_M = 8_849;
const LAND_AMBIENT_LIGHT = 0.46;
const LAND_DIRECT_LIGHT = 0.72;
const LAND_DARK_SHADOW_LIFT = 0.18;
const LAND_DARK_LUMINANCE = 0.12;
const LAND_BRIGHT_LUMINANCE = 0.5;
const LAND_DARK_TONE_LIFT = 0.16;
const LAND_LIT_TONE_FRACTION = 0.35;

const GLOBAL_GLOBE_BOUNDS = {
  west: -180,
  east: 180,
  north: 90,
  south: -90,
};

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

export function geometryForGlobalGlobe(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const heightUvs: number[] = [];
  const imageryUvs: number[] = [];
  const skirts: number[] = [];
  const indices: number[] = [];
  const rowLength = GLOBAL_LONGITUDE_SEGMENTS + 1;
  for (let row = 0; row <= GLOBAL_LATITUDE_SEGMENTS; row += 1) {
    const v = row / GLOBAL_LATITUDE_SEGMENTS;
    const latitude = THREE.MathUtils.lerp(90, -90, v);
    const imageryV = normalizedMercatorYForLatitude(latitude);
    for (let column = 0; column <= GLOBAL_LONGITUDE_SEGMENTS; column += 1) {
      const u = column / GLOBAL_LONGITUDE_SEGMENTS;
      const longitude = THREE.MathUtils.lerp(-180, 180, u);
      const vertex = geodeticVertex(latitude, longitude);
      positions.push(vertex.position.x, vertex.position.y, vertex.position.z);
      normals.push(vertex.normal.x, vertex.normal.y, vertex.normal.z);
      heightUvs.push(vertex.heightUv.x, vertex.heightUv.y);
      imageryUvs.push(u, imageryV);
      skirts.push(0);
    }
  }
  for (let row = 0; row < GLOBAL_LATITUDE_SEGMENTS; row += 1) {
    for (let column = 0; column < GLOBAL_LONGITUDE_SEGMENTS; column += 1) {
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
    "heightUv",
    new THREE.Float32BufferAttribute(heightUvs, 2),
  );
  geometry.setAttribute(
    "imageryUv",
    new THREE.Float32BufferAttribute(imageryUvs, 2),
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
  imagery: ImageryVirtualTexture,
  stencilAvailable: boolean,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
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
      ...imagery.materialUniforms(),
      normalizedRadialMetres: { value: 0 },
      heightOffsetM: { value: relief.metadata.offsetMetres },
      heightScaleM: { value: relief.metadata.scaleMetres },
      normalizedSkirtDepth: { value: 0 },
      sunlight: { value: new THREE.Vector3(-0.38, 0.82, 0.42).normalize() },
    },
    vertexShader: `
      in vec2 heightUv;
      in vec2 imageryUv;
      in float skirt;
      uniform sampler2D heightMap;
      uniform float normalizedRadialMetres;
      uniform float heightOffsetM;
      uniform float heightScaleM;
      uniform float normalizedSkirtDepth;
      out vec2 vBlueMarbleUv;
      out vec2 vImageryUv;
      out vec3 vWorldPosition;
      out vec3 vBaseNormal;
      void main() {
        vec2 packedHeight = texture(heightMap, heightUv).rg;
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
        vImageryUv = imageryUv;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      ${IMAGERY_FRAGMENT_DECLARATIONS}
      uniform vec3 sunlight;
      in vec3 vWorldPosition;
      in vec3 vBaseNormal;
      out vec4 terrainColour;
      void main() {
        vec3 albedo = resolvedImageryAlbedo();
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
        terrainColour = vec4(colour, 1.0);
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
  private readonly globalTerrain: THREE.Mesh<
    THREE.BufferGeometry,
    THREE.ShaderMaterial
  >;
  private readonly globalBaseBoundingRadius: number;

  constructor(
    relief: ReliefDataset,
    private readonly imagery: ImageryVirtualTexture,
    private readonly stencilAvailable = true,
  ) {
    this.relief = relief;
    this.localTerrain = new LocalTerrainRenderer(
      relief,
      imagery,
      stencilAvailable,
    );
    const geometry = geometryForGlobalGlobe();
    this.globalBaseBoundingRadius = geometry.boundingSphere?.radius ?? 0;
    this.globalTerrain = new THREE.Mesh(
      geometry,
      terrainMaterial(relief, imagery, stencilAvailable),
    );
    this.globalTerrain.name = "immutable-global-surface";
    this.globalTerrain.frustumCulled = false;
    this.globalTerrain.renderOrder = 0;
    this.group.add(this.occluder);
    this.group.add(this.globalTerrain);
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
    this.imagery.update({
      latitudeDegrees,
      longitudeDegrees,
      displayRadiusM,
      eyeHeightWorldM,
      focalLengthPixels,
    });
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
    const globalMaterial = this.globalTerrain.material;
    globalMaterial.uniforms.normalizedRadialMetres!.value =
      normalizedRadialMetres;
    globalMaterial.uniforms.normalizedSkirtDepth!.value = normalizedSkirtDepth;
    this.imagery.configureMaterial(
      globalMaterial,
      imageryBoundsForGeographicBounds(GLOBAL_GLOBE_BOUNDS),
    );
    if (this.globalTerrain.geometry.boundingSphere) {
      this.globalTerrain.geometry.boundingSphere.radius =
        this.globalBaseBoundingRadius + maximumNormalizedDisplacement;
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
    this.imagery.dispose();
    this.globalTerrain.geometry.dispose();
    this.globalTerrain.material.dispose();
    this.occluder.geometry.dispose();
    this.occluder.material.dispose();
  }
}
