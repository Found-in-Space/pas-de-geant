import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { inwardSurfaceRibbon } from "../apps/visualizer/src/surface-ribbon.js";
import {
  geodeticDisplayPosition,
  projectDirectionToWgs84Display,
  wgs84DisplayEquation,
} from "../apps/visualizer/src/earth-ellipsoid.js";

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
      expect(angle(ribbon.boundary[index]!, source[index]!)).toBeCloseTo(0, 12);
    }
  });

  it("places the entire stroke toward the region centre", () => {
    const centre = new Vector3(0, 0, 1);
    const ribbon = inwardSurfaceRibbon(boundaryAroundNorthPole(0.02), 0.005);

    expect(ribbon.insetRadians).toBeCloseTo(0.005, 10);
    for (let index = 0; index < ribbon.boundary.length; index += 1) {
      const outerRadius = angle(ribbon.boundary[index]!, centre);
      const innerRadius = angle(ribbon.inset[index]!, centre);
      expect(innerRadius).toBeLessThan(outerRadius);
      expect(outerRadius - innerRadius).toBeCloseTo(ribbon.insetRadians, 10);
    }
  });

  it("narrows automatically when the central-shadow region is tiny", () => {
    const ribbon = inwardSurfaceRibbon(boundaryAroundNorthPole(0.002), 0.005);

    expect(ribbon.insetRadians).toBeCloseTo(0.0005, 10);
  });

  it("preserves exact ellipsoid boundaries and projects only the inset", () => {
    const source = [
      geodeticDisplayPosition(1.12, -0.44),
      geodeticDisplayPosition(1.11, -0.4),
      geodeticDisplayPosition(1.09, -0.42),
      geodeticDisplayPosition(1.1, -0.46),
      geodeticDisplayPosition(1.12, -0.44),
    ];
    const ribbon = inwardSurfaceRibbon(
      source,
      0.0012,
      projectDirectionToWgs84Display,
    );
    const centre = source
      .slice(0, -1)
      .reduce(
        (sum, point) => sum.add(point.clone().normalize()),
        new Vector3(),
      )
      .normalize();

    expect(ribbon.boundary).toHaveLength(4);
    for (let index = 0; index < ribbon.boundary.length; index += 1) {
      expect(ribbon.boundary[index]!.distanceTo(source[index]!)).toBeCloseTo(
        0,
        12,
      );
      expect(wgs84DisplayEquation(ribbon.inset[index]!)).toBeCloseTo(1, 12);
      expect(
        angle(ribbon.inset[index]!.clone().normalize(), centre),
      ).toBeLessThan(
        angle(ribbon.boundary[index]!.clone().normalize(), centre),
      );
    }
  });
});
