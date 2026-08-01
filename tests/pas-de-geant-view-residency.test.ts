import { describe, expect, it } from "vitest";
import {
  classifyViewResidency,
  intersectEllipsoidRay,
  viewResidencySignature,
} from "../apps/pas-de-geant/src/view-residency.js";

describe("view-local tile residency", () => {
  const cut = Array.from({ length: 16 }, (_, x) => ({ z: 4, x, y: 8 }));

  it("expands demand toward an inclined surface footprint without retaining the globe", () => {
    const downward = classifyViewResidency(cut, {
      underfoot: { latitudeDegrees: 0, longitudeDegrees: 0 },
      footprint: [{ latitudeDegrees: 0, longitudeDegrees: 0 }],
    });
    const inclined = classifyViewResidency(cut, {
      underfoot: { latitudeDegrees: 0, longitudeDegrees: 0 },
      footprint: [{ latitudeDegrees: 0, longitudeDegrees: 65 }],
    });

    expect(inclined.hot.size).toBeGreaterThan(downward.hot.size);
    expect(inclined.warm.size).toBeLessThan(cut.length);
    expect(inclined.warm.has("4/0/8")).toBe(false);
  });

  it("does not let coarse distant leaves inflate a finest-tile guard band", () => {
    const mixedCut = [
      { z: 12, x: 2_048, y: 2_048 },
      { z: 2, x: 0, y: 2 },
      { z: 2, x: 3, y: 2 },
    ];
    const residency = classifyViewResidency(mixedCut, {
      underfoot: { latitudeDegrees: 0, longitudeDegrees: 0 },
      footprint: [{ latitudeDegrees: 0, longitudeDegrees: 0 }],
    });

    expect(residency.warm.has("12/2048/2048")).toBe(true);
    expect(residency.warm.has("2/0/2")).toBe(false);
    expect(residency.warm.has("2/3/2")).toBe(false);
  });

  it("hits the local WGS84 surface for a steep-down high-latitude ray", () => {
    const equatorialRadius = 6_378.137 / 6_371.0088;
    const polarRadius = 6_356.752314245 / 6_371.0088;
    const latitude = 51.52 * Math.PI / 180;
    const sineLatitude = Math.sin(latitude);
    const cosineLatitude = Math.cos(latitude);
    const eccentricitySquared =
      1 - polarRadius * polarRadius /
      (equatorialRadius * equatorialRadius);
    const primeVerticalRadius =
      equatorialRadius /
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
    expect(Math.hypot(
      result.x + surface.x,
      result.y + surface.y,
      result.z + surface.z,
    )).toBeGreaterThan(1);
  });

  it("maps a sky-facing ray to the local horizon in its surface azimuth", () => {
    const equatorialRadius = 6_378.137 / 6_371.0088;
    const polarRadius = 6_356.752314245 / 6_371.0088;
    const latitude = 51.52 * Math.PI / 180;
    const sineLatitude = Math.sin(latitude);
    const cosineLatitude = Math.cos(latitude);
    const eccentricitySquared =
      1 - polarRadius * polarRadius /
      (equatorialRadius * equatorialRadius);
    const primeVerticalRadius =
      equatorialRadius /
      Math.sqrt(1 - eccentricitySquared * sineLatitude * sineLatitude);
    const surface = {
      x: primeVerticalRadius * cosineLatitude,
      y: primeVerticalRadius * (1 - eccentricitySquared) * sineLatitude,
      z: 0,
    };
    const normal = { x: cosineLatitude, y: sineLatitude, z: 0 };
    const north = { x: -sineLatitude, y: cosineLatitude, z: 0 };
    const origin = {
      x: surface.x + normal.x * 0.00025,
      y: surface.y + normal.y * 0.00025,
      z: 0,
    };
    const result = { x: 0, y: 0, z: 0 };
    const direction = {
      x: normal.x * 0.8 + north.x * 0.6,
      y: normal.y * 0.8 + north.y * 0.6,
      z: 0,
    };

    expect(intersectEllipsoidRay(
      origin,
      direction,
      equatorialRadius,
      polarRadius,
      result,
    )).toBe(false);
    const scaledOrigin = {
      x: origin.x / equatorialRadius,
      y: origin.y / polarRadius,
      z: origin.z / equatorialRadius,
    };
    const scaledResult = {
      x: result.x / equatorialRadius,
      y: result.y / polarRadius,
      z: result.z / equatorialRadius,
    };
    expect(Math.hypot(
      scaledResult.x,
      scaledResult.y,
      scaledResult.z,
    )).toBeCloseTo(1, 12);
    expect(
      scaledOrigin.x * scaledResult.x +
      scaledOrigin.y * scaledResult.y +
      scaledOrigin.z * scaledResult.z,
    ).toBeCloseTo(1, 12);
    expect(Math.hypot(
      result.x - surface.x,
      result.y - surface.y,
      result.z - surface.z,
    )).toBeGreaterThan(0.01);
    expect(result.y).toBeGreaterThan(surface.y);
  });

  it("only changes its signature after crossing a half-tile sampling boundary", () => {
    const first = {
      underfoot: { latitudeDegrees: 0, longitudeDegrees: 0 },
      footprint: [{ latitudeDegrees: 0, longitudeDegrees: 10 }],
    };
    const nearby = {
      ...first,
      footprint: [{ latitudeDegrees: 0, longitudeDegrees: 10.1 }],
    };
    const moved = {
      ...first,
      footprint: [{ latitudeDegrees: 0, longitudeDegrees: 20 }],
    };

    expect(viewResidencySignature(4, nearby)).toBe(
      viewResidencySignature(4, first),
    );
    expect(viewResidencySignature(4, moved)).not.toBe(
      viewResidencySignature(4, first),
    );
  });
});
