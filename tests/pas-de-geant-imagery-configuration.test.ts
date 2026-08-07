import { describe, expect, it } from "vitest";
import {
  selectedMapTilerImageryVariant,
  selectImageryVariant,
} from "../apps/pas-de-geant/src/imagery-variants.js";
import type { XyzImageryConfiguration } from "../apps/pas-de-geant/src/imagery-provider.js";

const configuredMapTiler: XyzImageryConfiguration = {
  id: "maptiler-satellite-v2",
  urlTemplate:
    "https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}?key=test-key&cache=test",
  attribution: "MapTiler attribution",
  tileSize: 512,
  minZoom: 0,
  maxZoom: 22,
};

describe("imagery tile-size configuration", () => {
  it("derives the 256 px MapTiler variant without losing credentials or coverage", () => {
    const selected = selectImageryVariant(
      configuredMapTiler,
      "maptiler-256",
    );
    const selectedUrl = new URL(selected.urlTemplate);

    expect(selected).toMatchObject({
      attribution: configuredMapTiler.attribution,
      tileSize: 256,
      minZoom: configuredMapTiler.minZoom,
      maxZoom: configuredMapTiler.maxZoom,
    });
    expect(selected.id).not.toBe(configuredMapTiler.id);
    expect(decodeURIComponent(selectedUrl.pathname)).toBe(
      "/maps/satellite-v4/256/{z}/{x}/{y}.jpg",
    );
    expect(selectedUrl.search).toBe(
      new URL(configuredMapTiler.urlTemplate).search,
    );
  });

  it("keeps 512 as an explicit override and leaves unrelated sources intact", () => {
    expect(selectImageryVariant(configuredMapTiler, "maptiler-512"))
      .toBe(configuredMapTiler);

    const unrelated = {
      ...configuredMapTiler,
      urlTemplate: "https://imagery.example/{z}/{x}/{y}.jpg?key=test-key",
    };
    expect(selectImageryVariant(unrelated, "maptiler-256")).toBe(unrelated);
    expect(selectImageryVariant(unrelated, null)).toBe(unrelated);
  });

  it("defaults missing and unknown selections to 256 px", () => {
    expect(selectedMapTilerImageryVariant(null)).toBe("maptiler-256");
    expect(selectedMapTilerImageryVariant("unexpected")).toBe(
      "maptiler-256",
    );
    expect(selectImageryVariant(configuredMapTiler, null).tileSize).toBe(256);
  });
});
