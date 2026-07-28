import { describe, expect, it } from "vitest";
import {
  AIRCRAFT_EXTRAPOLATION_LIMIT_MS,
  AIRCRAFT_POLL_INTERVAL_MS,
  airplanesLiveUrl,
  extrapolateAircraft,
  parseAirplanesLive,
  type TrackedAircraft,
} from "../apps/little-prince/src/aircraft-feed.js";
import { aircraftNormalizedAltitude } from "../apps/little-prince/src/aircraft-layer.js";
import { shouldPollAircraft } from "../apps/little-prince/src/aircraft-lifecycle.js";
import { EARTH_MEAN_RADIUS_KM } from "../apps/little-prince/src/planet-state.js";

describe("Little Planet Airplanes.live feed", () => {
  it("uses a conservative VR polling interval", () => {
    expect(AIRCRAFT_POLL_INTERVAL_MS).toBe(30_000);
  });

  it("polls only when the feature and a visible VR session are active", () => {
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

  it("builds bounded point-query URLs", () => {
    expect(airplanesLiveUrl(40, -4)).toBe(
      "https://api.airplanes.live/v2/point/40.0000/-4.0000/250",
    );
    expect(airplanesLiveUrl(100, 540, 999)).toBe(
      "https://api.airplanes.live/v2/point/90.0000/-180.0000/250",
    );
  });

  it("normalizes positioned airborne aircraft and their sample age", () => {
    const aircraft = parseAirplanesLive(
      {
        ac: [
          {
            hex: "484abc",
            flight: " KLM123 ",
            lat: 40.1,
            lon: -3.9,
            alt_baro: 32_000,
            alt_geom: 33_000,
            gs: 430,
            track: 91,
            track_rate: 0.25,
            seen_pos: 1.5,
          },
          {
            hex: "ground1",
            lat: 40,
            lon: -4,
            alt_baro: "ground",
          },
          { hex: "nopos", alt_baro: 10_000 },
        ],
      },
      10_000,
    );

    expect(aircraft).toEqual([
      {
        id: "484ABC",
        callsign: "KLM123",
        latitudeDegrees: 40.1,
        longitudeDegrees: -3.9,
        altitudeFt: 32_000,
        groundSpeedKt: 430,
        trackDegrees: 91,
        trackRateDegreesPerSecond: 0.25,
        sampledAtMs: 8_500,
      },
    ]);
  });

  it("dead-reckons position and turn between reports", () => {
    const aircraft: TrackedAircraft = {
      id: "TEST01",
      callsign: "TEST01",
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      altitudeFt: 10_000,
      groundSpeedKt: 360,
      trackDegrees: 90,
      trackRateDegreesPerSecond: 1,
      sampledAtMs: 1_000,
    };
    const extrapolated = extrapolateAircraft(aircraft, 11_000);

    expect(extrapolated.longitudeDegrees).toBeGreaterThan(0);
    expect(extrapolated.latitudeDegrees).toBeLessThan(0);
    expect(extrapolated.trackDegrees).toBeCloseTo(100);
  });

  it("caps extrapolation when updates become stale", () => {
    const aircraft: TrackedAircraft = {
      id: "TEST02",
      callsign: "TEST02",
      latitudeDegrees: 52,
      longitudeDegrees: 4,
      altitudeFt: 30_000,
      groundSpeedKt: 450,
      trackDegrees: 180,
      trackRateDegreesPerSecond: 0,
      sampledAtMs: 0,
    };
    expect(extrapolateAircraft(aircraft, 60_000)).toEqual(
      extrapolateAircraft(aircraft, AIRCRAFT_EXTRAPOLATION_LIMIT_MS),
    );
  });

  it("applies the shared radial scale to aircraft altitude", () => {
    expect(
      aircraftNormalizedAltitude(30_000, 1) * EARTH_MEAN_RADIUS_KM,
    ).toBeCloseTo(9.144);
    expect(
      aircraftNormalizedAltitude(30_000, 10) * EARTH_MEAN_RADIUS_KM,
    ).toBeCloseTo(91.44);
    expect(aircraftNormalizedAltitude(30_000, 0)).toBe(0);
  });
});
