import * as THREE from "three";
import type { ElevationProviderMetadata } from "./image-tile-provider.js";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
} from "./planet-state.js";
import {
  tileBounds,
  type TileBounds,
  type TileProjection,
} from "./tile-onion-core.js";
import type { TileIdentity } from "./tile-transition-planner.js";

export type SurfaceModelId = "earth" | "moon";
export type HeightEncoding =
  | { readonly kind: "terrarium" }
  | { readonly kind: "rg16"; readonly scaleM: number; readonly offsetM: number };

export interface SurfaceModel {
  readonly id: SurfaceModelId;
  readonly referenceRadiusM: number;
  readonly projection: TileProjection;
  /** Minimum mesh subdivisions across either full projected world axis. */
  readonly minimumProjectedWorldSegments: number;
  readonly minimumNormalizedSurfaceRadius: number;
  readonly heightEncoding: HeightEncoding;
  readonly elevationMetadata: ElevationProviderMetadata;
  readonly hasPolarCaps: boolean;
  readonly nightAmbient: THREE.Color;
  tileBounds(tile: TileIdentity): TileBounds;
  positionAndNormal(
    latitudeDegrees: number,
    longitudeDegrees: number,
  ): { position: THREE.Vector3; normal: THREE.Vector3 };
  baseTextureUv(
    latitudeDegrees: number,
    longitudeDegrees: number,
  ): { u: number; v: number };
}

function equirectangularUv(
  latitudeDegrees: number,
  longitudeDegrees: number,
): { u: number; v: number } {
  return {
    u: (longitudeDegrees + 180) / 360,
    v: (90 - latitudeDegrees) / 180,
  };
}

function sphericalPositionAndNormal(
  latitudeDegrees: number,
  longitudeDegrees: number,
): { position: THREE.Vector3; normal: THREE.Vector3 } {
  const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
  const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
  const normal = new THREE.Vector3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.sin(latitude),
    -Math.cos(latitude) * Math.sin(longitude),
  ).normalize();
  return { position: normal.clone(), normal };
}

export const EARTH_SURFACE_MODEL: SurfaceModel = Object.freeze({
  id: "earth",
  referenceRadiusM: EARTH_MEAN_RADIUS_KM * 1_000,
  projection: "web-mercator",
  minimumProjectedWorldSegments: 16,
  minimumNormalizedSurfaceRadius: WGS84_B_KM / EARTH_MEAN_RADIUS_KM,
  heightEncoding: Object.freeze({ kind: "terrarium" }),
  elevationMetadata: Object.freeze({
    tilePixels: 512,
    maxSourceZoom: 12,
    attribution: "Mapterhorn · Terrarium elevation tiles",
    elevationBoundsMetres: Object.freeze({
      minimum: -32_768,
      maximum: 32_767 + 255 / 256,
    }),
  }),
  hasPolarCaps: true,
  nightAmbient: new THREE.Color(0x07111a),
  tileBounds: (tile: TileIdentity) => tileBounds(tile, "web-mercator"),
  positionAndNormal(latitudeDegrees: number, longitudeDegrees: number) {
    const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
    const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
    const sineLatitude = Math.sin(latitude);
    const cosineLatitude = Math.cos(latitude);
    const eccentricitySquared =
      1 - (WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);
    const primeVerticalRadius = WGS84_A_KM /
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
  },
  baseTextureUv: equirectangularUv,
});

export const MOON_SURFACE_MODEL: SurfaceModel = Object.freeze({
  id: "moon",
  referenceRadiusM: 1_737_400,
  projection: "geographic",
  minimumProjectedWorldSegments: 64,
  minimumNormalizedSurfaceRadius: 1,
  heightEncoding: Object.freeze({
    kind: "rg16",
    scaleM: 0.5,
    offsetM: -10_000,
  }),
  elevationMetadata: Object.freeze({
    tilePixels: 512,
    maxSourceZoom: 5,
    attribution: "NASA LRO · LOLA global displacement",
    elevationBoundsMetres: Object.freeze({ minimum: -10_000, maximum: 22_767.5 }),
  }),
  hasPolarCaps: false,
  nightAmbient: new THREE.Color(0x010101),
  tileBounds: (tile: TileIdentity) => tileBounds(tile, "geographic"),
  positionAndNormal: sphericalPositionAndNormal,
  baseTextureUv: equirectangularUv,
});

export function decodeHeightMetres(
  encoding: HeightEncoding,
  red: number,
  green: number,
  blue: number,
): number {
  return encoding.kind === "terrarium"
    ? red * 256 + green + blue / 256 - 32_768
    : (red * 256 + green) * encoding.scaleM + encoding.offsetM;
}
