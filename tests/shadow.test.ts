import { beforeAll, describe, expect, it } from "vitest";
import {
  EclipseEngine,
  coneResidualKm,
  ellipsoidResidualKm,
  toGeoJson,
  type EclipseScene,
  type EclipseSummary,
  type InstantaneousShadowSurface,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";
import {
  shadowMarginAtSurfaceKm,
  shadowSolarLimbIntersections,
  shadowSurfaceState,
  solarLimbMarginAtSurfaceKm,
} from "../packages/shadowline/src/shadow-math.js";

const provider = new AstronomyEngineProvider();
const engine = new EclipseEngine(astronomyEngineCapabilities(provider));
let event: EclipseSummary;
let shadow: InstantaneousShadowSurface;

beforeAll(() => {
  event = provider.searchGlobalEclipses({
    startUtc: "2026-08-01T00:00:00Z",
    endUtc: "2026-09-01T00:00:00Z",
  })[0]!;
  const local = engine.localCircumstances(event, {
    latitudeDeg: 41.8167,
    longitudeDeg: -3.185,
  })!;
  shadow = engine.calculateInstantaneousShadow(event, local.peak.utc);
});

function sceneFor(
  eclipse: EclipseSummary,
  outline: InstantaneousShadowSurface,
): EclipseScene {
  return {
    event: eclipse,
    provider: provider.metadata,
    centralPath: null,
    globalVisibility: {
      datum: "WGS 84",
      calculationFrame: "geocentric-earth-fixed",
      extent: [],
      horizon: [],
    },
    instantaneousShadows: [outline],
    contacts: [],
    timeMarkers: [],
  };
}

describe("renderer-neutral instantaneous shadows", () => {
  it("returns physical umbra and penumbra regions", () => {
    expect(shadow.central?.kind).toBe("umbra");
    expect(shadow.penumbra.rings).toHaveLength(1);
    expect(shadow.central?.region.rings).toHaveLength(1);
    expect(shadow.penumbra.rings[0]!.points.length).toBeGreaterThan(60);
    expect(shadow.central!.region.rings[0]!.points.length).toBeGreaterThan(
      100,
    );
    expect(
      shadow.penumbra.rings[0]!.segments.map((segment) => segment.kind),
    ).toEqual(["cone", "solar-limb"]);
  });

  it("keeps every returned sample on WGS 84", () => {
    const points = [
      ...shadow.penumbra.rings.flatMap((ring) => ring.points),
      ...shadow.central!.region.rings.flatMap((ring) => ring.points),
    ];
    expect(
      Math.max(
        ...points.map((point) =>
          Math.abs(ellipsoidResidualKm(point.ecefKm)),
        ),
      ),
    ).toBeLessThan(1e-3);
  });

  it("serializes regions only at the adapter boundary", () => {
    const features = toGeoJson(sceneFor(event, shadow)).features;
    expect(
      features.map(
        (feature) => feature.properties.feature_type,
      ),
    ).toEqual(["instantaneous_penumbra", "instantaneous_umbra"]);
    expect(
      features.every((feature) =>
        ["Polygon", "MultiPolygon"].includes(feature.geometry.type),
      ),
    ).toBe(true);
  });

  it("solves grazing cone and WGS 84 horizon simultaneously", () => {
    const state = shadowSurfaceState(
      provider,
      "2026-08-12T17:00:30Z",
    );
    const intersections = shadowSolarLimbIntersections(
      state,
      "central",
      0.5,
    );
    expect(intersections).toHaveLength(2);
    for (const intersection of intersections) {
      expect(
        Math.abs(
          shadowMarginAtSurfaceKm(
            state,
            intersection.point,
            "central",
          ),
        ),
      ).toBeLessThan(1e-3);
      expect(
        Math.abs(
          solarLimbMarginAtSurfaceKm(state, intersection.point),
        ),
      ).toBeLessThan(1e-3);
    }
  });

  it("returns a partial-only penumbra with no central region", () => {
    const partial = provider
      .searchGlobalEclipses({
        startUtc: "2025-03-01T00:00:00Z",
        endUtc: "2025-04-01T00:00:00Z",
      })
      .find((candidate) => candidate.kind === "partial")!;
    const outline = engine.calculateInstantaneousShadow(
      partial,
      partial.peakUtc,
    );
    expect(outline.central).toBeNull();
    expect(outline.penumbra.rings).toHaveLength(1);
    expect(outline.penumbra.rings[0]!.closed).toBe(true);
  });

  it("validates caller-controlled output resolution", () => {
    expect(() =>
      engine.calculateInstantaneousShadow(event, shadow.atUtc, {
        angularIntervalDegrees: 0.1,
      }),
    ).toThrow(/angular interval/);
  });

  it("uses angular intervals only as maximum output spacing", () => {
    const coarseRequest = engine.calculateInstantaneousShadow(
      event,
      shadow.atUtc,
      { angularIntervalDegrees: 15 },
    );
    expect(coarseRequest.penumbra.rings.length).toBe(
      shadow.penumbra.rings.length,
    );
    expect(coarseRequest.penumbra.rings[0]!.points.length).toBe(
      shadow.penumbra.rings[0]!.points.length,
    );
    expect(coarseRequest.central?.kind).toBe(shadow.central?.kind);
  });
});
