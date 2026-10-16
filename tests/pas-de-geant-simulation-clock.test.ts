import { describe, expect, it } from "vitest";
import {
  anchoredSimulationClock,
  realtimeSimulationClock,
  simulationClockWithScale,
  simulationTimeMs,
} from "@found-in-space/pas-de-geant";

describe("simulation clock", () => {
  it("uses the built-in wall clock in realtime mode", () => {
    const clock = realtimeSimulationClock(1_000);

    expect(simulationTimeMs(clock, 1_000)).toBe(1_000);
    expect(simulationTimeMs(clock, 3_500)).toBe(3_500);
  });

  it("applies an anchored offset and scale", () => {
    const clock = anchoredSimulationClock(10_000, 180, 1_000);

    expect(clock.offsetMs).toBe(9_000);
    expect(simulationTimeMs(clock, 1_500)).toBe(100_000);
  });

  it("freezes exactly at scale zero", () => {
    const clock = anchoredSimulationClock(10_000, 0, 1_000);

    expect(simulationTimeMs(clock, 20_000)).toBe(10_000);
  });

  it("preserves continuity when the scale changes", () => {
    const accelerated = anchoredSimulationClock(10_000, 180, 1_000);
    const paused = simulationClockWithScale(accelerated, 0, 1_500);

    expect(simulationTimeMs(paused, 1_500)).toBe(100_000);
    expect(simulationTimeMs(paused, 20_000)).toBe(100_000);
    expect(simulationTimeMs(
      simulationClockWithScale(paused, -2, 20_000),
      20_500,
    )).toBe(99_000);
  });

  it("continues beyond an eclipse contact interval", () => {
    const firstContactMs = Date.parse("2026-08-12T15:34:00.000Z");
    const lastContactMs = Date.parse("2026-08-12T19:58:00.000Z");
    const clock = anchoredSimulationClock(firstContactMs, 180, 0);
    const afterContactsMs = simulationTimeMs(
      clock,
      (lastContactMs - firstContactMs) / 180 + 1_000,
    );

    expect(afterContactsMs).toBe(lastContactMs + 180_000);
  });
});
