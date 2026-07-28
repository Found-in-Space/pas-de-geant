import { beforeAll, describe, expect, it } from "vitest";
import {
  EclipseEngine,
  chordDistanceKm,
  ellipsoidResidualKm,
  haversineDistanceKm,
  toGeoJson,
  toIsoUtc,
  type EclipseScene,
  type EclipseSummary,
  type GlobalVisibilityResult,
  type Position,
  type SurfacePoint,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";
import {
  envelopeResidualKm,
  shadowMarginAtSurfaceKm,
  shadowSurfaceState,
  solarLimbMarginAtSurfaceKm,
} from "../packages/shadowline/src/shadow-math.js";

const provider = new AstronomyEngineProvider();
const engine = new EclipseEngine(astronomyEngineCapabilities(provider));

function eventOn(date: string): EclipseSummary {
  return provider.searchGlobalEclipses({
    startUtc: `${date}T00:00:00Z`,
    endUtc: `${date}T23:59:59Z`,
  })[0]!;
}

function position(point: SurfacePoint): Position {
  return [
    point.geographic.longitudeDeg,
    point.geographic.latitudeDeg,
  ];
}

function sceneFor(
  event: EclipseSummary,
  result: GlobalVisibilityResult,
): EclipseScene {
  return {
    event,
    provider: provider.metadata,
    centralPath: null,
    globalVisibility: result.surface,
    instantaneousShadows: [],
    contacts: result.contacts,
    timeMarkers: [],
  };
}

describe("global penumbral circumstances", () => {
  let eclipse1973: GlobalVisibilityResult;
  let eclipse2026: GlobalVisibilityResult;
  let eclipse2027: GlobalVisibilityResult;

  beforeAll(
    () => {
      eclipse1973 = engine.calculateGlobalVisibility(
        eventOn("1973-06-30"),
      );
      eclipse2026 = engine.calculateGlobalVisibility(
        eventOn("2026-08-12"),
      );
      eclipse2027 = engine.calculateGlobalVisibility(
        eventOn("2027-02-06"),
      );
    },
    30_000,
  );

  it("reproduces the four published 1973 contacts", () => {
    // Reference values derived from Fred Espenak's NASA GSFC Besselian data:
    // https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm1951/SE1973Jun30Tbeselm.html
    const expected = [
      ["P1", "1973-06-30T09:00:41.700Z", [-46.8083, 5.865] as Position],
      ["P2", "1973-06-30T10:50:19.900Z", [-71.5733, -0.2883] as Position],
      ["P3", "1973-06-30T12:25:31.300Z", [76.7583, -17.49] as Position],
      ["P4", "1973-06-30T14:15:12.300Z", [52.1517, -11.3683] as Position],
    ] as const;
    expect(eclipse1973.contacts.map((contact) => contact.kind)).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
    ]);
    for (let index = 0; index < expected.length; index += 1) {
      const [kind, utc, expectedPoint] = expected[index]!;
      const contact = eclipse1973.contacts[index]!;
      expect(contact.kind).toBe(kind);
      expect(
        Math.abs(Date.parse(contact.utc) - Date.parse(utc)) / 1000,
      ).toBeLessThan(10);
      expect(
        haversineDistanceKm(position(contact.point), expectedPoint),
      ).toBeLessThan(25);
    }
  });

  it("returns event topology as physical ECEF curves", () => {
    expect(eclipse1973.surface.extent).toHaveLength(2);
    expect(eclipse1973.surface.horizon).toHaveLength(2);
    expect(eclipse2026.surface.extent).toHaveLength(1);
    expect(eclipse2026.surface.horizon).toHaveLength(1);
    expect(eclipse2027.surface.extent).toHaveLength(2);
    expect(eclipse2027.surface.horizon).toHaveLength(2);
    expect(eclipse2026.surface.horizon[0]!.closed).toBe(true);
  });

  it("can calculate the global contacts without constructing the surface", () => {
    expect(
      engine.calculateGlobalContacts(eventOn("2026-08-12")),
    ).toEqual(eclipse2026.contacts);
  });

  it("keeps every curve sample exactly on WGS 84", () => {
    for (const result of [eclipse1973, eclipse2026, eclipse2027]) {
      const points = [
        ...result.surface.extent.flatMap((curve) => curve.points),
        ...result.surface.horizon.flatMap((curve) => curve.points),
        ...result.contacts.map((contact) => contact.point),
      ];
      expect(
        Math.max(
          ...points.map((point) =>
            Math.abs(ellipsoidResidualKm(point.ecefKm)),
          ),
        ),
      ).toBeLessThan(1e-3);
    }
  });

  it("satisfies cone, envelope, and solar-limb equations", () => {
    for (const curve of eclipse2026.surface.extent) {
      for (const point of curve.points.slice(1, -1)) {
        const timeMs = Date.parse(point.atUtc);
        const state = shadowSurfaceState(provider, point.atUtc);
        expect(
          Math.abs(
            shadowMarginAtSurfaceKm(state, point, "penumbra"),
          ),
        ).toBeLessThan(1e-3);
        expect(
          Math.abs(
            envelopeResidualKm(
              shadowSurfaceState(
                provider,
                toIsoUtc(timeMs - 15_000),
              ),
              shadowSurfaceState(
                provider,
                toIsoUtc(timeMs + 15_000),
              ),
              point,
              "penumbra",
            ),
          ),
        ).toBeLessThan(1e-3);
      }
    }
    for (const curve of eclipse2026.surface.horizon) {
      for (const point of curve.points) {
        const state = shadowSurfaceState(provider, point.atUtc);
        expect(
          Math.abs(solarLimbMarginAtSurfaceKm(state, point)),
        ).toBeLessThan(1e-3);
        expect(
          shadowMarginAtSurfaceKm(state, point, "penumbra"),
        ).toBeGreaterThanOrEqual(-1e-3);
      }
    }
  });

  it("is topologically independent of requested output interval", () => {
    const event = eventOn("2027-02-06");
    const coarse = engine.calculateGlobalVisibility(event, {
      sampleIntervalSeconds: 600,
      angularIntervalDegrees: 10,
    });
    const fine = engine.calculateGlobalVisibility(event, {
      sampleIntervalSeconds: 10,
      angularIntervalDegrees: 10,
    });
    expect(coarse.contacts.map((contact) => contact.kind)).toEqual(
      fine.contacts.map((contact) => contact.kind),
    );
    expect(coarse.surface.extent.length).toBe(fine.surface.extent.length);
    expect(coarse.surface.horizon.length).toBe(fine.surface.horizon.length);
    for (let index = 0; index < coarse.surface.extent.length; index += 1) {
      const finePoints = fine.surface.extent[index]!.points;
      const maximumNearest = Math.max(
        ...coarse.surface.extent[index]!.points.map((point) =>
          Math.min(
            ...finePoints.map((candidate) =>
              chordDistanceKm(point.ecefKm, candidate.ecefKm),
            ),
          ),
        ),
      );
      expect(maximumNearest).toBeLessThan(20);
    }
  }, 30_000);

  it("serializes every line with antimeridian-safe segments", () => {
    for (const [event, result] of [
      [eventOn("1973-06-30"), eclipse1973],
      [eventOn("2026-08-12"), eclipse2026],
      [eventOn("2027-02-06"), eclipse2027],
    ] as const) {
      const collection = toGeoJson(sceneFor(event, result));
      expect(collection.metadata.schemaVersion).toBe("2.0.0");
      for (const feature of collection.features) {
        const parts =
          feature.geometry.type === "LineString"
            ? [feature.geometry.coordinates]
            : feature.geometry.type === "MultiLineString"
              ? feature.geometry.coordinates
              : [];
        for (const part of parts) {
          for (let index = 1; index < part.length; index += 1) {
            expect(
              Math.abs(part[index]![0] - part[index - 1]![0]),
            ).toBeLessThanOrEqual(180);
          }
        }
      }
    }
  });

  it("supports a complete partial-only scene and outline", () => {
    const event = eventOn("2025-03-29");
    const scene = engine.calculateEvent(event, {
      centralPath: true,
      globalVisibility: true,
      instantaneousAtUtc: [event.peakUtc],
    });
    expect(scene.centralPath).toBeNull();
    expect(scene.contacts.map((contact) => contact.kind)).toEqual([
      "P1",
      "P4",
    ]);
    expect(scene.instantaneousShadows[0]!.central).toBeNull();
    expect(scene.instantaneousShadows[0]!.penumbra.rings).toHaveLength(1);
    expect(
      toGeoJson(scene).features.some(
        (feature) =>
          feature.properties.feature_type === "instantaneous_penumbra",
      ),
    ).toBe(true);
  });

  it("keeps contact and horizon endpoints physically shared", () => {
    for (let index = 0; index < eclipse2027.contacts.length; index += 1) {
      const contact = eclipse2027.contacts[index]!;
      const horizon = eclipse2027.surface.horizon[index < 2 ? 0 : 1]!;
      expect(
        Math.min(
          ...horizon.points.map((point) =>
            chordDistanceKm(point.ecefKm, contact.point.ecefKm),
          ),
        ),
      ).toBeLessThan(1e-6);
    }
  });
});
