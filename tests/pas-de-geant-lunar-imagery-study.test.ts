import { describe, expect, it } from "vitest";
import {
  APOLLO_STUDY_SITES, apolloImageryVersions, lunarStudyTileBounds,
  lunarStudyToneTable, lunarStudyWmsUrl, lunarStudyBrightnessMatch, lunarStudyLinearLight, lunarStudyAreaBounds, LUNAR_STUDY_RADIUS_METRES,
} from "../apps/pas-de-geant/src/lunar-imagery-study.js";
import { lunarRegionalTiers, lunarRegionalUpstreamUrl } from "../apps/pas-de-geant/src/lunar-regional-imagery.js";
import { APOLLO_REGIONAL_IMAGERY } from "../apps/pas-de-geant/src/lunar-regional-imagery-metadata.js";

describe("lunar imagery comparison coordinates", () => {
  it("places each landing site inside the correct published square XYZ tile", () => {
    for (const site of APOLLO_STUDY_SITES) {
      const x = Math.floor((site.longitude + 180) / 360 * 256);
      const y = Math.floor((90 - site.latitude) / 180 * 256);
      const [west, south, east, north] = lunarStudyTileBounds(8, x, y);
      expect(site.longitude).toBeGreaterThanOrEqual(west);
      expect(site.longitude).toBeLessThan(east);
      expect(site.latitude).toBeGreaterThan(south);
      expect(site.latitude).toBeLessThanOrEqual(north);
      expect(east - west).toBe(360 / 256);
      expect(north - south).toBe(180 / 256);
    }
  });

  it("preserves west/south/east/north order and uses a lunar CRS in WMS 1.1.1", () => {
    const url = new URL(lunarStudyWmsUrl("luna_apollo_12_high_sun_nac_mosaic", [-24, -4, -23, -3]));
    expect(url.searchParams.get("BBOX")).toBe("-24,-4,-23,-3");
    expect(url.searchParams.get("SRS")).toBe("IAU2000:30100");
    expect(url.searchParams.get("VERSION")).toBe("1.1.1");
    expect(url.searchParams.get("TRANSPARENT")).toBe("TRUE");
    expect(url.searchParams.get("WIDTH")).toBe("512");
    expect(url.searchParams.get("HEIGHT")).toBe("256");
  });

  it("offers extra illumination versions only at the sites that publish them", () => {
    expect(apolloImageryVersions(11).map((version) => version.id)).toContain("moderate-sun");
    expect(apolloImageryVersions(12).map((version) => version.id)).not.toContain("moderate-sun");
    expect(apolloImageryVersions(15).map((version) => version.id)).toContain("roi-high-sun");
    expect(apolloImageryVersions(16).map((version) => version.id)).toContain("orthomosaic");
  });

  it("centres 50 km and 100 km areas on each site, accounting for lunar latitude", () => {
    const metresPerDegree = Math.PI * LUNAR_STUDY_RADIUS_METRES / 180;
    for (const site of APOLLO_STUDY_SITES) for (const kilometres of [50, 100]) {
      const [west, south, east, north] = lunarStudyAreaBounds(site, kilometres);
      expect((west + east) / 2).toBeCloseTo(site.longitude, 10);
      expect((north + south) / 2).toBeCloseTo(site.latitude, 10);
      expect((north - south) * metresPerDegree).toBeCloseTo(kilometres * 1000, 5);
      expect((east - west) * metresPerDegree * Math.cos(site.latitude * Math.PI / 180)).toBeCloseTo(kilometres * 1000, 5);
    }
  });
});

describe("terrain brightness matching", () => {
  const pixels = (values: number[]): number[] => values.flatMap((value) => [value, value, value, 255]);

  it("recovers a brightness change in linear light and tolerates a shadow outlier", () => {
    const result = lunarStudyBrightnessMatch(pixels([128, 128, 128, 128, 240]), pixels([90, 90, 90, 90, 30]), 1)!;
    expect(result.gain).toBeCloseTo(lunarStudyLinearLight(90 / 255) / lunarStudyLinearLight(128 / 255), 10);
    expect(lunarStudyToneTable(1, result.gain)[128]).toBe(90);
    expect(result.afterError).toBeLessThan(result.beforeError);
  });

  it("uses the same display curve for the base and candidate", () => {
    const result = lunarStudyBrightnessMatch(pixels([128]), pixels([90]), .55)!;
    const corrected = lunarStudyToneTable(.55, result.gain)[128]!;
    expect(corrected).toBe(lunarStudyToneTable(.55)[90]);
  });

  it("ignores transparent and clipped pixels, and reports absent usable overlap", () => {
    expect(lunarStudyBrightnessMatch([128, 128, 128, 0], pixels([90]), 1)).toBeUndefined();
    expect(lunarStudyBrightnessMatch(pixels([0, 255]), pixels([90, 90]), 1)).toBeUndefined();
  });

  it("allows a display offset to refine the match without changing neutral settings", () => {
    const neutral = lunarStudyToneTable(1);
    const brighter = lunarStudyToneTable(1, 1, 1, .01);
    const darker = lunarStudyToneTable(1, 1, 1, -.01);
    expect(brighter[90]).toBeGreaterThan(neutral[90]!);
    expect(darker[90]).toBeLessThan(neutral[90]!);
  });
});

describe("registered regional archive imagery", () => {
  it("addresses the archived Apollo 11 first overview and final native tile", () => {
    expect(lunarRegionalUpstreamUrl(0, 0, 0)).toContain("/TileGroup0/0-0-0.jpg");
    expect(lunarRegionalUpstreamUrl(8, 66, 205)).toContain("/TileGroup72/8-66-205.jpg");
    expect(lunarRegionalTiers().reduce((total, tier) => total + tier.columns * tier.rows, 0)).toBe(18519);
  });

  it("registers the regional rasters around all six lunar-module coordinates", () => {
    for (const site of APOLLO_STUDY_SITES) {
      const [west, south, east, north] = APOLLO_REGIONAL_IMAGERY[site.mission]!.bounds;
      expect(site.longitude).toBeGreaterThan(west!);
      expect(site.longitude).toBeLessThan(east!);
      expect(site.latitude).toBeGreaterThan(south!);
      expect(site.latitude).toBeLessThan(north!);
    }
  });

  it("rejects invalid archive tile coordinates rather than expanding the upstream request", () => {
    expect(lunarRegionalUpstreamUrl(-1, 0, 0)).toBeUndefined();
    expect(lunarRegionalUpstreamUrl(0, 1, 0)).toBeUndefined();
    expect(lunarRegionalUpstreamUrl(0, 0, .5)).toBeUndefined();
    expect(lunarRegionalUpstreamUrl(100, 0, 0)).toBeUndefined();
  });
});

describe("shared imagery display curve", () => {
  it("leaves stored pixels exactly unchanged at the neutral settings", () => {
    expect([...lunarStudyToneTable(1)]).toEqual(Array.from({ length: 256 }, (_, value) => value));
  });

  it("brightens midtones monotonically without lifting black or changing white", () => {
    const table = lunarStudyToneTable(0.55);
    expect(table[0]).toBe(0);
    expect(table[255]).toBe(255);
    expect(table[64]).toBeGreaterThan(64);
    for (let index = 1; index < table.length; index++) expect(table[index]).toBeGreaterThanOrEqual(table[index - 1]!);
  });
});
