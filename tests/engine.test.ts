import { describe, expect, it } from "vitest";
import {
  EclipseCapabilityError,
  EclipseEngine,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";

const engine = new EclipseEngine(
  astronomyEngineCapabilities(new AstronomyEngineProvider()),
);

describe("engine validation", () => {
  it("discovers and physically classifies events on demand", () => {
    expect(engine.eventsForYear(2026).map((event) => event.id)).toEqual([
      "solar-2026-02-17-annular",
      "solar-2026-08-12-total",
    ]);

    const hybrid = engine
      .eventsForYear(2023)
      .find((event) => event.peakUtc.startsWith("2023-04-20"));
    expect(hybrid).toMatchObject({
      id: "solar-2023-04-20-hybrid",
      kind: "hybrid",
    });

    expect(
      engine.events({
        startUtc: "2025-03-01T00:00:00Z",
        endUtc: "2025-04-01T00:00:00Z",
      }),
    ).toEqual([
      expect.objectContaining({
        id: "solar-2025-03-29-partial",
        kind: "partial",
      }),
    ]);
  });

  it("validates search inputs without imposing demo year bounds", () => {
    expect(() => engine.eventsForYear(2026.5)).toThrow(/integer/);
    expect(() =>
      engine.events({
        startUtc: "invalid",
        endUtc: "2027-01-01T00:00:00Z",
      }),
    ).toThrow(/increasing UTC bounds/);
    expect(() =>
      engine.events({
        startUtc: "2027-01-01T00:00:00Z",
        endUtc: "2026-01-01T00:00:00Z",
      }),
    ).toThrow(/increasing UTC bounds/);

    let searched = false;
    const provider = new AstronomyEngineProvider();
    const providerNeutral = new EclipseEngine({
      ephemeris: provider,
      eclipseSearch: {
        searchGlobalEclipses: () => {
          searched = true;
          return [];
        },
      },
    });
    expect(
      providerNeutral.events({
        startUtc: "0999-01-01T00:00:00Z",
        endUtc: "1000-01-01T00:00:00Z",
      }),
    ).toEqual([]);
    expect(searched).toBe(true);
  });

  it("rejects invalid coordinates and oversized local windows", () => {
    expect(() =>
      engine.localEclipses(
        { latitudeDeg: 91, longitudeDeg: 0 },
        {
          startUtc: "2000-01-01T00:00:00Z",
          endUtc: "2001-01-01T00:00:00Z",
        },
      ),
    ).toThrow(/Latitude/);
    expect(() =>
      engine.localEclipses(
        { latitudeDeg: 0, longitudeDeg: 0 },
        {
          startUtc: "1800-01-01T00:00:00Z",
          endUtc: "2101-01-01T00:00:00Z",
        },
      ),
    ).toThrow(/200 years/);
  });

  it("reports optional capability failures with a typed error", () => {
    const geometryOnly = new EclipseEngine({
      ephemeris: new AstronomyEngineProvider(),
    });
    expect(() => geometryOnly.eventsForYear(2026)).toThrow(
      EclipseCapabilityError,
    );
    expect(() =>
      geometryOnly.events({
        startUtc: "2026-01-01T00:00:00Z",
        endUtc: "2027-01-01T00:00:00Z",
      }),
    ).toThrow(EclipseCapabilityError);
    expect(() =>
      geometryOnly.localEclipses(
        { latitudeDeg: 0, longitudeDeg: 0 },
        {
          startUtc: "2026-01-01T00:00:00Z",
          endUtc: "2027-01-01T00:00:00Z",
        },
      ),
    ).toThrow(EclipseCapabilityError);
  });
});
