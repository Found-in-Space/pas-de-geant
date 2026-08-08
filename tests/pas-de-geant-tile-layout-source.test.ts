import { describe, expect, it } from "vitest";
import {
  TileOnionLayoutSource,
  normalizeTileLayoutTarget,
  tileLayoutTargetNeedsSubmission,
} from "../apps/pas-de-geant/src/tile-layout-source.js";
import {
  WEB_MERCATOR_MAX_LATITUDE,
  calculateTileOnionPlan,
  tileBounds,
} from "../apps/pas-de-geant/src/tile-onion-core.js";

const target = (
  latitudeDegrees: number,
  longitudeDegrees: number,
  maxZoom = 14,
) => ({ maxZoom, latitudeDegrees, longitudeDegrees });

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

  it("submits only when normal movement crosses the stride-four anchor", () => {
    const bounds = tileBounds({ z: 14, x: 8_000, y: 8_000 });
    const latitude = (bounds.north + bounds.south) / 2;
    const longitude = (bounds.west + bounds.east) / 2;
    const firstTarget = target(latitude, longitude);
    const sameTileTarget = target(latitude, longitude + 0.0001);
    const nextTileTarget = target(
      latitude,
      longitude + (bounds.east - bounds.west),
    );
    const nextAnchorTarget = target(
      latitude,
      longitude + 2 * (bounds.east - bounds.west),
    );
    const layout = new TileOnionLayoutSource();
    const first = layout.calculate(firstTarget);
    const nextTile = layout.calculate(nextTileTarget);
    const back = layout.calculate(firstTarget);

    expect(tileLayoutTargetNeedsSubmission(firstTarget, sameTileTarget))
      .toBe(false);
    expect(tileLayoutTargetNeedsSubmission(firstTarget, nextTileTarget))
      .toBe(false);
    expect(tileLayoutTargetNeedsSubmission(firstTarget, nextAnchorTarget))
      .toBe(true);
    expect(nextTile).toEqual(first);
    expect(back).toEqual(first);
  });

  it("treats antimeridian-equivalent normal anchors as unchanged", () => {
    expect(tileLayoutTargetNeedsSubmission(
      target(0, 179.999, 14),
      target(0, -179.999, 14),
    )).toBe(false);
  });

  it("keeps geographic submissions active for boundary and polar motion", () => {
    expect(tileLayoutTargetNeedsSubmission(
      target(WEB_MERCATOR_MAX_LATITUDE + 0.1, 20, 14),
      target(WEB_MERCATOR_MAX_LATITUDE + 0.2, 20.001, 14),
    )).toBe(true);
    expect(tileLayoutTargetNeedsSubmission(
      target(90, 20, 14),
      target(90, -160, 14),
    )).toBe(true);
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
