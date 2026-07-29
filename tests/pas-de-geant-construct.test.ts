import { describe, expect, it } from "vitest";
import {
  CONSTRUCT_LATITUDE_DEGREES,
  CONSTRUCT_LONGITUDE_DEGREES,
  CONSTRUCT_SCALE_FACTORS,
  constructDisplayRadiusM,
  constructScaleFactor,
  selectConstructTerrainPlan,
} from "../apps/pas-de-geant/src/construct-core.js";
import { mercatorTileKey } from "../apps/pas-de-geant/src/local-terrain-core.js";

describe("The Construct fixed terrain pattern", () => {
  it("accepts only the five deliberate preview scales", () => {
    for (const factor of CONSTRUCT_SCALE_FACTORS) {
      expect(constructScaleFactor(String(factor))).toBe(factor);
    }
    expect(constructScaleFactor("17")).toBe(1);
    expect(constructScaleFactor(null)).toBe(1);
  });

  it.each([
    [1, 6],
    [100, 12],
    [250, 14],
    [500, 14],
    [1000, 14],
  ])(
    "keeps the same broad construct at %d× by selecting z%d",
    (scaleFactor, expectedZoom) => {
      const plan = selectConstructTerrainPlan({
        latitudeDegrees: CONSTRUCT_LATITUDE_DEGREES,
        longitudeDegrees: CONSTRUCT_LONGITUDE_DEGREES,
        displayRadiusM: constructDisplayRadiusM(scaleFactor),
      });
      expect(plan.zoom).toBe(expectedZoom);
      expect(plan.rendered).toHaveLength(160);
      expect(plan.required).toHaveLength(225);
      expect(new Set(plan.rendered.map(mercatorTileKey))).toHaveLength(160);
      expect(new Set(plan.required.map(mercatorTileKey))).toHaveLength(225);
      expect(
        plan.rendered.filter((tile) => tile.meshSegments === 512),
      ).toHaveLength(4);
      expect(
        plan.rendered.filter(
          (tile) => tile.ring === 0 && tile.meshSegments === 64,
        ),
      ).toHaveLength(60);
      expect(
        plan.rendered.filter(
          (tile) => tile.ring === 1 && tile.meshSegments === 32,
        ),
      ).toHaveLength(48);
      expect(
        plan.rendered.filter(
          (tile) => tile.ring === 2 && tile.meshSegments === 16,
        ),
      ).toHaveLength(48);
      expect(plan.tileWidthM).toBeGreaterThanOrEqual(3.5);
      if (plan.zoom < 14) {
        expect(plan.tileWidthM).toBeLessThanOrEqual(7.5);
      }
    },
  );

  it("uses only a source-level shift as the scale increases", () => {
    const plans = CONSTRUCT_SCALE_FACTORS.map((scaleFactor) =>
      selectConstructTerrainPlan({
        latitudeDegrees: CONSTRUCT_LATITUDE_DEGREES,
        longitudeDegrees: CONSTRUCT_LONGITUDE_DEGREES,
        displayRadiusM: constructDisplayRadiusM(scaleFactor),
      }),
    );
    expect(plans.map((plan) => plan.rendered.length)).toEqual([
      160, 160, 160, 160, 160,
    ]);
    expect(plans.map((plan) => plan.required.length)).toEqual([
      225, 225, 225, 225, 225,
    ]);
    expect(plans.map((plan) => plan.zoom)).toEqual([6, 12, 14, 14, 14]);
    expect(plans[2]?.signature).toBe(plans[3]?.signature);
    expect(plans[3]?.signature).toBe(plans[4]?.signature);
  });

  it("tiles the three rings without any geographic overlap", () => {
    const plan = selectConstructTerrainPlan({
      latitudeDegrees: CONSTRUCT_LATITUDE_DEGREES,
      longitudeDegrees: CONSTRUCT_LONGITUDE_DEGREES,
      displayRadiusM: constructDisplayRadiusM(1),
    });
    const footprints = plan.rendered.map((tile) => {
      const width = 2 ** (plan.zoom - tile.z);
      return {
        key: mercatorTileKey(tile),
        west: tile.x * width,
        east: (tile.x + 1) * width,
        north: tile.y * width,
        south: (tile.y + 1) * width,
      };
    });

    for (let firstIndex = 0; firstIndex < footprints.length; firstIndex += 1) {
      const first = footprints[firstIndex]!;
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < footprints.length;
        secondIndex += 1
      ) {
        const second = footprints[secondIndex]!;
        const overlapWidth =
          Math.min(first.east, second.east) -
          Math.max(first.west, second.west);
        const overlapHeight =
          Math.min(first.south, second.south) -
          Math.max(first.north, second.north);
        expect(
          overlapWidth > 0 && overlapHeight > 0,
          `${first.key} overlaps ${second.key}`,
        ).toBe(false);
      }
    }

    const coveredFinestTiles = footprints.reduce(
      (area, footprint) =>
        area +
        (footprint.east - footprint.west) *
          (footprint.south - footprint.north),
      0,
    );
    expect(coveredFinestTiles).toBe(32 * 32);
  });

  it("conforms every mixed-density border from the detailed side only", () => {
    const plan = selectConstructTerrainPlan({
      latitudeDegrees: CONSTRUCT_LATITUDE_DEGREES,
      longitudeDegrees: CONSTRUCT_LONGITUDE_DEGREES,
      displayRadiusM: constructDisplayRadiusM(1),
    });
    const footprints = plan.rendered.map((tile) => {
      const width = 2 ** (plan.zoom - tile.z);
      return {
        tile,
        west: tile.x * width,
        east: (tile.x + 1) * width,
        north: tile.y * width,
        south: (tile.y + 1) * width,
        density: tile.meshSegments / width,
      };
    });
    let mixedBorders = 0;

    for (let firstIndex = 0; firstIndex < footprints.length; firstIndex += 1) {
      const first = footprints[firstIndex]!;
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < footprints.length;
        secondIndex += 1
      ) {
        const second = footprints[secondIndex]!;
        const verticalOverlap =
          Math.min(first.south, second.south) -
          Math.max(first.north, second.north);
        const horizontalOverlap =
          Math.min(first.east, second.east) -
          Math.max(first.west, second.west);
        const edges =
          first.east === second.west && verticalOverlap > 0
            ? (["east", "west"] as const)
            : first.west === second.east && verticalOverlap > 0
              ? (["west", "east"] as const)
              : first.south === second.north && horizontalOverlap > 0
                ? (["south", "north"] as const)
                : first.north === second.south && horizontalOverlap > 0
                  ? (["north", "south"] as const)
                  : undefined;
        if (!edges || first.density === second.density) continue;
        mixedBorders += 1;
        const [firstEdge, secondEdge] = edges;
        const detailed =
          first.density > second.density
            ? { footprint: first, edge: firstEdge, neighbour: second }
            : { footprint: second, edge: secondEdge, neighbour: first };
        const coarse =
          first.density < second.density
            ? { footprint: first, edge: firstEdge }
            : { footprint: second, edge: secondEdge };
        const constraint =
          detailed.footprint.tile.edgeConstraints[detailed.edge];
        expect(constraint).toBeDefined();
        expect(mercatorTileKey(constraint!.address)).toBe(
          mercatorTileKey(detailed.neighbour.tile),
        );
        expect(constraint!.segments).toBe(
          detailed.neighbour.tile.meshSegments,
        );
        expect(detailed.footprint.tile.skirtEdges[detailed.edge]).toBe(1);
        expect(coarse.footprint.tile.edgeConstraints[coarse.edge]).toBeUndefined();
        expect(coarse.footprint.tile.skirtEdges[coarse.edge]).toBe(0);
      }
    }

    expect(mixedBorders).toBeGreaterThan(0);
  });
});
