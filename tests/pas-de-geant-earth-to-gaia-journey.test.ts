import { describe, expect, it, vi } from "vitest";
import {
  BODY_FADE_END_DIAMETER_M,
  BODY_FADE_START_DIAMETER_M,
  EARTH_TO_GAIA_DURATION_MS,
  JourneyRunner,
  STELLAR_METRES_PER_PARSEC,
  STELLAR_SCALE_DENOMINATOR,
  STELLAR_SUN_DISTANCE_PC,
  apparentMagnitude,
  observerWithRoomTranslation,
  renderedBodyOpacity,
  sampleEarthToGaiaTimeline,
  sphericalDirectionMix,
  type EarthToGaiaTimelineContext,
  type EarthToGaiaTimelineSample,
} from "../apps/pas-de-geant/src/earth-to-gaia-journey.js";

const CONTEXT: EarthToGaiaTimelineContext = {
  startScaleDenominator: 60_000,
  startObserverJ2000Pc: { x: 0.000004848, y: 0, z: 0 },
  solarOverviewScaleDenominator: 1.2e13,
  catalogObserverJ2000Pc: { x: 0.000004848, y: 0, z: 0 },
  destinationDirectionJ2000: { x: 0, y: 0, z: -1 },
};

describe("Earth-to-Gaia timeline", () => {
  it("rebases immediately into free space and reaches the exact stellar endpoint", () => {
    expect(sampleEarthToGaiaTimeline(0, CONTEXT)).toMatchObject({
      phase: "earth",
      navigationMode: "free",
      scaleDenominator: 60_000,
      observerJ2000Pc: CONTEXT.startObserverJ2000Pc,
    });

    const reveal = sampleEarthToGaiaTimeline(EARTH_TO_GAIA_DURATION_MS, CONTEXT);
    expect(reveal).toMatchObject({
      phase: "stellar_reveal",
      realm: "stellar",
      scaleDenominator: STELLAR_SCALE_DENOMINATOR,
      roomTranslationBlend: 1,
      physicalSunOpacity: 0,
      syntheticSunOpacity: 1,
      progress: 1,
    });
    expect(Math.hypot(
      reveal.observerJ2000Pc!.x,
      reveal.observerJ2000Pc!.y,
      reveal.observerJ2000Pc!.z,
    )).toBeCloseTo(STELLAR_SUN_DISTANCE_PC, 12);
    expect(reveal.observerJ2000Pc).toMatchObject({ x: 0, y: 0, z: -1 });
    expect(reveal.catalogObserverJ2000Pc).toEqual(
      CONTEXT.catalogObserverJ2000Pc,
    );
    expect(reveal.scaleDenominator).toBe(3.085677581491367e16);
    expect(STELLAR_SUN_DISTANCE_PC * STELLAR_METRES_PER_PARSEC).toBe(1);
    expect(apparentMagnitude(4.83, STELLAR_SUN_DISTANCE_PC))
      .toBeCloseTo(-0.17, 12);
  });

  it("uses continuous logarithmic scale and location curves without dwell periods", () => {
    let previousScale = 0;
    let previousRadius = 0;
    for (let elapsedMs = 0; elapsedMs <= EARTH_TO_GAIA_DURATION_MS;
      elapsedMs += 500) {
      const sample = sampleEarthToGaiaTimeline(elapsedMs, CONTEXT);
      const radius = Math.hypot(
        sample.observerJ2000Pc!.x,
        sample.observerJ2000Pc!.y,
        sample.observerJ2000Pc!.z,
      );
      if (elapsedMs > 0) {
        expect(sample.scaleDenominator).toBeGreaterThan(previousScale);
        expect(radius).toBeGreaterThan(previousRadius);
        expect(sample.phase).not.toBe("whole_earth");
        expect(sample.phase).not.toBe("solar_overview");
      }
      previousScale = sample.scaleDenominator;
      previousRadius = radius;
    }
    const midpoint = sampleEarthToGaiaTimeline(
      EARTH_TO_GAIA_DURATION_MS / 2,
      CONTEXT,
    );
    expect(midpoint.scaleDenominator).toBeCloseTo(
      Math.sqrt(
        CONTEXT.startScaleDenominator * STELLAR_SCALE_DENOMINATOR,
      ),
      6,
    );
    const startRadius = Math.hypot(
      CONTEXT.startObserverJ2000Pc.x,
      CONTEXT.startObserverJ2000Pc.y,
      CONTEXT.startObserverJ2000Pc.z,
    );
    expect(Math.hypot(
      midpoint.observerJ2000Pc!.x,
      midpoint.observerJ2000Pc!.y,
      midpoint.observerJ2000Pc!.z,
    )).toBeCloseTo(
      startRadius * (STELLAR_SUN_DISTANCE_PC / startRadius) ** 0.25,
      12,
    );
  });

  it("never scales beyond one rendered metre per parsec", () => {
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

  it("removes millimetre-scale bodies and crossfades only the Sun at the end", () => {
    expect(renderedBodyOpacity(BODY_FADE_START_DIAMETER_M)).toBe(1);
    expect(renderedBodyOpacity(BODY_FADE_END_DIAMETER_M)).toBe(0);
    expect(renderedBodyOpacity(0.004)).toBeCloseTo(0.5, 12);
    expect(sampleEarthToGaiaTimeline(0, CONTEXT)).toMatchObject({
      physicalSunOpacity: 1,
      syntheticSunOpacity: 0,
      roomTranslationBlend: 0,
    });
    const transition = sampleEarthToGaiaTimeline(40_000, CONTEXT);
    expect(transition.physicalSunOpacity).toBeGreaterThan(0);
    expect(transition.physicalSunOpacity).toBeLessThan(1);
    expect(transition.syntheticSunOpacity).toBeGreaterThan(0);
    expect(transition.syntheticSunOpacity).toBeLessThan(1);
    expect(transition.physicalSunOpacity + transition.syntheticSunOpacity)
      .toBeCloseTo(1, 12);
    expect(transition.roomTranslationBlend)
      .toBeCloseTo(transition.syntheticSunOpacity, 12);
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
    expect(observer).toEqual({ x: 9.7, y: 19.9, z: 30.2 });
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
    expect(samples.at(-1)?.observerJ2000Pc).toMatchObject({ z: -1 });

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
