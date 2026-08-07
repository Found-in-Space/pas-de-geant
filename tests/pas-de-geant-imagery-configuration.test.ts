import { describe, expect, it } from "vitest";
import {
  mapTilerImageryVariantUrl,
  selectedMapTilerImageryVariant,
  selectImageryVariant,
  supportsMapTilerImageryVariants,
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

describe("imagery A/B configuration", () => {
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
    expect(supportsMapTilerImageryVariants(configuredMapTiler)).toBe(true);
    expect(decodeURIComponent(selectedUrl.pathname)).toBe(
      "/maps/satellite-v4/256/{z}/{x}/{y}.jpg",
    );
    expect(selectedUrl.search).toBe(
      new URL(configuredMapTiler.urlTemplate).search,
    );
  });

  it("leaves the configured provider intact for A, unknown values, and unrelated XYZ sources", () => {
    expect(selectImageryVariant(configuredMapTiler, "maptiler-512"))
      .toBe(configuredMapTiler);
    expect(selectImageryVariant(configuredMapTiler, "future-experiment"))
      .toBe(configuredMapTiler);

    const unrelated = {
      ...configuredMapTiler,
      urlTemplate: "https://imagery.example/{z}/{x}/{y}.jpg?key=test-key",
    };
    expect(selectImageryVariant(unrelated, "maptiler-256")).toBe(unrelated);
    expect(supportsMapTilerImageryVariants(unrelated)).toBe(false);
  });

  it("builds clickable variants without discarding other launch options", () => {
    const currentUrl =
      "https://example.test/?benchmarkScale=120&imageryVariant=maptiler-512#launch";
    const targetUrl = new URL(
      mapTilerImageryVariantUrl(currentUrl, "maptiler-256"),
    );

    expect(targetUrl.searchParams.get("benchmarkScale")).toBe("120");
    expect(targetUrl.searchParams.get("imageryVariant")).toBe("maptiler-256");
    expect(targetUrl.hash).toBe("#launch");
    expect(selectedMapTilerImageryVariant(null)).toBe("maptiler-512");
    expect(selectedMapTilerImageryVariant("unexpected")).toBe("maptiler-512");
    expect(selectedMapTilerImageryVariant("maptiler-256")).toBe(
      "maptiler-256",
    );
  });
});
