import { describe, expect, it } from "vitest";
import {
  WEB_MERCATOR_MAX_LATITUDE,
  calculateTileOnionPlan,
  tileBounds,
  tileKey,
  type TileAddress,
  type TileOnionPlan,
} from "../apps/pas-de-geant/src/tile-onion-core.js";

function planAtTile(
  z: number,
  x: number,
  y: number,
  previous?: TileOnionPlan,
): TileOnionPlan {
  const width = 2 ** z;
  const bounds = tileBounds({ z, x: ((x % width) + width) % width, y });
  return calculateTileOnionPlan({
    latitudeDegrees: (bounds.north + bounds.south) * 0.5,
    longitudeDegrees: (bounds.west + bounds.east) * 0.5,
    maxZoom: z,
    ...(previous ? { previousState: previous.state } : {}),
  });
}

function underfootCell(plan: TileOnionPlan): { column: number; row: number } {
  const underfoot = plan.underfoot!;
  const width = 2 ** plan.effectiveZoom;
  const unwrappedX = underfoot.x + Math.round(
    (plan.anchor.x + 3.5 - underfoot.x) / width,
  ) * width;
  return {
    column: unwrappedX - plan.anchor.x,
    row: underfoot.y - plan.anchor.y,
  };
}

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
    const width = 2 ** tile.z;
    expect(Number.isInteger(tile.x)).toBe(true);
    expect(Number.isInteger(tile.y)).toBe(true);
    expect(tile.x).toBeGreaterThanOrEqual(0);
    expect(tile.x).toBeLessThan(width);
    expect(tile.y).toBeGreaterThanOrEqual(0);
    expect(tile.y).toBeLessThan(width);
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
  for (const finest of plan.finestTiles) {
    expect(keys.has(tileKey(finest))).toBe(true);
  }
}

function tilesTouch(first: TileAddress, second: TileAddress): boolean {
  const commonZoom = Math.max(first.z, second.z);
  const worldWidth = 2 ** commonZoom;
  const firstScale = 2 ** (commonZoom - first.z);
  const secondScale = 2 ** (commonZoom - second.z);
  const firstWest = first.x * firstScale;
  const firstEast = (first.x + 1) * firstScale;
  const firstNorth = first.y * firstScale;
  const firstSouth = (first.y + 1) * firstScale;
  const secondWest = second.x * secondScale;
  const secondEast = (second.x + 1) * secondScale;
  const secondNorth = second.y * secondScale;
  const secondSouth = (second.y + 1) * secondScale;

  if (firstNorth > secondSouth || secondNorth > firstSouth) return false;
  return [-worldWidth, 0, worldWidth].some((offset) =>
    firstWest <= secondEast + offset && secondWest + offset <= firstEast
  );
}

function expectBalancedQuadtreeCut(plan: TileOnionPlan): void {
  expectExactQuadtreeCut(plan);
  for (let firstIndex = 0; firstIndex < plan.leaves.length; firstIndex += 1) {
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < plan.leaves.length;
      secondIndex += 1
    ) {
      const first = plan.leaves[firstIndex]!;
      const second = plan.leaves[secondIndex]!;
      if (tilesTouch(first, second)) {
        expect(
          Math.abs(first.z - second.z),
          `${tileKey(first)} touches ${tileKey(second)}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  }
}

function splitLeaf(
  leaves: Map<string, TileAddress>,
  address: TileAddress,
): void {
  leaves.delete(tileKey(address));
  for (let deltaY = 0; deltaY < 2; deltaY += 1) {
    for (let deltaX = 0; deltaX < 2; deltaX += 1) {
      const child = {
        z: address.z + 1,
        x: address.x * 2 + deltaX,
        y: address.y * 2 + deltaY,
      };
      leaves.set(tileKey(child), child);
    }
  }
}

function referenceBalancedLeafKeys(
  finestTiles: readonly TileAddress[],
): string[] {
  const root = { z: 0, x: 0, y: 0 };
  const leaves = new Map<string, TileAddress>([[tileKey(root), root]]);

  for (const target of finestTiles) {
    let ancestor = root;
    while (ancestor.z < target.z) {
      if (leaves.has(tileKey(ancestor))) splitLeaf(leaves, ancestor);
      const childZoom = ancestor.z + 1;
      const divisor = 2 ** (target.z - childZoom);
      ancestor = {
        z: childZoom,
        x: Math.floor(target.x / divisor),
        y: Math.floor(target.y / divisor),
      };
    }
  }

  let refined = true;
  while (refined) {
    refined = false;
    const candidates = [...leaves.values()].sort((first, second) =>
      first.z - second.z || first.y - second.y || first.x - second.x
    );
    for (let firstIndex = 0; firstIndex < candidates.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < candidates.length;
        secondIndex += 1
      ) {
        const first = candidates[firstIndex]!;
        const second = candidates[secondIndex]!;
        if (
          tilesTouch(first, second) &&
          Math.abs(first.z - second.z) > 1
        ) {
          splitLeaf(leaves, first.z < second.z ? first : second);
          refined = true;
          break;
        }
      }
      if (refined) break;
    }
  }

  return [...leaves.keys()].sort();
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
      expectBalancedQuadtreeCut(plan);
    }
  });

  it("retains rows and columns 1-6, shifts once at 0/7, and resists reversal", () => {
    const cases = [
      {
        interior: [[8_001, 8_000], [8_002, 8_000], [8_003, 8_000]],
        boundary: [8_004, 8_000],
        landed: { column: 3, row: 3 },
        reversal: [8_003, 8_000],
      },
      {
        interior: [[7_999, 8_000], [7_998, 8_000]],
        boundary: [7_997, 8_000],
        landed: { column: 4, row: 3 },
        reversal: [7_998, 8_000],
      },
      {
        interior: [[8_000, 8_001], [8_000, 8_002], [8_000, 8_003]],
        boundary: [8_000, 8_004],
        landed: { column: 3, row: 3 },
        reversal: [8_000, 8_003],
      },
      {
        interior: [[8_000, 7_999], [8_000, 7_998]],
        boundary: [8_000, 7_997],
        landed: { column: 3, row: 4 },
        reversal: [8_000, 7_998],
      },
    ] as const;

    for (const testCase of cases) {
      let plan = planAtTile(14, 8_000, 8_000);
      const originalSignature = plan.signature;
      const originalAnchor = { ...plan.anchor };
      for (const [x, y] of testCase.interior) {
        plan = planAtTile(14, x, y, plan);
        expect(plan.anchor).toEqual(originalAnchor);
        expect(plan.signature).toBe(originalSignature);
      }
      const shifted = planAtTile(
        14,
        testCase.boundary[0],
        testCase.boundary[1],
        plan,
      );
      expect(shifted.anchor).not.toEqual(originalAnchor);
      expect(underfootCell(shifted)).toEqual(testCase.landed);
      const reversed = planAtTile(
        14,
        testCase.reversal[0],
        testCase.reversal[1],
        shifted,
      );
      expect(reversed.anchor).toEqual(shifted.anchor);
      expect(reversed.signature).toBe(shifted.signature);
      expect(reversed.signature).not.toBe(originalSignature);
    }
  });

  it("shifts both axes once on diagonal entry without flip-flopping", () => {
    for (const [entryX, entryY, landed] of [
      [8_004, 8_004, { column: 3, row: 3 }],
      [7_997, 7_997, { column: 4, row: 4 }],
    ] as const) {
      const first = planAtTile(14, 8_000, 8_000);
      const shifted = planAtTile(14, entryX, entryY, first);
      expect(underfootCell(shifted)).toEqual(landed);
      expect(shifted.anchor.x).not.toBe(first.anchor.x);
      expect(shifted.anchor.y).not.toBe(first.anchor.y);

      const xDirection = Math.sign(entryX - 8_000);
      const yDirection = Math.sign(entryY - 8_000);
      const reversed = planAtTile(
        14,
        entryX - xDirection,
        entryY - yDirection,
        shifted,
      );
      expect(reversed.anchor).toEqual(shifted.anchor);
      expect(reversed.signature).toBe(shifted.signature);
    }
  });

  it("coalesces a multi-cell jump directly around the latest location", () => {
    const first = planAtTile(14, 8_000, 8_000);
    const jumped = planAtTile(14, 8_060, 7_950, first);
    expect(underfootCell(jumped)).toEqual({ column: 3, row: 4 });
    expect(jumped.anchor.x).toBe(8_057);
    expect(jumped.anchor.y).toBe(7_946);

    const reversed = planAtTile(14, 8_059, 7_951, jumped);
    expect(reversed.anchor).toEqual(jumped.anchor);
    expect(reversed.signature).toBe(jumped.signature);
  });

  it("resets the retained anchor when zoom or planner mode changes", () => {
    const first = planAtTile(14, 8_000, 8_000);
    const shifted = planAtTile(14, 8_004, 8_000, first);
    const bounds = tileBounds({ z: 14, x: 8_003, y: 8_000 });
    const latitudeDegrees = (bounds.north + bounds.south) * 0.5;
    const longitudeDegrees = (bounds.west + bounds.east) * 0.5;
    const zoomReset = calculateTileOnionPlan({
      latitudeDegrees,
      longitudeDegrees,
      maxZoom: 13,
      previousState: shifted.state,
    });
    expect(zoomReset.state.normalAnchor?.z).toBe(13);
    expect(underfootCell(zoomReset).column).toBe(3);

    const boundary = calculateTileOnionPlan({
      latitudeDegrees: WEB_MERCATOR_MAX_LATITUDE + 0.1,
      longitudeDegrees,
      maxZoom: 14,
      previousState: shifted.state,
    });
    expect(boundary.mode).toBe("north-boundary");
    expect(boundary.state.normalAnchor).toBeUndefined();
    const modeReset = calculateTileOnionPlan({
      latitudeDegrees,
      longitudeDegrees,
      maxZoom: 14,
      previousState: boundary.state,
    });
    expect(underfootCell(modeReset)).toEqual({ column: 3, row: 3 });
    expect(modeReset.anchor).not.toEqual(shifted.anchor);
  });

  it("retains unwrapped continuity across the antimeridian", () => {
    const width = 2 ** 14;
    let plan = planAtTile(14, width - 2, 8_000);
    const original = { ...plan.anchor };
    for (const x of [width - 1, 0, 1]) {
      plan = planAtTile(14, x, 8_000, plan);
      expect(plan.anchor).toEqual(original);
    }
    const shifted = planAtTile(14, 2, 8_000, plan);
    expect(shifted.anchor.x).toBe(width - 1);
    expect(underfootCell(shifted).column).toBe(3);
    const reversed = planAtTile(14, 1, 8_000, shifted);
    expect(reversed.anchor).toEqual(shifted.anchor);
  });

  it("keeps whole-world low zoom plans stable under movement", () => {
    for (const maxZoom of [2, 3]) {
      let plan = calculateTileOnionPlan({
        latitudeDegrees: 0,
        longitudeDegrees: -170,
        maxZoom,
      });
      const signature = plan.signature;
      const width = 2 ** maxZoom;
      for (const longitudeDegrees of [-80, 0, 80, 170]) {
        plan = calculateTileOnionPlan({
          latitudeDegrees: 20,
          longitudeDegrees,
          maxZoom,
          previousState: plan.state,
        });
        expect(plan.anchor).toEqual({
          z: maxZoom,
          x: 0,
          y: 0,
          width,
          height: width,
        });
        expect(plan.signature).toBe(signature);
      }
    }
  });

  it("derives a complete balanced outer cover at every practical depth", () => {
    for (const maxZoom of [0, 1, 2, 3, 8, 14]) {
      const plan = calculateTileOnionPlan({
        latitudeDegrees: 38.8977,
        longitudeDegrees: -77.0365,
        maxZoom,
      });
      expectBalancedQuadtreeCut(plan);
      expect(plan.leaves.filter((tile) => tile.role === "finest")).toHaveLength(
        plan.finestTiles.length,
      );
    }
  });

  it("keeps equivalent antimeridian coordinates on one balanced wrapped plan", () => {
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
    expectBalancedQuadtreeCut(east);

    const seamPairs = east.leaves.flatMap((first, firstIndex) =>
      east.leaves.slice(firstIndex + 1).flatMap((second) => {
        const commonZoom = Math.max(first.z, second.z);
        const firstScale = 2 ** (commonZoom - first.z);
        const secondScale = 2 ** (commonZoom - second.z);
        const crossesSeam =
          (first.x === 0 &&
            (second.x + 1) * secondScale === 2 ** commonZoom) ||
          (second.x === 0 &&
            (first.x + 1) * firstScale === 2 ** commonZoom);
        return crossesSeam && tilesTouch(first, second)
          ? [[first, second] as const]
          : [];
      })
    );
    expect(seamPairs.length).toBeGreaterThan(0);
    for (const [first, second] of seamPairs) {
      expect(Math.abs(first.z - second.z)).toBeLessThanOrEqual(1);
    }
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
    expectBalancedQuadtreeCut(edge);
    expectBalancedQuadtreeCut(pole);
  });

  it("clips balance propagation at both Mercator latitude boundaries", () => {
    const north = calculateTileOnionPlan({
      latitudeDegrees: WEB_MERCATOR_MAX_LATITUDE + 0.001,
      longitudeDegrees: 71,
      maxZoom: 10,
    });
    const south = calculateTileOnionPlan({
      latitudeDegrees: -WEB_MERCATOR_MAX_LATITUDE - 0.001,
      longitudeDegrees: 71,
      maxZoom: 10,
    });
    expectBalancedQuadtreeCut(north);
    expectBalancedQuadtreeCut(south);

    const edgeZooms = (plan: TileOnionPlan): [number, number] => [
      Math.max(
        ...plan.leaves.filter((tile) => tile.y === 0).map((tile) => tile.z),
      ),
      Math.max(
        ...plan.leaves
          .filter((tile) => tile.y === 2 ** tile.z - 1)
          .map((tile) => tile.z),
      ),
    ];
    const [northEdgeZoom, northOppositeEdgeZoom] = edgeZooms(north);
    const [southOppositeEdgeZoom, southEdgeZoom] = edgeZooms(south);
    expect(northEdgeZoom - northOppositeEdgeZoom).toBeGreaterThan(1);
    expect(southEdgeZoom - southOppositeEdgeZoom).toBeGreaterThan(1);
  });

  it("matches a split-until-balanced reference across distinct alignments", () => {
    for (const [latitudeDegrees, longitudeDegrees] of [
      [20, 179.75],
      [20, -37],
      [WEB_MERCATOR_MAX_LATITUDE + 0.001, 71],
      [-WEB_MERCATOR_MAX_LATITUDE - 0.001, -109],
    ] as const) {
      const plan = calculateTileOnionPlan({
        latitudeDegrees,
        longitudeDegrees,
        maxZoom: 5,
      });
      expect(plan.leaves.map(tileKey).sort()).toEqual(
        referenceBalancedLeafKeys(plan.finestTiles),
      );
    }
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

  it("deduplicates wrapped finest targets throughout z0 to z2", () => {
    for (const maxZoom of [0, 1, 2]) {
      const plan = calculateTileOnionPlan({
        latitudeDegrees: 90,
        longitudeDegrees: 179.75,
        maxZoom,
      });
      const worldTileCount = 4 ** plan.effectiveZoom;
      expect(plan.finestTiles).toHaveLength(worldTileCount);
      expect(new Set(plan.finestTiles.map(tileKey))).toHaveLength(
        worldTileCount,
      );
      expect(plan.leaves).toHaveLength(worldTileCount);
      expectBalancedQuadtreeCut(plan);
    }
  });
});
