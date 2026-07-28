import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  inwardSurfaceRibbon,
} from "../apps/visualizer/src/surface-ribbon.js";

function boundaryAroundNorthPole(radiusRadians: number): Vector3[] {
  return [0, Math.PI / 2, Math.PI, Math.PI * 1.5, Math.PI * 2].map(
    (azimuth) =>
      new Vector3(
        Math.sin(radiusRadians) * Math.cos(azimuth),
        Math.sin(radiusRadians) * Math.sin(azimuth),
        Math.cos(radiusRadians),
      ),
  );
}

function angle(first: Vector3, second: Vector3): number {
  return Math.acos(Math.max(-1, Math.min(1, first.dot(second))));
}

describe("inward surface boundary ribbons", () => {
  it("keeps the outer edge on the exact physical boundary", () => {
    const source = boundaryAroundNorthPole(0.02);
    const ribbon = inwardSurfaceRibbon(source, 0.005);

    expect(ribbon.boundary).toHaveLength(4);
    for (let index = 0; index < ribbon.boundary.length; index += 1) {
      expect(angle(ribbon.boundary[index]!, source[index]!)).toBeCloseTo(
        0,
        12,
      );
    }
  });

  it("places the entire stroke toward the region centre", () => {
    const centre = new Vector3(0, 0, 1);
    const ribbon = inwardSurfaceRibbon(
      boundaryAroundNorthPole(0.02),
      0.005,
    );

    expect(ribbon.insetRadians).toBeCloseTo(0.005, 10);
    for (let index = 0; index < ribbon.boundary.length; index += 1) {
      const outerRadius = angle(ribbon.boundary[index]!, centre);
      const innerRadius = angle(ribbon.inset[index]!, centre);
      expect(innerRadius).toBeLessThan(outerRadius);
      expect(outerRadius - innerRadius).toBeCloseTo(
        ribbon.insetRadians,
        10,
      );
    }
  });

  it("narrows automatically when the central-shadow region is tiny", () => {
    const ribbon = inwardSurfaceRibbon(
      boundaryAroundNorthPole(0.002),
      0.005,
    );

    expect(ribbon.insetRadians).toBeCloseTo(0.0005, 10);
  });
});
