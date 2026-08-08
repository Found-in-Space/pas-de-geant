import { describe, expect, it } from "vitest";
import {
  createTileDebugControls,
  parseTileMaxZoomArguments,
  parseTilePixelRatioArguments,
  parseTileRecalculationArguments,
  tileDebugControlsReadback,
  tileTopologySelectionChanged,
  withTileMaxZoom,
  withTilePixelRatio,
  withTileRecalculation,
} from "../apps/pas-de-geant/src/tile-debug-controls.js";

describe("tile debug controls", () => {
  it("starts with production density and topology controls only", () => {
    const controls = createTileDebugControls();

    expect(tileDebugControlsReadback(controls, 12, 15)).toEqual({
      terrain: {
        screen_pixels_per_source_pixel: 2,
        max_zoom: null,
        recalculation_enabled: true,
        effective_target_zoom: 12,
      },
      textures: {
        screen_pixels_per_source_pixel: 1,
        max_zoom: null,
        recalculation_enabled: true,
        effective_target_zoom: 15,
      },
    });
  });

  it("freezes and re-enables terrain and textures independently", () => {
    let controls = createTileDebugControls();
    controls = withTileRecalculation(
      controls,
      parseTileRecalculationArguments({ target: "terrain", enabled: false }),
    );
    expect(controls.terrain.recalculationEnabled).toBe(false);
    expect(controls.textures.recalculationEnabled).toBe(true);

    controls = withTileRecalculation(
      controls,
      parseTileRecalculationArguments({ target: "textures", enabled: false }),
    );
    controls = withTileRecalculation(
      controls,
      parseTileRecalculationArguments({ target: "terrain", enabled: true }),
    );
    expect(controls.terrain.recalculationEnabled).toBe(true);
    expect(controls.textures.recalculationEnabled).toBe(false);
  });

  it("updates only selected density and topology-cap targets", () => {
    let controls = createTileDebugControls();
    controls = withTilePixelRatio(
      controls,
      parseTilePixelRatioArguments({
        target: "textures",
        screen_pixels_per_source_pixel: 2,
      }),
    );
    controls = withTileMaxZoom(
      controls,
      parseTileMaxZoomArguments({
        target: "both",
        enabled: true,
        max_zoom: 9,
      }),
    );
    controls = withTileMaxZoom(
      controls,
      parseTileMaxZoomArguments({ target: "terrain", enabled: false }),
    );

    expect(controls.terrain).toMatchObject({
      screenPixelsPerSourcePixel: 2,
      maxZoom: null,
    });
    expect(controls.textures).toMatchObject({
      screenPixelsPerSourcePixel: 2,
      maxZoom: 9,
    });
  });

  it("rebases topology selection only for density and max-cap changes", () => {
    const initial = createTileDebugControls().textures;
    const frozen = withTileRecalculation(
      createTileDebugControls(),
      { target: "textures", enabled: false },
    ).textures;
    const capped = withTileMaxZoom(
      createTileDebugControls(),
      { target: "textures", value: 8 },
    ).textures;

    expect(tileTopologySelectionChanged(initial, frozen)).toBe(false);
    expect(tileTopologySelectionChanged(initial, capped)).toBe(true);
    expect(tileTopologySelectionChanged(capped, initial)).toBe(true);
  });

  it("rejects unsafe model-generated arguments", () => {
    expect(() => parseTilePixelRatioArguments({
      target: "terrain",
      screen_pixels_per_source_pixel: 0,
    })).toThrow("positive");
    expect(() => parseTilePixelRatioArguments({
      target: "terrain",
      screen_pixels_per_source_pixel: Number.POSITIVE_INFINITY,
    })).toThrow("finite");
    expect(() => parseTileMaxZoomArguments({
      target: "terrain",
      enabled: true,
      max_zoom: 1.5,
    })).toThrow("nonnegative integer");
    expect(() => parseTileRecalculationArguments({
      target: "textures",
      enabled: "false",
    })).toThrow("boolean");
  });
});
