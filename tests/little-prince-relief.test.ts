import { describe, expect, it } from "vitest";
import {
  RELIEF_OFFSET_METRES,
  decodeReliefSample,
  packReliefSamples,
  reliefPixel,
  sampleRelief,
} from "../apps/little-prince/src/relief.js";

describe("Little Planet relief data", () => {
  it("decodes signed metre values", () => {
    expect(decodeReliefSample(0)).toBe(RELIEF_OFFSET_METRES);
    expect(decodeReliefSample(12000)).toBe(0);
    expect(decodeReliefSample(20849)).toBe(8849);
  });

  it("packs 16-bit relief into a universally supported two-channel texture", () => {
    expect([...packReliefSamples(new Uint16Array([0, 0x1234, 0xffff]))])
      .toEqual([0, 0, 0x34, 0x12, 0xff, 0xff]);
  });

  it("wraps longitude and clamps latitude", () => {
    expect(reliefPixel(180, 90, 4, 2)).toEqual({ x: 0, y: 0 });
    expect(reliefPixel(-180, -90, 4, 2)).toEqual({ x: 0, y: 1 });
    expect(reliefPixel(540, 120, 4, 2)).toEqual({ x: 0, y: 0 });
  });

  it("bilinearly samples through the antimeridian", () => {
    const zero = 12000;
    const samples = new Uint16Array([
      zero,
      zero + 100,
      zero + 200,
      zero + 300,
      zero,
      zero + 100,
      zero + 200,
      zero + 300,
    ]);
    expect(sampleRelief(samples, -180, 90, 4, 2)).toBeCloseTo(0);
    expect(sampleRelief(samples, 179.9, 90, 4, 2)).toBeLessThan(1);
  });
});
