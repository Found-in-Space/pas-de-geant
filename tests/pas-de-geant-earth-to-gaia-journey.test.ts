import { describe, expect, it, vi } from "vitest";
import {
  EARTH_TO_GAIA_DURATION_MS,
  JourneyRunner,
  STELLAR_METRES_PER_PARSEC,
  STELLAR_SCALE_DENOMINATOR,
  WHOLE_EARTH_SCALE_DENOMINATOR,
  apparentMagnitude,
  observerWithRoomTranslation,
  safeEarthHandoffCenter,
  sampleEarthToGaiaTimeline,
  sphericalDirectionMix,
  type EarthToGaiaTimelineContext,
  type EarthToGaiaTimelineSample,
} from "../apps/pas-de-geant/src/earth-to-gaia-journey.js";

const CONTEXT: EarthToGaiaTimelineContext = {
  solarOverviewScaleDenominator: 1.2e13,
  catalogObserverJ2000Pc: { x: 0.000004848, y: 0, z: 0 },
  destinationDirectionJ2000: { x: 0, y: 0, z: -1 },
};

describe("Earth-to-Gaia timeline", () => {
  it("moves through the fixed phases and reaches the exact stellar endpoint", () => {
    expect(sampleEarthToGaiaTimeline(0, CONTEXT)).toMatchObject({
      phase: "earth",
      navigationMode: "surface",
      scaleDenominator: 60_000,
    });
    expect(sampleEarthToGaiaTimeline(11_000, CONTEXT)).toMatchObject({
      phase: "whole_earth",
      navigationMode: "orbit",
      scaleDenominator: WHOLE_EARTH_SCALE_DENOMINATOR,
    });
    expect(sampleEarthToGaiaTimeline(27_000, CONTEXT)).toMatchObject({
      phase: "solar_overview",
      navigationMode: "free",
      scaleDenominator: CONTEXT.solarOverviewScaleDenominator,
    });

    const reveal = sampleEarthToGaiaTimeline(EARTH_TO_GAIA_DURATION_MS, CONTEXT);
    expect(reveal).toMatchObject({
      phase: "stellar_reveal",
      realm: "stellar",
      scaleDenominator: STELLAR_SCALE_DENOMINATOR,
      roomTranslationBlend: 1,
      planetOpacity: 0,
      physicalSunOpacity: 0,
      syntheticSunOpacity: 1,
      progress: 1,
    });
    expect(Math.hypot(
      reveal.observerJ2000Pc!.x,
      reveal.observerJ2000Pc!.y,
      reveal.observerJ2000Pc!.z,
    )).toBeCloseTo(10, 12);
    expect(reveal.observerJ2000Pc).toMatchObject({ x: 0, y: 0, z: -10 });
    expect(reveal.catalogObserverJ2000Pc).toEqual(
      CONTEXT.catalogObserverJ2000Pc,
    );
    expect(reveal.scaleDenominator).toBe(3.085677581491367e17);
    expect(10 * STELLAR_METRES_PER_PARSEC).toBe(1);
    expect(apparentMagnitude(4.83, 10)).toBeCloseTo(4.83, 12);
  });

  it("moves the Earth around the viewer with positive clearance", () => {
    const head = { x: 0, y: 1.65, z: 0 };
    const initialRadius = 106;
    const initialCenter = { x: 0, y: -initialRadius, z: 0 };
    const targetDirection = { x: 0, y: 0, z: -1 };
    expect(safeEarthHandoffCenter(
      head,
      initialCenter,
      targetDirection,
      initialRadius,
      initialRadius,
      0,
    )).toEqual(initialCenter);
    const midpointRadius = 6;
    const midpoint = safeEarthHandoffCenter(
      head,
      initialCenter,
      targetDirection,
      initialRadius,
      midpointRadius,
      0.5,
    );
    expect(Math.hypot(
      midpoint.x - head.x,
      midpoint.y - head.y,
      midpoint.z - head.z,
    )).toBeGreaterThan(midpointRadius);
    const final = safeEarthHandoffCenter(
      head,
      initialCenter,
      targetDirection,
      initialRadius,
      0.4,
      1,
    );
    expect(final.x).toBeCloseTo(0, 12);
    expect(final.y).toBeCloseTo(1.65, 12);
    expect(final.z).toBeCloseTo(-1.8, 12);
  });

  it("never scales beyond one rendered metre per ten parsecs", () => {
    const oversizedContext = {
      ...CONTEXT,
      solarOverviewScaleDenominator: STELLAR_SCALE_DENOMINATOR * 2,
    };
    for (let elapsedMs = 0; elapsedMs <= EARTH_TO_GAIA_DURATION_MS;
      elapsedMs += 250) {
      expect(
        sampleEarthToGaiaTimeline(elapsedMs, oversizedContext)
          .scaleDenominator,
      ).toBeLessThanOrEqual(STELLAR_SCALE_DENOMINATOR);
    }
  });

  it("crossfades bodies and enables room parallax only in their authored windows", () => {
    expect(sampleEarthToGaiaTimeline(38_000, CONTEXT)).toMatchObject({
      planetOpacity: 0.5,
      physicalSunOpacity: 1,
      syntheticSunOpacity: 0,
      roomTranslationBlend: 0,
    });
    const midpoint = sampleEarthToGaiaTimeline(41_000, CONTEXT);
    expect(midpoint.planetOpacity).toBe(0);
    expect(midpoint.physicalSunOpacity).toBeCloseTo(0.5, 12);
    expect(midpoint.syntheticSunOpacity).toBeCloseTo(0.5, 12);
    expect(midpoint.physicalSunOpacity + midpoint.syntheticSunOpacity)
      .toBeCloseTo(1, 12);
    expect(midpoint.roomTranslationBlend).toBeCloseTo(0.5, 12);
  });

  it("rotates direction spherically and applies room translation exactly once", () => {
    const halfway = sphericalDirectionMix(
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      0.5,
    );
    expect(Math.hypot(halfway.x, halfway.y, halfway.z)).toBeCloseTo(1, 12);
    expect(halfway.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(halfway.z).toBeCloseTo(-Math.SQRT1_2, 12);

    const observer = observerWithRoomTranslation(
      { x: 10, y: 20, z: 30 },
      { x: 0.2, y: -0.1, z: 0.3 },
      (value) => ({ x: -value.z, y: value.y, z: value.x }),
      1,
    );
    expect(observer).toEqual({ x: 7, y: 19, z: 32 });
    expect(observerWithRoomTranslation(
      { x: 10, y: 20, z: 30 },
      { x: 0.2, y: -0.1, z: 0.3 },
      (value) => value,
      0,
    )).toEqual({ x: 10, y: 20, z: 30 });
  });
});

describe("JourneyRunner", () => {
  it("does not begin or mutate the Earth scene before preflight is current", async () => {
    let release!: (context: EarthToGaiaTimelineContext) => void;
    const ready = new Promise<EarthToGaiaTimelineContext>((resolve) => {
      release = resolve;
    });
    let scene = "earth";
    const begin = vi.fn(() => {
      scene = "journey";
    });
    const runner = new JourneyRunner<string, EarthToGaiaTimelineContext>({
      context: (preparation) => preparation,
      hooks: {
        capture: () => scene,
        prepare: async () => await ready,
        begin,
        apply: vi.fn(),
        restore: (snapshot) => {
          scene = snapshot;
        },
      },
    });

    const starting = runner.start();
    await Promise.resolve();
    expect(runner.getState().status).toBe("preparing");
    expect(scene).toBe("earth");
    expect(begin).not.toHaveBeenCalled();
    release(CONTEXT);
    await starting;
    expect(begin).toHaveBeenCalledOnce();
    expect(scene).toBe("journey");
  });

  it("prepares, pauses without advancing, resumes, completes, and restores", async () => {
    let now = 1_000;
    let scene = "earth";
    let captures = 0;
    let restores = 0;
    const samples: EarthToGaiaTimelineSample[] = [];
    const runner = new JourneyRunner<string, EarthToGaiaTimelineContext>({
      now: () => now,
      context: (preparation) => preparation,
      hooks: {
        capture: () => {
          captures += 1;
          return scene;
        },
        prepare: async () => CONTEXT,
        begin: () => {
          scene = "journey";
        },
        apply: (sample) => samples.push(sample),
        restore: (snapshot) => {
          restores += 1;
          scene = snapshot;
        },
      },
    });

    await runner.start();
    expect(runner.getState().status).toBe("running");
    now += 10_000;
    runner.update();
    runner.pause();
    const pausedAt = runner.getState().elapsedMs;
    now += 20_000;
    runner.update();
    expect(runner.getState().elapsedMs).toBe(pausedAt);
    runner.resume();
    now += EARTH_TO_GAIA_DURATION_MS;
    runner.update();
    expect(runner.getState()).toMatchObject({
      status: "completed",
      phase: "stellar_reveal",
      elapsedMs: EARTH_TO_GAIA_DURATION_MS,
      progress: 1,
    });
    expect(samples.at(-1)?.observerJ2000Pc).toMatchObject({ z: -10 });

    await runner.start();
    expect(restores).toBe(1);
    expect(captures).toBe(2);
    expect(scene).toBe("journey");
    runner.stop();
    expect(scene).toBe("earth");
    expect(runner.getState().status).toBe("idle");
  });

  it("restores the untouched snapshot when preflight fails", async () => {
    let scene = "earth";
    const restore = vi.fn((snapshot: string) => {
      scene = snapshot;
    });
    const runner = new JourneyRunner<string, EarthToGaiaTimelineContext>({
      context: (preparation) => preparation,
      hooks: {
        capture: () => scene,
        prepare: async () => {
          throw new Error("Gaia cells unavailable");
        },
        begin: () => {
          scene = "journey";
        },
        apply: vi.fn(),
        restore,
      },
    });

    await runner.start();
    expect(scene).toBe("earth");
    expect(restore).toHaveBeenCalledOnce();
    expect(runner.getState()).toMatchObject({
      status: "failed",
      phase: "failed",
      error: "Gaia cells unavailable",
    });
  });
});
