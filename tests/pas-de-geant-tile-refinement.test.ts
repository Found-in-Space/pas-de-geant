import { describe, expect, it } from "vitest";
import { TileOnionLayoutSource } from "../packages/pas-de-geant/src/worlds/tile-layout-source.js";
import { calculateTileOnionPlan, tileBounds } from "../packages/pas-de-geant/src/worlds/tile-onion-core.js";
import { assertAdmissibleCut, type TileIdentity } from "../packages/pas-de-geant/src/worlds/tile-transition-planner.js";
import { constrainTileRefinement, sourceRefinementLimits, tileCoverageRanges } from "../packages/pas-de-geant/src/worlds/tile-refinement.js";
import { terrainRefinementLimits } from "../packages/pas-de-geant/src/worlds/terrain-lod.js";
import { BLUE_MARBLE_IMAGERY_NODE, buildDesiredImageryTree, imageryTreeImageAtGlobalUv,
  imageryTreeMaximumDepth, reconcileImageryTree } from "../packages/pas-de-geant/src/worlds/imagery-tree.js";

const contains = (parent: TileIdentity, child: TileIdentity) => {
  const scale = 2 ** (child.z - parent.z);
  return parent.z <= child.z && Math.floor(child.x / scale) === parent.x && Math.floor(child.y / scale) === parent.y;
};
const targetAt = (tile: TileIdentity, maxZoom: number) => {
  const bounds = tileBounds(tile);
  return { maxZoom, latitudeDegrees: (bounds.north + bounds.south) / 2,
    longitudeDegrees: (bounds.west + bounds.east) / 2 };
};

describe("source-aware tile refinement", () => {
  it("compresses exact coverage without bridging missing pixels, rows or levels", () => {
    const levels = [{ zoom: 4, tiles: [[2, 3], [3, 3], [2, 4], [3, 4], [5, 3], [5, 5], [2, 7], [2, 7]] as const },
      { zoom: 5, tiles: [[2, 3]] as const }];
    const ranges = tileCoverageRanges(levels);
    for (const { zoom, tiles } of levels) {
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
        expect(ranges.some(([z, x0, y0, x1, y1]) => z === zoom && x >= x0 && x <= x1 && y >= y0 && y <= y1))
          .toBe(tiles.some(([tx, ty]) => tx === x && ty === y));
      }
    }
    expect(ranges.length).toBeLessThan(levels.reduce((n, l) => n + l.tiles.length, 0));
  });

  it("stops global imagery at its source resolution while preserving complete balanced coverage", () => {
    const target = { maxZoom: 14, latitudeDegrees: 10.61, longitudeDegrees: 26.7 };
    const cut = new TileOnionLayoutSource(sourceRefinementLimits({ globalMaximumZoom: 9, ranges: [] })).calculate(target);
    expect(Math.max(...cut.map(t => t.z))).toBe(9);
    expect(cut.length).toBeLessThan(calculateTileOnionPlan(target).leaves.length);
    expect(() => assertAdmissibleCut(cut)).not.toThrow();
  });

  it("keeps sparse detail reachable through missing parents, including across the longitude seam", () => {
    for (const x of [0, 127, 255]) {
      const detail = { z: 8, x, y: 128 };
      const limits = sourceRefinementLimits({ globalMaximumZoom: 2, ranges: [[8, x, 128, x, 128]] });
      const cut = new TileOnionLayoutSource(limits).calculate(targetAt(detail, 10));
      expect(cut.find(t => contains(t, detail))).toEqual(detail);
      expect(Math.max(...cut.map(t => t.z))).toBe(8);
      expect(() => assertAdmissibleCut(cut)).not.toThrow();
      const distant = { z: 8, x: (x + 128) % 256, y: 128 };
      expect(cut.find(t => contains(t, distant))!.z).toBeLessThan(8);
    }
  });

  it("does not add distant source detail beyond the view's requested refinement", () => {
    const target = { maxZoom: 3, latitudeDegrees: 0, longitudeDegrees: 0 };
    const wanted = calculateTileOnionPlan(target).leaves;
    const constrained = constrainTileRefinement(wanted, sourceRefinementLimits({ globalMaximumZoom: 2,
      ranges: [[18, 1, 1, 100, 100]] }));
    expect(Math.max(...constrained.map(t => t.z))).toBeLessThanOrEqual(3);
    expect(() => assertAdmissibleCut(constrained)).not.toThrow();
  });

  it("keeps mesh sampling dense enough for source pixels and supports custom segment tiers", () => {
    const coverage = { globalMaximumZoom: 7, ranges: [[15, 18520, 16322, 18520, 16322] as const] };
    const limits = terrainRefinementLimits(coverage, 256);
    expect(limits.globalMaximumZoom).toBe(10);
    expect(limits.ranges[0]![5]).toBe(18);
    expect(terrainRefinementLimits(coverage, 256, [{ minZoom: 0, segments: 64 }]).globalMaximumZoom).toBe(9);
    expect(terrainRefinementLimits(coverage, 256, [{ minZoom: 0, segments: 32 }, { minZoom: 9, segments: 128 }]).globalMaximumZoom).toBe(9);
    const cut = new TileOnionLayoutSource(limits).calculate({ maxZoom: 13, latitudeDegrees: 10.61, longitudeDegrees: 26.7 });
    expect(Math.max(...cut.map(t => t.z))).toBe(10);
    expect(() => assertAdmissibleCut(cut)).not.toThrow();
  });

  it("remains balanced as the observer crosses sparse coverage boundaries and polar regions", () => {
    const limits = sourceRefinementLimits({ globalMaximumZoom: 3, ranges: [[9, 270, 240, 273, 242], [8, 0, 0, 2, 2]] });
    const layout = new TileOnionLayoutSource(limits);
    for (const [latitudeDegrees, longitudeDegrees] of [[10, 10], [10, 11], [11, 12], [85, -179], [89, 179], [90, 0], [-90, 45]]) {
      const cut = layout.calculate({ maxZoom: 14, latitudeDegrees: latitudeDegrees!, longitudeDegrees: longitudeDegrees! });
      expect(() => assertAdmissibleCut(cut)).not.toThrow();
    }
  });
});

describe("imagery branches sharing one loaded source", () => {
  it("collapses redundant descendants without changing source selection", () => {
    const cut = calculateTileOnionPlan({ maxZoom: 9, latitudeDegrees: 10, longitudeDegrees: 20 }).leaves;
    const desired = buildDesiredImageryTree(cut, tile => {
      const z = Math.min(3, tile.z), scale = 2 ** (tile.z - z);
      return { image: `${z}/${Math.floor(tile.x / scale)}/${Math.floor(tile.y / scale)}`, fallbackFromNotFound: false };
    });
    const tree = reconcileImageryTree(BLUE_MARBLE_IMAGERY_NODE, desired, {
      isResident: () => true, sourceZoom: image => Number(image.split("/")[0]), imageNode: image => ({ image }),
    });
    expect(imageryTreeMaximumDepth(tree)).toBe(3);
    for (const tile of cut) {
      const scale = 2 ** (tile.z - Math.min(3, tile.z));
      expect(imageryTreeImageAtGlobalUv(tree, (tile.x + 0.5) / 2 ** tile.z, (tile.y + 0.5) / 2 ** tile.z))
        .toBe(`${Math.min(3, tile.z)}/${Math.floor(tile.x / scale)}/${Math.floor(tile.y / scale)}`);
    }
  });

  it("keeps existing detail while a coarser replacement is unavailable", () => {
    const current = { children: [{ image: "fine" }, { image: "coarse" }, { image: "coarse" }, { image: "coarse" }] as const };
    const desired = { children: Array.from({ length: 4 }, () => ({ image: "pending", fallbackFromNotFound: false })) as any };
    const tree = reconcileImageryTree(current, desired, {
      isResident: () => false, sourceZoom: () => 1, imageNode: image => ({ image }),
    });
    expect(tree).toBe(current);
    expect(imageryTreeImageAtGlobalUv(tree, 0.25, 0.25)).toBe("fine");
  });
});
