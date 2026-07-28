import { Vector3 } from "three";
import { closedCurveControlPoints } from "./closed-curve.js";

export interface InwardSurfaceRibbon {
  boundary: Vector3[];
  inset: Vector3[];
  insetRadians: number;
}

export type SurfaceProjection = (direction: Vector3) => Vector3;

function angleBetween(first: Vector3, second: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, first.dot(second))));
}

function moveToward(
  point: Vector3,
  centre: Vector3,
  distanceRadians: number,
): Vector3 {
  const angle = angleBetween(point, centre);
  if (angle < 1e-12) return point.clone();
  const fraction = Math.min(1, distanceRadians / angle);
  const sine = Math.sin(angle);
  if (Math.abs(sine) < 1e-12) {
    return point.clone().lerp(centre, fraction).normalize();
  }
  return point
    .clone()
    .multiplyScalar(Math.sin((1 - fraction) * angle) / sine)
    .addScaledVector(centre, Math.sin(fraction * angle) / sine)
    .normalize();
}

/**
 * Builds the two edges of a spherical ribbon whose outer edge is the supplied
 * physical boundary. The second edge moves toward the region centre, so no
 * part of the rendered stroke claims territory outside the central shadow.
 */
export function inwardSurfaceRibbon(
  points: Vector3[],
  maximumInsetRadians: number,
  projectToSurface: SurfaceProjection = (direction) =>
    direction.clone().normalize(),
): InwardSurfaceRibbon {
  if (!Number.isFinite(maximumInsetRadians) || maximumInsetRadians <= 0) {
    throw new RangeError("Surface-ribbon inset must be a positive angle.");
  }
  const boundary = closedCurveControlPoints(points).map((point) =>
    point.clone(),
  );
  if (boundary.length < 3) {
    return { boundary: [], inset: [], insetRadians: 0 };
  }
  const directions = boundary.map((point) => point.clone().normalize());
  const centre = directions
    .reduce((sum, point) => sum.add(point), new Vector3())
    .normalize();
  if (centre.lengthSq() < 1e-12) {
    throw new Error("Cannot inset a boundary without a spherical centre.");
  }
  const minimumRadiusRadians = Math.min(
    ...directions.map((point) => angleBetween(point, centre)),
  );
  const insetRadians = Math.min(
    maximumInsetRadians,
    minimumRadiusRadians * 0.25,
  );
  return {
    boundary,
    inset: directions.map((point) =>
      projectToSurface(moveToward(point, centre, insetRadians)),
    ),
    insetRadians,
  };
}
