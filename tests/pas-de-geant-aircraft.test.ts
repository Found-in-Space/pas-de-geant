import { describe, expect, it } from "vitest";
import {
  FlightFollowerClient,
  parseFlightFollowerTrack,
  sampleAircraft,
} from "../apps/pas-de-geant/src/aircraft-feed.js";
import {
  aircraftRenderKind,
  formatAircraftLabel,
} from "../apps/pas-de-geant/src/aircraft-layer.js";
import {
  parseAircraftDisplayArguments,
  shouldStreamAircraft,
} from "../apps/pas-de-geant/src/aircraft-lifecycle.js";

function flightFollowerTrack(
  id = "484abc",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    revision: 4,
    observedAtMs: 1_000,
    callsign: " KLM123 ",
    registration: "PH-BXA",
    aircraftType: "B738",
    emitterCategory: " a7 ",
    current: {
      latitudeDegrees: 52.31,
      longitudeDegrees: 179,
      altitudeFt: 32_000,
      onGround: false,
      groundSpeedKt: 430,
      courseDegrees: 350,
      headingDegrees: 350,
      verticalRateFpm: 1_200,
    },
    trajectory: {
      generatedAtMs: 1_000,
      validUntilMs: 11_000,
      offsetMs: [0, 10_000],
      latitudeDegrees: [52.31, 52.41],
      longitudeDegrees: [179, -179],
      altitudeFt: [32_000, 33_000],
      courseDegrees: [350, 10],
      headingDegrees: [350, 10],
    },
    ...overrides,
  };
}

describe("Pas de Géant Flight Follower support", () => {
  it("streams only inside a visible, opted-in VR session", () => {
    expect(
      shouldStreamAircraft({
        enabled: true,
        vrSessionActive: true,
        documentVisible: true,
      }),
    ).toBe(true);

    for (const blocked of [
      { enabled: false, vrSessionActive: true, documentVisible: true },
      { enabled: true, vrSessionActive: false, documentVisible: true },
      { enabled: true, vrSessionActive: true, documentVisible: false },
    ]) {
      expect(shouldStreamAircraft(blocked)).toBe(false);
    }
  });

  it("parses category, nullable ground state, and compact trajectories", () => {
    const parsed = parseFlightFollowerTrack(flightFollowerTrack());

    expect(parsed).toMatchObject({
      id: "484ABC",
      callsign: "KLM123",
      emitterCategory: "A7",
      altitudeFt: 32_000,
      onGround: false,
    });
    expect(parsed?.trajectory.offsetMs).toEqual([0, 10_000]);

    const ground = parseFlightFollowerTrack(flightFollowerTrack("c0ffee", {
      emitterCategory: "C2",
      current: {
        latitudeDegrees: 52.31,
        longitudeDegrees: 4.76,
        altitudeFt: null,
        onGround: true,
        groundSpeedKt: 18,
        courseDegrees: 90,
        headingDegrees: 90,
        verticalRateFpm: 0,
      },
      trajectory: {
        generatedAtMs: 1_000,
        validUntilMs: 31_000,
        offsetMs: [0, 30_000],
        latitudeDegrees: [52.31, 52.311],
        longitudeDegrees: [4.76, 4.77],
        altitudeFt: [null, null],
        courseDegrees: [90, 90],
        headingDegrees: [90, 90],
      },
    }));
    expect(ground).toMatchObject({
      emitterCategory: "C2",
      altitudeFt: null,
      onGround: true,
    });
    expect(aircraftRenderKind(ground?.emitterCategory)).toBe("vehicle");
    expect(ground && formatAircraftLabel(ground).secondary).toBe("GND 18KT 090°");
  });

  it("interpolates the backend trajectory across the antimeridian and then holds", () => {
    const aircraft = parseFlightFollowerTrack(flightFollowerTrack())!;
    const halfway = sampleAircraft(aircraft, 6_000);
    const expired = sampleAircraft(aircraft, 60_000);

    expect(halfway.latitudeDegrees).toBeCloseTo(52.36);
    expect(Math.abs(halfway.longitudeDegrees)).toBe(180);
    expect(halfway.headingDegrees).toBeCloseTo(0);
    expect(halfway.altitudeFt).toBeCloseTo(32_500);
    expect(halfway.trackRateDegreesPerSecond).toBeCloseTo(2);
    expect(expired.longitudeDegrees).toBe(-179);
    expect(expired.altitudeFt).toBe(33_000);
  });

  it("subscribes after ready and applies snapshots and deltas", () => {
    const sent: string[] = [];
    const listeners = new Map<string, Array<(event?: unknown) => void>>();
    const socket = {
      readyState: 1,
      addEventListener(type: string, listener: (event?: unknown) => void) {
        const entries = listeners.get(type) ?? [];
        entries.push(listener);
        listeners.set(type, entries);
      },
      send(value: string) {
        sent.push(value);
      },
      close() {},
    };
    const emitMessage = (message: unknown): void => {
      for (const listener of listeners.get("message") ?? []) {
        listener({ data: JSON.stringify(message) });
      }
    };
    const updates: string[][] = [];
    const states: string[] = [];
    const client = new FlightFollowerClient({
      createSocket: () => socket as never,
      onTracks: (tracks) => updates.push(tracks.map(({ id }) => id)),
      onStatus: ({ state }) => states.push(state),
    });

    client.start({ latitudeDegrees: 52.31, longitudeDegrees: 4.76 });
    emitMessage({ protocolVersion: 1, type: "session.ready" });
    expect(JSON.parse(sent[0]!)).toEqual({
      protocolVersion: 1,
      type: "subscribe",
      center: { latitudeDegrees: 52.31, longitudeDegrees: 4.76 },
      radiusNm: 250,
    });

    emitMessage({
      protocolVersion: 1,
      type: "track.snapshot",
      tracks: [flightFollowerTrack("one")],
    });
    emitMessage({
      protocolVersion: 1,
      type: "track.delta",
      remove: ["one"],
      upsert: [flightFollowerTrack("two")],
    });
    expect(updates).toEqual([["ONE"], ["TWO"]]);
    expect(states).toContain("live");
  });

  it("validates independent aircraft and label voice controls", () => {
    expect(parseAircraftDisplayArguments({
      target: "labels",
      enabled: true,
    })).toEqual({ target: "labels", enabled: true });
    expect(() => parseAircraftDisplayArguments({
      target: "traffic",
      enabled: true,
    })).toThrow("target");
    expect(() => parseAircraftDisplayArguments({
      target: "aircraft",
      enabled: "yes",
    })).toThrow("boolean");
  });
});
