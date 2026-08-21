import { describe, expect, it } from "vitest";
import {
  calculateEclipseContactRange,
  calculateEclipseEvents,
  calculateEclipseFrame,
} from "../apps/pas-de-geant/src/eclipse-science.js";

describe("Shadowline eclipse worker science", () => {
  it("discovers and calculates the 2026 total eclipse at global peak", () => {
    const events = calculateEclipseEvents(
      "2026-08-12T00:00:00Z",
      "2026-08-13T00:00:00Z",
    );
    const event = events.find(({ id }) => id === "solar-2026-08-12-total");
    expect(event).toBeDefined();
    const contacts = calculateEclipseContactRange(event!);
    expect(Date.parse(contacts.startUtc)).toBeLessThan(Date.parse(event!.peakUtc));
    expect(Date.parse(contacts.endUtc)).toBeGreaterThan(Date.parse(event!.peakUtc));

    const frame = calculateEclipseFrame(event!, event!.peakUtc, 6);
    expect(frame.event.id).toBe(event!.id);
    expect(frame.centralKind).toBe("umbra");
    expect(frame.sunMoonDistanceKm).toBeGreaterThan(140_000_000);
    expect(frame.moonEarthDistanceKm).toBeGreaterThan(300_000);
    expect(frame.penumbraRings.length).toBeGreaterThan(0);
    expect(frame.centralRings.length).toBeGreaterThan(0);
    expect(frame.penumbraRadiusAtEarthPlaneKm).toBeGreaterThan(0);
    const basisX = frame.ecefToEquatorialJ2000.x;
    expect(Math.hypot(basisX.x, basisX.y, basisX.z)).toBeCloseTo(1, 8);
  }, 30_000);

  it("switches cleanly to a verified annular event and antumbral footprint", () => {
    const events = calculateEclipseEvents(
      "2027-01-01T00:00:00Z",
      "2028-01-01T00:00:00Z",
    );
    const event = events.find(({ kind }) => kind === "annular");
    expect(event?.id).toBe("solar-2027-02-06-annular");
    const frame = calculateEclipseFrame(event!, event!.peakUtc, 8);

    expect(frame.event.id).toBe("solar-2027-02-06-annular");
    expect(frame.centralKind).toBe("antumbra");
    expect(frame.umbraRadiusAtEarthPlaneKm).toBeLessThan(0);
    expect(frame.centralRings.length).toBeGreaterThan(0);
  }, 30_000);
});
