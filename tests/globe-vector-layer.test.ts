import { describe, expect, it } from "vitest";
import { globeMercatorPosition } from "../apps/visualizer/src/globe-vector-layer.js";

function latitudeFromWorldY(worldY: number): number {
  const mercatorRadians = Math.PI * (1 - 2 * worldY);
  return (
    (Math.atan(Math.sinh(mercatorRadians)) * 180) /
    Math.PI
  );
}

describe("globe vector coordinates", () => {
  it("retains polar latitude outside the Web-Mercator tile range", () => {
    const [, worldY] = globeMercatorPosition([0, 89.9]);

    expect(worldY).toBeLessThan(0);
    expect(latitudeFromWorldY(worldY)).toBeCloseTo(89.9, 8);
  });

  it("keeps exact poles finite for the projection shader", () => {
    for (const latitude of [-90, 90]) {
      const [worldX, worldY] = globeMercatorPosition([37, latitude]);
      expect(Number.isFinite(worldX)).toBe(true);
      expect(Number.isFinite(worldY)).toBe(true);
      expect(latitudeFromWorldY(worldY)).toBeCloseTo(latitude, 5);
    }
  });

  it("rejects invalid geographic input instead of silently clamping it", () => {
    expect(() => globeMercatorPosition([0, 91])).toThrow(RangeError);
    expect(() => globeMercatorPosition([Number.NaN, 0])).toThrow(
      RangeError,
    );
  });
});
