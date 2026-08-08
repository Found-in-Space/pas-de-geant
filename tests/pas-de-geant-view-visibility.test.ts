import { describe, expect, it } from "vitest";
import {
  classifyVisibleTiles,
  intersectEllipsoidRay,
} from "../apps/pas-de-geant/src/view-visibility.js";

describe("current view tile visibility", () => {
  it("intersects only the current footprint without a neighboring guard", () => {
    const visible = classifyVisibleTiles([
      { z: 4, x: 8, y: 8 },
      { z: 4, x: 9, y: 8 },
      { z: 4, x: 7, y: 8 },
    ], {
      footprint: [{ latitudeDegrees: -5, longitudeDegrees: 11.25 }],
    });

    expect([...visible]).toEqual(["4/8/8"]);
  });

  it("uses a current segment footprint but never a predicted footprint", () => {
    const visible = classifyVisibleTiles([
      { z: 4, x: 8, y: 8 },
      { z: 4, x: 10, y: 8 },
      { z: 4, x: 12, y: 8 },
    ], {
      footprint: [
        { latitudeDegrees: -5, longitudeDegrees: 11.25 },
        { latitudeDegrees: -5, longitudeDegrees: 50 },
      ],
    });

    expect(visible).toContain("4/8/8");
    expect(visible).toContain("4/10/8");
    expect(visible).not.toContain("4/12/8");
  });

  it("handles a current footprint crossing the antimeridian", () => {
    const visible = classifyVisibleTiles([
      { z: 4, x: 15, y: 8 },
      { z: 4, x: 0, y: 8 },
      { z: 4, x: 1, y: 8 },
    ], {
      footprint: [
        { latitudeDegrees: -5, longitudeDegrees: 179 },
        { latitudeDegrees: -5, longitudeDegrees: -179 },
      ],
    });

    expect(visible).toContain("4/15/8");
    expect(visible).toContain("4/0/8");
    expect(visible).not.toContain("4/1/8");
  });

  it("excludes tiles inside a footprint AABB but outside its polygon", () => {
    const visible = classifyVisibleTiles([
      { z: 4, x: 9, y: 9 },
      { z: 4, x: 11, y: 11 },
    ], {
      footprint: [
        { latitudeDegrees: 0, longitudeDegrees: 0 },
        { latitudeDegrees: 0, longitudeDegrees: 90 },
        { latitudeDegrees: -66.51326044311186, longitudeDegrees: 0 },
      ],
    });

    expect(visible).toContain("4/9/9");
    expect(visible).not.toContain("4/11/11");
  });

  it("admits nothing for an empty or all-sky footprint", () => {
    const target = { x: 4, y: 5, z: 6 };
    expect(intersectEllipsoidRay(
      { x: 0, y: 0, z: 2 },
      { x: 0, y: 0, z: 1 },
      1,
      1,
      target,
    )).toBe(false);
    expect(target).toEqual({ x: 4, y: 5, z: 6 });
    expect(classifyVisibleTiles(
      [{ z: 0, x: 0, y: 0 }],
      { footprint: [] },
    )).toEqual(new Set());
  });

  it("hits the local WGS84 surface for a steep-down high-latitude ray", () => {
    const equatorialRadius = 6_378.137 / 6_371.0088;
    const polarRadius = 6_356.752314245 / 6_371.0088;
    const latitude = 51.52 * Math.PI / 180;
    const sineLatitude = Math.sin(latitude);
    const cosineLatitude = Math.cos(latitude);
    const eccentricitySquared =
      1 - polarRadius * polarRadius / (equatorialRadius * equatorialRadius);
    const primeVerticalRadius = equatorialRadius /
      Math.sqrt(1 - eccentricitySquared * sineLatitude * sineLatitude);
    const surface = {
      x: primeVerticalRadius * cosineLatitude,
      y: primeVerticalRadius * (1 - eccentricitySquared) * sineLatitude,
      z: 0,
    };
    const normal = { x: cosineLatitude, y: sineLatitude, z: 0 };
    const origin = {
      x: surface.x + normal.x * 0.00025,
      y: surface.y + normal.y * 0.00025,
      z: 0,
    };
    const result = { x: 0, y: 0, z: 0 };

    expect(intersectEllipsoidRay(
      origin,
      { x: -normal.x, y: -normal.y, z: 0 },
      equatorialRadius,
      polarRadius,
      result,
    )).toBe(true);
    expect(Math.hypot(
      result.x - surface.x,
      result.y - surface.y,
      result.z - surface.z,
    )).toBeLessThan(1e-9);
  });
});
