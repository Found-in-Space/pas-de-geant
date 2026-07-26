import { describe, expect, it } from "vitest";
import { GLOBE_STYLE } from "../apps/visualizer/src/maplibre-renderer.js";

describe("MapLibre globe style", () => {
  it("uses a globe projection with a self-contained raster style", () => {
    expect(GLOBE_STYLE.projection).toEqual({ type: "globe" });
    expect(GLOBE_STYLE.sources).toMatchObject({
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      },
    });
    expect(GLOBE_STYLE.sprite).toBeUndefined();
    expect(GLOBE_STYLE.glyphs).toBeUndefined();
  });
});

