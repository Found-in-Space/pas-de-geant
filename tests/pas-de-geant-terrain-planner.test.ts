import { describe, expect, it } from "vitest";
import {
  LatestTerrainPlanScheduler,
  type TerrainPlanningInput,
  type TerrainPlanWorkerRequest,
} from "../apps/pas-de-geant/src/local-terrain-planner.js";
import type {
  ScreenSpaceTerrainPlan,
} from "../apps/pas-de-geant/src/local-terrain-core.js";

const baseInput: TerrainPlanningInput = {
  latitudeDegrees: 45,
  longitudeDegrees: 7,
  displayRadiusM: 1,
  radialMultiplier: 1,
  eyeHeightWorldM: 1.65,
  focalLengthPixels: 1_100,
  lodBias: 0,
  activeTileBudget: 128,
  heightTileBudget: 128,
};

const emptyPlan: ScreenSpaceTerrainPlan = {
  active: [],
  required: [],
  minZoom: 0,
  maxZoom: 0,
  budgetLimited: false,
};

describe("latest terrain plan scheduling", () => {
  it("keeps one request in flight and coalesces newer poses", () => {
    const requests: TerrainPlanWorkerRequest[] = [];
    const scheduler = new LatestTerrainPlanScheduler(
      (request) => requests.push(request),
      () => ["10/100/200"],
    );

    scheduler.record(baseInput);
    scheduler.record({ ...baseInput, longitudeDegrees: 7.01 });
    scheduler.record({ ...baseInput, longitudeDegrees: 7.02 });

    expect(requests).toHaveLength(1);
    expect(scheduler.hasRequestInFlight).toBe(true);
    expect(scheduler.hasQueuedInput).toBe(true);

    const first = requests[0]!;
    expect(
      scheduler.handleResult({
        type: "plan",
        requestId: first.requestId,
        revision: first.revision,
        plan: emptyPlan,
      }),
    ).toBeUndefined();

    expect(requests).toHaveLength(2);
    const latest = requests[1]!;
    expect(latest.input.longitudeDegrees).toBe(7.02);
    expect(latest.input.previousActiveKeys).toEqual(["10/100/200"]);
    expect(scheduler.staleResults).toBe(1);

    const completion = scheduler.handleResult({
      type: "plan",
      requestId: latest.requestId,
      revision: latest.revision,
      plan: emptyPlan,
    });
    expect(completion).toEqual({
      input: latest.input,
      plan: emptyPlan,
    });
    expect(scheduler.hasRequestInFlight).toBe(false);
    expect(scheduler.hasQueuedInput).toBe(false);
  });

  it("does not dispatch while paused and does not repeat a settled input", () => {
    const requests: TerrainPlanWorkerRequest[] = [];
    const scheduler = new LatestTerrainPlanScheduler(
      (request) => requests.push(request),
      () => [],
    );

    scheduler.setPaused(true);
    scheduler.record(baseInput);
    scheduler.record({ ...baseInput, displayRadiusM: 2 });
    expect(requests).toHaveLength(0);

    scheduler.setPaused(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.input.displayRadiusM).toBe(2);

    const request = requests[0]!;
    scheduler.handleResult({
      type: "plan",
      requestId: request.requestId,
      revision: request.revision,
      plan: emptyPlan,
    });
    expect(scheduler.record({ ...baseInput, displayRadiusM: 2 })).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("invalidates an in-flight result without overlapping worker requests", () => {
    const requests: TerrainPlanWorkerRequest[] = [];
    const scheduler = new LatestTerrainPlanScheduler(
      (request) => requests.push(request),
      () => [],
    );

    scheduler.record(baseInput);
    const obsolete = requests[0]!;
    scheduler.reset();
    scheduler.record({ ...baseInput, lodBias: 1 });
    expect(requests).toHaveLength(1);

    scheduler.handleResult({
      type: "plan",
      requestId: obsolete.requestId,
      revision: obsolete.revision,
      plan: emptyPlan,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.input.lodBias).toBe(1);
  });
});
