import type { CelestialBodyDefinition } from "./solar-system.js";
import type { TileBounds } from "./tile-onion-core.js";

export interface ElevationBoundsMetres {
  readonly minimum: number;
  readonly maximum: number;
}

/** Converts body-local coordinates (physical metres / reference radius) to
 * a unit sphere. The same transform applies to vertices and observers. */
export interface SurfaceVisibilityGeometry {
  readonly referenceRadiusM: number;
  readonly xzScale: number;
  readonly yScale: number;
  readonly maximumScale: number;
  readonly latitudeRatio: number;
  readonly maximumLatitudeScale: number;
}

export interface BodyLocalObserver {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SurfaceDisplacementBounds {
  readonly innerRadius: number;
  readonly outerRadius: number;
  readonly angularMargin: number;
  readonly sphereExpansion: number;
}

export const TERRAIN_SKIRT_DEPTH_WORLD_METRES = 0.02;
// Bounds cover Float32 vertex/normal storage and displacement arithmetic.
const VERTEX_ROUNDING_MARGIN = 4 * 2 ** -23;

export function createSurfaceVisibilityGeometry(
  body: Pick<CelestialBodyDefinition, "referenceRadiusM" | "shape">,
): SurfaceVisibilityGeometry {
  const a = body.shape.kind === "sphere"
    ? body.shape.radiusM : body.shape.equatorialRadiusM;
  const b = body.shape.kind === "sphere"
    ? body.shape.radiusM : body.shape.polarRadiusM;
  const xzScale = body.referenceRadiusM / a;
  const yScale = body.referenceRadiusM / b;
  return Object.freeze({
    referenceRadiusM: body.referenceRadiusM,
    xzScale,
    yScale,
    maximumScale: Math.max(xzScale, yScale),
    latitudeRatio: b / a,
    maximumLatitudeScale: Math.max(b / a, a / b),
  });
}

/** Geodetic latitude mapped into the normalized ellipsoid's sphere. */
export function normalizedSurfaceLatitude(
  latitudeRadians: number,
  geometry: SurfaceVisibilityGeometry,
): number {
  return Math.atan2(
    geometry.latitudeRatio * Math.sin(latitudeRadians),
    Math.cos(latitudeRadians),
  );
}

/** Every triangle in a latitude/longitude mesh cell lies inside this cap.
 * Its plane stays at least cos(radius) from the normalized body's centre. */
export function meshCellAngularRadius(
  geometry: SurfaceVisibilityGeometry,
  bounds: TileBounds,
  columns: number,
  rows = columns,
): number {
  const latitudeStep = (bounds.north - bounds.south) * Math.PI / 180 / rows;
  const longitudeStep = (bounds.east - bounds.west) * Math.PI / 180 / columns;
  return Math.min(Math.PI, 0.5 * Math.hypot(
    latitudeStep * geometry.maximumLatitudeScale,
    longitudeStep,
  ));
}

/** Conservative shell enclosing both displaced and temporarily flat meshes.
 * An inner shell, rather than the reference surface, is the safe occluder. */
export function surfaceDisplacementBounds(
  geometry: SurfaceVisibilityGeometry,
  elevation: ElevationBoundsMetres | undefined,
  terrainMultiplier: number,
  displayRadiusM: number,
  minimumMeshRadius = 1,
): SurfaceDisplacementBounds | undefined {
  if (!elevation || !Number.isFinite(elevation.minimum) ||
    !Number.isFinite(elevation.maximum) || elevation.minimum > elevation.maximum ||
    !Number.isFinite(terrainMultiplier) || terrainMultiplier < 0 ||
    !Number.isFinite(displayRadiusM) || displayRadiusM <= 0) return undefined;
  const scale = terrainMultiplier / geometry.referenceRadiusM;
  const skirt = TERRAIN_SKIRT_DEPTH_WORLD_METRES / displayRadiusM;
  const inward = Math.max(0, -elevation.minimum) * scale + skirt;
  const outward = Math.max(0, elevation.maximum) * scale;
  const sphereExpansion =
    Math.max(Math.abs(elevation.minimum), Math.abs(elevation.maximum)) * scale + skirt;
  const perturbation = sphereExpansion * geometry.maximumScale + VERTEX_ROUNDING_MARGIN;
  const innerRadius = minimumMeshRadius - inward * geometry.maximumScale - VERTEX_ROUNDING_MARGIN;
  const outerRadius = 1 + outward * geometry.maximumScale + VERTEX_ROUNDING_MARGIN;
  if (!Number.isFinite(innerRadius) || innerRadius <= 0 ||
    !Number.isFinite(outerRadius) || perturbation >= minimumMeshRadius) return undefined;
  return {
    innerRadius,
    outerRadius,
    angularMargin: Math.asin(perturbation / minimumMeshRadius),
    sphereExpansion: sphereExpansion + VERTEX_ROUNDING_MARGIN / geometry.maximumScale,
  };
}

/** Largest angular separation compatible with an unobstructed line of sight.
 * Undefined means the observer or surface cannot safely be horizon-culled. */
export function surfaceVisibilityHorizonRadians(
  observerRadius: number,
  bounds: SurfaceDisplacementBounds | undefined,
  displaced = true,
): number | undefined {
  if (!bounds || !Number.isFinite(observerRadius) || observerRadius <= bounds.innerRadius) {
    return undefined;
  }
  return Math.min(Math.PI,
    Math.acos(bounds.innerRadius / observerRadius) +
    surfaceTargetHorizonRadians(bounds, displaced),
  );
}

/** Target half of the horizon, cached per mesh when elevation bounds change. */
export function surfaceTargetHorizonRadians(bounds: SurfaceDisplacementBounds, displaced = true): number {
  const outer = displaced ? bounds.outerRadius : 1 + VERTEX_ROUNDING_MARGIN;
  return Math.acos(Math.min(1, bounds.innerRadius / outer)) + (displaced ? bounds.angularMargin : 0);
}
