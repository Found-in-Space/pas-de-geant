import * as THREE from "three";
import type { ElevationProviderMetadata } from "./image-tile-provider.js";
import {
  tileBounds,
  type TileBounds,
  type TileProjection,
} from "./tile-onion-core.js";
import type { TileIdentity } from "./tile-transition-planner.js";
import { celestialBody, type CelestialBodyDefinition } from "./solar-system.js";
import {
  createSurfaceVisibilityGeometry,
  type SurfaceVisibilityGeometry,
} from "./surface-visibility-geometry.js";

export type SurfaceModelId = string;
export type HeightEncoding =
  | { readonly kind: "terrarium" }
  | { readonly kind: "rg16"; readonly scaleM: number; readonly offsetM: number };

export interface SurfaceModel {
  readonly id: SurfaceModelId;
  readonly referenceRadiusM: number;
  readonly visibilityGeometry: SurfaceVisibilityGeometry;
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

/** Geometry comes from the body; grid and height encoding come from its admitted data source. */
export function createBodySurfaceModel(
  body: Pick<CelestialBodyDefinition, "id" | "referenceRadiusM" | "shape">,
  source: Partial<Pick<SurfaceModel,
    "projection" | "heightEncoding" | "elevationMetadata" |
    "minimumProjectedWorldSegments" | "hasPolarCaps" | "nightAmbient"
  >> = {},
): SurfaceModel {
  const projection = source.projection ?? "web-mercator";
  const shape = body.shape;
  return Object.freeze({
    id: body.id,
    referenceRadiusM: body.referenceRadiusM,
    visibilityGeometry: createSurfaceVisibilityGeometry(body),
    projection,
    minimumProjectedWorldSegments: source.minimumProjectedWorldSegments ?? 64,
    minimumNormalizedSurfaceRadius: shape.kind === "sphere"
      ? shape.radiusM / body.referenceRadiusM
      : shape.polarRadiusM / body.referenceRadiusM,
    heightEncoding: source.heightEncoding ?? { kind: "terrarium" },
    elevationMetadata: source.elevationMetadata ?? {
      tilePixels: 512, maxSourceZoom: 0, attribution: "Reference surface · no elevation source",
      elevationBoundsMetres: Object.freeze({ minimum: 0, maximum: 0 }),
    },
    hasPolarCaps: source.hasPolarCaps ?? projection === "web-mercator",
    nightAmbient: source.nightAmbient ?? new THREE.Color(0x010101),
    tileBounds: (tile: TileIdentity) => tileBounds(tile, projection),
    positionAndNormal(latitudeDegrees: number, longitudeDegrees: number) {
      const vertex = sphericalPositionAndNormal(latitudeDegrees, longitudeDegrees);
      if (shape.kind === "sphere") {
        vertex.position.multiplyScalar(shape.radiusM / body.referenceRadiusM);
      } else {
        const a = shape.equatorialRadiusM;
        const b = shape.polarRadiusM;
        const e2 = 1 - b * b / (a * a);
        const n = a / Math.sqrt(1 - e2 * vertex.normal.y ** 2);
        vertex.position.set(
          n * vertex.normal.x, n * (1 - e2) * vertex.normal.y, n * vertex.normal.z,
        ).multiplyScalar(1 / body.referenceRadiusM);
      }
      return vertex;
    },
    baseTextureUv: equirectangularUv,
  });
}

export const EARTH_SURFACE_MODEL: SurfaceModel = createBodySurfaceModel(celestialBody("earth"), {
  projection: "web-mercator",
  minimumProjectedWorldSegments: 16,
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
});

export const MOON_SURFACE_MODEL: SurfaceModel = createBodySurfaceModel(celestialBody("moon"), {
  projection: "web-mercator",
  minimumProjectedWorldSegments: 64,
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
  hasPolarCaps: true,
  nightAmbient: new THREE.Color(0x010101),
});

/** Explicit compatibility model for immutable format-1 geographic payloads. */
export const MOON_GEOGRAPHIC_SURFACE_MODEL: SurfaceModel = Object.freeze({
  ...MOON_SURFACE_MODEL,
  projection: "geographic",
  hasPolarCaps: false,
  tileBounds: (tile: TileIdentity) => tileBounds(tile, "geographic"),
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
