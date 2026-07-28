import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  closedCurveControlPoints,
} from "../apps/visualizer/src/closed-curve.js";

describe("closed 3D boundary preparation", () => {
  it("removes the repeated interchange endpoint before render closure", () => {
    const first = new Vector3(1, 0, 0);
    const points = closedCurveControlPoints([
      first,
      new Vector3(0, 1, 0),
      new Vector3(0, 0, 1),
      first.clone(),
    ]);

    expect(points).toHaveLength(3);
    expect(points[0]).toBe(first);
    expect(points.at(-1)!.distanceToSquared(first)).toBeGreaterThan(1e-9);
  });

  it("removes adjacent numerical duplicates without deleting real vertices", () => {
    const points = closedCurveControlPoints([
      new Vector3(1, 0, 0),
      new Vector3(1 + 1e-6, 0, 0),
      new Vector3(0, 1, 0),
      new Vector3(0, 0, 1),
      new Vector3(1 + 1e-6, 0, 0),
    ]);

    expect(points).toHaveLength(3);
    expect(points[1]).toEqual(new Vector3(0, 1, 0));
    expect(points[2]).toEqual(new Vector3(0, 0, 1));
  });
});
