import { afterEach, describe, expect, it, vi } from "vitest";
import { imageryConfiguration } from "../apps/pas-de-geant/src/imagery-configuration.js";
afterEach(() => vi.unstubAllGlobals());
import { assertDevelopmentTileSource, assertDevelopmentPublicTileSources } from "../apps/pas-de-geant/src/development-tile-policy.js";

describe("development MapTiler routing", () => {
  it("rejects injected development imagery before a tile loader can fetch it", () => {
    vi.stubGlobal("window", { __PAS_DE_GEANT_IMAGERY_CONFIG__: {
      urlTemplate: "https://api.maptiler.com/{z}/{x}/{y}", attribution: "MapTiler",
    } });
    expect(() => imageryConfiguration()).toThrow("disabled in development");
  });
  it("rejects direct MapTiler sources without including credentials in the error", () => {
    for (const template of ["https://api.maptiler.com/{z}/{x}/{y}?key=private-key", "https://tiles.maptiler.com/{z}/{x}/{y}"]) {
      try { assertDevelopmentTileSource(template, { development: true }); throw new Error("Direct source was admitted"); }
      catch (error) {
        expect(String(error)).toContain("Direct MapTiler requests are disabled");
        expect(String(error)).not.toContain("private-key");
      }
    }
  });
  it("admits cache routes and explicit production sources", () => {
    expect(() => assertDevelopmentTileSource("/api/tiles/textures/{z}/{x}/{y}", { development: true })).not.toThrow();
    expect(() => assertDevelopmentTileSource("https://api.maptiler.com/{z}/{x}/{y}", { development: false })).not.toThrow();
    expect(() => assertDevelopmentTileSource("https://api.maptiler.com/{z}/{x}/{y}", { development: true, allowDirectMapTiler: true })).not.toThrow();
  });
  it("checks public configuration while allowing server-only upstream credentials", () => {
    expect(() => assertDevelopmentPublicTileSources({ VITE_IMAGERY_XYZ_TEMPLATE: "https://api.maptiler.com/{z}/{x}/{y}" }, { development: true })).toThrow("disabled in development");
    expect(() => assertDevelopmentPublicTileSources({ PAS_DE_GEANT_TILE_PROXY_TEXTURES_UPSTREAM_TEMPLATE: "https://api.maptiler.com/{z}/{x}/{y}" }, { development: true })).not.toThrow();
  });
});
