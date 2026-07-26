import { describe, expect, it } from "vitest";
import { AstronomyEngineProvider } from "@found-in-space/shadowline-astronomy-engine";

const provider = new AstronomyEngineProvider();

describe("Astronomy Engine provider", () => {
  it("normalizes global eclipses and exposes frame-labelled vectors", () => {
    const events = provider.searchGlobalEclipses({
      startUtc: "2026-01-01T00:00:00Z",
      endUtc: "2027-01-01T00:00:00Z",
    });
    expect(events.map((event) => event.id)).toEqual([
      "solar-2026-02-17-annular",
      "solar-2026-08-12-total",
    ]);
    const moon = provider.stateVector(
      "moon",
      "2026-08-12T17:45:46.794Z",
      "geocentric-earth-fixed",
    );
    expect(moon.frame).toBe("geocentric-earth-fixed");
    expect(Math.hypot(moon.positionAu.x, moon.positionAu.y, moon.positionAu.z)).toBeGreaterThan(
      0.002,
    );
  });

  it("calculates bounded local circumstances", () => {
    const events = provider.searchLocalEclipses(
      { latitudeDeg: 41.8167, longitudeDeg: -3.185, elevationMeters: 0 },
      {
        startUtc: "2026-08-11T00:00:00Z",
        endUtc: "2026-08-14T00:00:00Z",
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("total");
    expect(events[0]!.centralBegin).toBeDefined();
    expect(events[0]!.centralEnd).toBeDefined();
  });
});
