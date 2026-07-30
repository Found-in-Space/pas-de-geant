import { describe, expect, it } from "vitest";
import { geometryForGlobalGlobe } from "../apps/pas-de-geant/src/terrain-tiles.js";

describe("Pas de Géant immutable global surface", () => {
  it("uses one fixed 256x128 WGS84 shell", () => {
    const geometry = geometryForGlobalGlobe();
    expect(geometry.getAttribute("position").count).toBe(257 * 129);
    expect(geometry.getAttribute("normal").count).toBe(257 * 129);
    expect(geometry.getAttribute("heightUv").count).toBe(257 * 129);
    expect(geometry.getAttribute("imageryUv").count).toBe(257 * 129);
    expect(geometry.getIndex()?.count).toBe(256 * 128 * 6);
    expect(geometry.boundingSphere?.radius).toBeGreaterThan(0.99);
    geometry.dispose();
  });
});
