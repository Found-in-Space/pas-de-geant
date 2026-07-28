import { Vector3 } from "three";

const DUPLICATE_POINT_DISTANCE_SQUARED = 1e-9;

/**
 * Three.js closes a Catmull–Rom curve itself. Physical surface rings, however,
 * also repeat their first point at the end for interchange. Remove that
 * duplicate—and any adjacent numerical duplicates—before asking Three.js to
 * close the curve, otherwise the zero-length join can fold into a visible loop.
 */
export function closedCurveControlPoints(points: Vector3[]): Vector3[] {
  const controlPoints: Vector3[] = [];
  for (const point of points) {
    if (
      controlPoints.length === 0 ||
      controlPoints.at(-1)!.distanceToSquared(point) >=
        DUPLICATE_POINT_DISTANCE_SQUARED
    ) {
      controlPoints.push(point);
    }
  }
  if (
    controlPoints.length > 1 &&
    controlPoints[0]!.distanceToSquared(controlPoints.at(-1)!) <
      DUPLICATE_POINT_DISTANCE_SQUARED
  ) {
    controlPoints.pop();
  }
  return controlPoints;
}
