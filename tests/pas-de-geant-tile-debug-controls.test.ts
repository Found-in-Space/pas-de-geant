import { describe, expect, it } from "vitest";
import {
  createTileDebugControls,
  demandedPayloadTiles,
  eligiblePayloadTiles,
  parseTileDeltaZoomCapArguments,
  parseTileMaxZoomArguments,
  parseTilePixelRatioArguments,
  parseTileRecalculationArguments,
  parseTileViewDistanceArguments,
  parseTileViewOverheadArguments,
  tileTopologySelectionChanged,
  tileDebugControlsReadback,
  withTileDeltaZoomCap,
  withTileMaxZoom,
  withTilePixelRatio,
  withTileRecalculation,
  withTileViewDistance,
} from "../apps/pas-de-geant/src/tile-debug-controls.js";

describe("tile debug controls", () => {
  it("starts with the production density and residency behavior", () => {
    const controls = createTileDebugControls();

    expect(tileDebugControlsReadback(controls, 12, 15)).toEqual({
      terrain: {
        screen_pixels_per_source_pixel: 2,
        max_zoom: null,
        view_distance_enabled: true,
        delta_zoom_cap: null,
        recalculation_enabled: true,
        effective_target_zoom: 12,
      },
      textures: {
        screen_pixels_per_source_pixel: 1,
        max_zoom: null,
        view_distance_enabled: true,
        delta_zoom_cap: null,
        recalculation_enabled: true,
        effective_target_zoom: 15,
      },
      view_overhead_percent: 25,
    });
  });

  it("freezes and re-enables terrain and textures independently", () => {
    let controls = createTileDebugControls();
    controls = withTileRecalculation(
      controls,
      parseTileRecalculationArguments({
        target: "terrain",
        enabled: false,
      }),
    );
    expect(controls.terrain.recalculationEnabled).toBe(false);
    expect(controls.textures.recalculationEnabled).toBe(true);

    controls = withTileRecalculation(
      controls,
      parseTileRecalculationArguments({
        target: "textures",
        enabled: false,
      }),
    );
    controls = withTileRecalculation(
      controls,
      parseTileRecalculationArguments({
        target: "terrain",
        enabled: true,
      }),
    );
    expect(controls.terrain.recalculationEnabled).toBe(true);
    expect(controls.textures.recalculationEnabled).toBe(false);
  });

  it("updates only the explicitly selected pipelines and can clear caps", () => {
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
    controls = withTileViewDistance(
      controls,
      parseTileViewDistanceArguments({
        target: "terrain",
        enabled: false,
      }),
    );
    controls = withTileDeltaZoomCap(
      controls,
      parseTileDeltaZoomCapArguments({
        target: "textures",
        enabled: true,
        delta_zoom: 3,
      }),
    );

    expect(controls.terrain).toMatchObject({
      screenPixelsPerSourcePixel: 2,
      maxZoom: null,
      viewDistanceEnabled: false,
      deltaZoomCap: null,
    });
    expect(controls.textures).toMatchObject({
      screenPixelsPerSourcePixel: 2,
      maxZoom: 9,
      viewDistanceEnabled: true,
      deltaZoomCap: 3,
    });
  });

  it("rebases topology selection only for density and max-cap changes", () => {
    const initial = createTileDebugControls().textures;
    const residencyOnly = withTileViewDistance(
      createTileDebugControls(),
      { target: "textures", enabled: false },
    ).textures;
    const capped = withTileMaxZoom(
      createTileDebugControls(),
      { target: "textures", value: 8 },
    ).textures;

    expect(tileTopologySelectionChanged(initial, residencyOnly)).toBe(false);
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
    expect(() => parseTileDeltaZoomCapArguments({
      target: "textures",
      enabled: true,
      delta_zoom: -1,
    })).toThrow("nonnegative integer");
    expect(() => parseTileViewOverheadArguments({
      overhead_percent: -0.1,
    })).toThrow("nonnegative");
    expect(() => parseTileRecalculationArguments({
      target: "textures",
      enabled: "false",
    }))
      .toThrow("boolean");
  });

  it("keeps exactly z through z-N payload bands without changing topology", () => {
    const cut = [
      { z: 12, x: 1, y: 1 },
      { z: 11, x: 1, y: 1 },
      { z: 10, x: 1, y: 1 },
      { z: 9, x: 1, y: 1 },
      { z: 8, x: 1, y: 1 },
      { z: 13, x: 1, y: 1 },
    ];

    expect(eligiblePayloadTiles(cut, 12, 3).map(({ z }) => z)).toEqual([
      12,
      11,
      10,
      9,
    ]);
    expect(eligiblePayloadTiles(cut, 12, null)).toEqual(cut);
    expect(cut).toHaveLength(6);

    const emptyWarmSelection = new Set<string>();
    expect(demandedPayloadTiles(
      cut,
      12,
      3,
      false,
      emptyWarmSelection,
    ).map(({ z }) => z)).toEqual([12, 11, 10, 9]);
    expect(demandedPayloadTiles(
      cut,
      12,
      3,
      true,
      new Set(["12/1/1", "10/1/1"]),
    ).map(({ z }) => z)).toEqual([12, 10]);
  });
});
