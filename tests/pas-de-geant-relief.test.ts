import { describe, expect, it } from "vitest";
import {
  decodeReliefSample,
  sampleRelief,
} from "../apps/pas-de-geant/src/relief.js";

describe("Pas de Géant relief regressions", () => {
  it("decodes signed elevations and samples continuously at the antimeridian", () => {
    const zero = 12_000;
    expect(decodeReliefSample(zero)).toBe(0);

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
