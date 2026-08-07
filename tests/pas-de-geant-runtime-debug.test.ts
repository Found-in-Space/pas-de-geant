import { describe, expect, it } from "vitest";
import {
  FrameTelemetry,
  summarizeDurations,
} from "../apps/pas-de-geant/src/runtime-debug.js";

describe("runtime performance telemetry", () => {
  it("reports frame-tail latency as well as the average", () => {
    expect(summarizeDurations([4, 5, 6, 7, 30])).toEqual({
      latestMs: 30,
      meanMs: 10.4,
      p50Ms: 6,
      p95Ms: 30,
      p99Ms: 30,
      maxMs: 30,
    });
  });

  it("keeps a moving time window and compares intervals with the XR budget", () => {
    const telemetry = new FrameTelemetry(100);
    telemetry.record(0, 11, 4, true);
    telemetry.record(50, 12, 5, true);
    telemetry.record(101, 20, 6, false);

    expect(telemetry.snapshot(90)).toMatchObject({
      sampleCount: 2,
      windowSeconds: 0.05,
      observedFps: 19.61,
      targetFrameRate: 90,
      targetFrameBudgetMs: 11.11,
      framesOverBudget: 2,
      renderedFrames: 1,
      scheduledInterval: {
        latestMs: 20,
        meanMs: 16,
        p95Ms: 20,
      },
      applicationCpu: {
        latestMs: 6,
        meanMs: 5.5,
      },
    });
  });

  it("clears measurements between diagnostic configurations", () => {
    const telemetry = new FrameTelemetry();
    telemetry.record(10, 13.9, 7, true);
    telemetry.clear();

    expect(telemetry.snapshot()).toEqual({
      sampleCount: 0,
      windowSeconds: 0,
      observedFps: null,
      targetFrameRate: null,
      targetFrameBudgetMs: null,
      framesOverBudget: 0,
      renderedFrames: 0,
      scheduledInterval: null,
      applicationCpu: null,
    });
  });
});
