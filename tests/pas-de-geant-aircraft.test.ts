import { describe, expect, it } from "vitest";
import {
  AIRCRAFT_EXTRAPOLATION_LIMIT_MS,
  extrapolateAircraft,
  parseAirplanesLive,
  type TrackedAircraft,
} from "../apps/pas-de-geant/src/aircraft-feed.js";
import { shouldPollAircraft } from "../apps/pas-de-geant/src/aircraft-lifecycle.js";

describe("Pas de Géant aircraft regressions", () => {
  it("does not poll outside a visible, opted-in VR session", () => {
    expect(
      shouldPollAircraft({
        enabled: true,
        vrSessionActive: true,
        documentVisible: true,
        requestActive: false,
      }),
    ).toBe(true);

    for (const blocked of [
      {
        enabled: false,
        vrSessionActive: true,
        documentVisible: true,
        requestActive: false,
      },
      {
        enabled: true,
        vrSessionActive: false,
        documentVisible: true,
        requestActive: false,
      },
      {
        enabled: true,
        vrSessionActive: true,
        documentVisible: false,
        requestActive: false,
      },
      {
        enabled: true,
        vrSessionActive: true,
        documentVisible: true,
        requestActive: true,
      },
    ]) {
      expect(shouldPollAircraft(blocked)).toBe(false);
    }
  });

  it("filters and normalizes the external aircraft payload", () => {
    expect(
      parseAirplanesLive(
        {
          ac: [
            {
              hex: "484abc",
              flight: " KLM123 ",
              lat: -33.86,
              lon: 151.2,
              alt_baro: 32_000,
              alt_geom: 33_000,
              gs: 430,
              track: 91,
              track_rate: 0.25,
              seen_pos: 1.5,
            },
            {
              hex: "ground1",
              lat: -33.87,
              lon: 151.21,
              alt_baro: "ground",
            },
            { hex: "nopos", alt_baro: 10_000 },
          ],
        },
        10_000,
      ),
    ).toEqual([
      {
        id: "484ABC",
        callsign: "KLM123",
        latitudeDegrees: -33.86,
        longitudeDegrees: 151.2,
        altitudeFt: 32_000,
        groundSpeedKt: 430,
        trackDegrees: 91,
        trackRateDegreesPerSecond: 0.25,
        sampledAtMs: 8_500,
      },
    ]);
  });

  it("dead-reckons reports but stops extrapolating stale data", () => {
    const aircraft: TrackedAircraft = {
      id: "TEST01",
      callsign: "TEST01",
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      altitudeFt: 10_000,
      groundSpeedKt: 360,
      trackDegrees: 90,
      trackRateDegreesPerSecond: 1,
      sampledAtMs: 0,
    };
    const moving = extrapolateAircraft(aircraft, 10_000);
    expect(moving.longitudeDegrees).toBeGreaterThan(0);
    expect(moving.latitudeDegrees).toBeLessThan(0);
    expect(moving.trackDegrees).toBeCloseTo(100);
    expect(extrapolateAircraft(aircraft, 60_000)).toEqual(
      extrapolateAircraft(aircraft, AIRCRAFT_EXTRAPOLATION_LIMIT_MS),
    );
  });
});
