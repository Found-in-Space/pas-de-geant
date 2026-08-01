import { describe, expect, it } from "vitest";
import {
  WEB_MERCATOR_MAX_LATITUDE,
  calculateTileOnionPlan,
  tileKey,
  type TileAddress,
  type TileOnionPlan,
} from "../apps/pas-de-geant/src/tile-onion-core.js";

function normalizedArea(address: TileAddress): number {
  return 1 / 4 ** address.z;
}

function expectExactQuadtreeCut(plan: TileOnionPlan): void {
  expect(new Set(plan.leaves.map(tileKey)).size).toBe(
    plan.leaves.length,
  );
  expect(
    plan.leaves.reduce((total, tile) => total + normalizedArea(tile), 0),
  ).toBeCloseTo(1, 12);
  const keys = new Set(plan.leaves.map(tileKey));
  for (const tile of plan.leaves) {
    for (let zoom = tile.z - 1; zoom >= 0; zoom -= 1) {
      const divisor = 2 ** (tile.z - zoom);
      expect(
        keys.has(
          tileKey({
            z: zoom,
            x: Math.floor(tile.x / divisor),
            y: Math.floor(tile.y / divisor),
          }),
        ),
      ).toBe(false);
    }
  }
}

describe("The provider-independent tile onion", () => {
  it("keeps the user within an eight-by-eight finest cap with a full guard", () => {
    for (const [latitudeDegrees, longitudeDegrees] of [
      [0, 0],
      [45.9, 9.25],
      [-33.86, 151.21],
      [12, 179.9],
    ] as const) {
      const plan = calculateTileOnionPlan({
        latitudeDegrees,
        longitudeDegrees,
        maxZoom: 9,
      });
      expect(plan.mode).toBe("normal");
      expect(plan.finestTiles).toHaveLength(64);
      expect(plan.underfoot).toBeDefined();
      const relativeX =
        ((plan.underfoot!.x - plan.anchor.x) % 2 ** plan.effectiveZoom +
          2 ** plan.effectiveZoom) %
        2 ** plan.effectiveZoom;
      const relativeY = plan.underfoot!.y - plan.anchor.y;
      expect(relativeX).toBeGreaterThanOrEqual(2);
      expect(relativeX).toBeLessThanOrEqual(5);
      expect(relativeY).toBeGreaterThanOrEqual(2);
      expect(relativeY).toBeLessThanOrEqual(5);
      const finest = new Set(plan.finestTiles.map(tileKey));
      for (const deltaY of [-1, 0, 1]) {
        for (const deltaX of [-1, 0, 1]) {
          expect(
            finest.has(
              tileKey({
                z: plan.effectiveZoom,
                x:
                  (plan.underfoot!.x + deltaX + 2 ** plan.effectiveZoom) %
                  2 ** plan.effectiveZoom,
                y: plan.underfoot!.y + deltaY,
              }),
            ),
          ).toBe(true);
        }
      }
      expectExactQuadtreeCut(plan);
    }
  });

  it("derives a complete non-overlapping outer cover at every practical depth", () => {
    for (const maxZoom of [0, 1, 2, 3, 8, 14]) {
      const plan = calculateTileOnionPlan({
        latitudeDegrees: 38.8977,
        longitudeDegrees: -77.0365,
        maxZoom,
      });
      expectExactQuadtreeCut(plan);
      expect(plan.leaves.filter((tile) => tile.role === "finest")).toHaveLength(
        plan.finestTiles.length,
      );
    }
  });

  it("keeps equivalent antimeridian coordinates on the same wrapped plan", () => {
    const east = calculateTileOnionPlan({
      latitudeDegrees: 20,
      longitudeDegrees: 179.75,
      maxZoom: 10,
    });
    const wrappedEast = calculateTileOnionPlan({
      latitudeDegrees: 20,
      longitudeDegrees: -180.25,
      maxZoom: 10,
    });
    expect(east.anchor).toEqual(wrappedEast.anchor);
    expect(east.leaves).toEqual(wrappedEast.leaves);
  });

  it("uses a bounded one-sided cap and coarsens with polar distance", () => {
    const edge = calculateTileOnionPlan({
      latitudeDegrees: WEB_MERCATOR_MAX_LATITUDE + 0.01,
      longitudeDegrees: 15,
      maxZoom: 14,
    });
    const pole = calculateTileOnionPlan({
      latitudeDegrees: 90,
      longitudeDegrees: 15,
      maxZoom: 14,
      previousState: edge.state,
    });
    expect(edge.mode).toBe("north-boundary");
    expect(edge.finestTiles).toHaveLength(64);
    expect(new Set(edge.finestTiles.map((tile) => tile.x))).toHaveLength(8);
    expect(new Set(edge.finestTiles.map((tile) => tile.y))).toEqual(
      new Set([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    expect(pole.effectiveZoom).toBeLessThan(edge.effectiveZoom);
    expect(pole.finestTiles.length).toBeLessThanOrEqual(64);
    expectExactQuadtreeCut(edge);
    expectExactQuadtreeCut(pole);
  });

  it("retains the last stable Earth-fixed direction at the pole", () => {
    const approaching = calculateTileOnionPlan({
      latitudeDegrees: 89,
      longitudeDegrees: 42,
      maxZoom: 12,
    });
    const pole = calculateTileOnionPlan({
      latitudeDegrees: 90,
      longitudeDegrees: -138,
      maxZoom: 12,
      previousState: approaching.state,
    });
    expect(approaching.state.poleLocked).toBe(true);
    expect(pole.state.poleLocked).toBe(true);
    expect(pole.state.boundaryLongitudeDegrees).toBe(
      approaching.state.boundaryLongitudeDegrees,
    );
  });

  it("deduplicates the boundary target down to the z0 root", () => {
    const plan = calculateTileOnionPlan({
      latitudeDegrees: 90,
      longitudeDegrees: 90,
      maxZoom: 0,
    });
    expect(plan.mode).toBe("north-boundary");
    expect(plan.finestTiles).toEqual([{ z: 0, x: 0, y: 0 }]);
    expect(plan.leaves).toEqual([{ z: 0, x: 0, y: 0, role: "finest" }]);
  });
});
