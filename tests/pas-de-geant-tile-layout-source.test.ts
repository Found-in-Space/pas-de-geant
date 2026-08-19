import { describe, expect, it } from "vitest";
import {
  TileLayoutSubmissionGate,
  TileOnionLayoutSource,
  normalizeTileLayoutTarget,
} from "../apps/pas-de-geant/src/tile-layout-source.js";
import {
  WEB_MERCATOR_MAX_LATITUDE,
  calculateTileOnionPlan,
  tileBounds,
} from "../apps/pas-de-geant/src/tile-onion-core.js";
import { TileTransitionScheduler } from "../apps/pas-de-geant/src/tile-transition-scheduler.js";

const target = (
  latitudeDegrees: number,
  longitudeDegrees: number,
  maxZoom = 14,
) => ({ maxZoom, latitudeDegrees, longitudeDegrees });

function tileTarget(z: number, x: number, y: number) {
  const width = 2 ** z;
  const bounds = tileBounds({ z, x: ((x % width) + width) % width, y });
  return target(
    (bounds.north + bounds.south) * 0.5,
    (bounds.west + bounds.east) * 0.5,
    z,
  );
}

describe("Tile onion layout source", () => {
  it("passes actual beyond-Mercator latitude to the planner", () => {
    const layout = new TileOnionLayoutSource();
    const actual = layout.calculate(target(89, 15));
    const expected = calculateTileOnionPlan(target(89, 15)).leaves;
    const clamped = calculateTileOnionPlan(
      target(WEB_MERCATOR_MAX_LATITUDE, 15),
    ).leaves;

    expect(actual).toEqual(expected.map(({ z, x, y }) => ({ z, x, y })));
    expect(actual).not.toEqual(clamped.map(({ z, x, y }) => ({ z, x, y })));
  });

  it("coarsens progressively toward the pole", () => {
    const layout = new TileOnionLayoutSource();
    const edge = layout.calculate(
      target(WEB_MERCATOR_MAX_LATITUDE + 0.001, 15),
    );
    const nearerPole = layout.calculate(target(87, 15));
    const pole = layout.calculate(target(90, 15));
    const maximumZoom = (cut: readonly { z: number }[]) =>
      Math.max(...cut.map(({ z }) => z));

    expect(maximumZoom(nearerPole)).toBeLessThan(maximumZoom(edge));
    expect(maximumZoom(pole)).toBeLessThan(maximumZoom(nearerPole));
  });

  it("retains the last stable Earth-fixed longitude at the pole", () => {
    const layout = new TileOnionLayoutSource();
    const approaching = layout.calculate(target(89, 42, 12));
    const pole = layout.calculate(target(90, -138, 12));

    expect(pole).toEqual(approaching);
  });

  it("carries planner hysteresis without tile churn", () => {
    let previous = calculateTileOnionPlan(
      target(WEB_MERCATOR_MAX_LATITUDE + 0.001, 30),
    );
    let hysteresisLatitude: number | undefined;
    for (
      let latitude = WEB_MERCATOR_MAX_LATITUDE + 0.002;
      latitude < 86;
      latitude += 0.0005
    ) {
      const withoutState = calculateTileOnionPlan(target(latitude, 30));
      const withState = calculateTileOnionPlan({
        ...target(latitude, 30),
        previousState: previous.state,
      });
      if (withoutState.effectiveZoom < previous.effectiveZoom &&
        withState.effectiveZoom === previous.effectiveZoom) {
        hysteresisLatitude = latitude;
        break;
      }
      previous = withState;
    }
    expect(hysteresisLatitude).toBeDefined();

    const layout = new TileOnionLayoutSource();
    const before = layout.calculate(target(
      WEB_MERCATOR_MAX_LATITUDE + 0.001,
      30,
    ));
    const held = layout.calculate(target(hysteresisLatitude!, 30));
    expect(held).toEqual(before);
  });

  it("retains the shifted anchor when normal movement reverses", () => {
    const firstTarget = tileTarget(14, 8_000, 8_000);
    const gate = new TileLayoutSubmissionGate(firstTarget);

    expect(gate.update(tileTarget(14, 8_001, 8_000))).toBe(false);
    expect(gate.update(tileTarget(14, 8_002, 8_000))).toBe(false);
    expect(gate.update(tileTarget(14, 8_003, 8_000))).toBe(false);
    expect(gate.update(tileTarget(14, 8_004, 8_000))).toBe(true);
    expect(gate.update(tileTarget(14, 8_003, 8_000))).toBe(false);
    expect(gate.update(tileTarget(14, 8_002, 8_000))).toBe(false);
  });

  it("treats antimeridian-equivalent normal anchors as unchanged", () => {
    const width = 2 ** 14;
    const gate = new TileLayoutSubmissionGate(tileTarget(14, width - 2, 8_000));
    expect(gate.update(tileTarget(14, width - 1, 8_000))).toBe(false);
    expect(gate.update(tileTarget(14, 0, 8_000))).toBe(false);
    expect(gate.update(tileTarget(14, 1, 8_000))).toBe(false);
    expect(gate.update(tileTarget(14, 2, 8_000))).toBe(true);
    expect(gate.update(tileTarget(14, 1, 8_000))).toBe(false);
  });

  it("keeps geographic submissions active for boundary and polar motion", () => {
    const gate = new TileLayoutSubmissionGate(
      target(WEB_MERCATOR_MAX_LATITUDE + 0.1, 20, 14),
    );
    expect(gate.update(
      target(WEB_MERCATOR_MAX_LATITUDE + 0.2, 20.001, 14),
    )).toBe(true);
    expect(gate.update(target(90, 20, 14))).toBe(true);
    expect(gate.update(target(90, -160, 14))).toBe(true);
  });

  it("keeps the worker planner stateful when the main-thread gate is bypassed", () => {
    const layout = new TileOnionLayoutSource();
    const first = layout.calculate(tileTarget(14, 8_000, 8_000));
    const interior = layout.calculate(tileTarget(14, 8_003, 8_000));
    const shifted = layout.calculate(tileTarget(14, 8_004, 8_000));
    const reversal = layout.calculate(tileTarget(14, 8_003, 8_000));

    expect(interior).toEqual(first);
    expect(shifted).not.toEqual(first);
    expect(reversal).toEqual(shifted);
  });

  it("advances exactly one worker revision for a shift and none on reversal", () => {
    const scheduler = new TileTransitionScheduler(
      tileTarget(14, 8_000, 8_000),
      new TileOnionLayoutSource(),
      {
        request: () => ({ requestId: 1, cancel() {} }),
      },
    );

    expect(scheduler.updateTarget(tileTarget(14, 8_003, 8_000))).toBe(false);
    expect(scheduler.snapshot.revision).toBe(0);
    expect(scheduler.updateTarget(tileTarget(14, 8_004, 8_000))).toBe(true);
    expect(scheduler.snapshot.revision).toBe(1);
    expect(scheduler.updateTarget(tileTarget(14, 8_003, 8_000))).toBe(false);
    expect(scheduler.snapshot.revision).toBe(1);
  });

  it("normalizes geographic targets without Mercator clamping", () => {
    expect(normalizeTileLayoutTarget({
      maxZoom: 12.9,
      latitudeDegrees: 89,
      longitudeDegrees: 541,
    })).toEqual({
      maxZoom: 12,
      latitudeDegrees: 89,
      longitudeDegrees: -179,
    });
  });
});
