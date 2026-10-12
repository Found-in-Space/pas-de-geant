import { describe, expect, it } from "vitest";
import { previewAncestor, previewBoundsIntersect, previewContextAddress, type LunarPreviewProduct } from "../apps/pas-de-geant/src/lunar-preview-pyramid.js";

describe("sparse preview resolution and coverage", () => {
  it("retains the context parent after reaching its resolution cap", () => {
    expect(previewAncestor({ z: 15, x: 18520, y: 16261 }, 11)).toEqual({ z: 11, x: 1157, y: 1016 });
    expect(previewAncestor({ z: 9, x: 289, y: 254 }, 11)).toEqual({ z: 9, x: 289, y: 254 });
  });

  it("distinguishes a missing tile from an available coarser parent", () => {
    const product = { contextMaximumZoom: 11, levels: [{ zoom: 11, tiles: [[1157, 1016]] }] } as unknown as LunarPreviewProduct;
    expect(previewContextAddress(product, { z: 15, x: 18520, y: 16261 })).toEqual({ z: 11, x: 1157, y: 1016 });
    expect(previewContextAddress(product, { z: 15, x: 18560, y: 16261 })).toBeUndefined();
  });

  it("does not fetch detail for a disconnected area or a boundary touch", () => {
    expect(previewBoundsIntersect([20, 0, 21, 1], [21, 0, 22, 1])).toBe(false);
    expect(previewBoundsIntersect([20, 0, 21, 1], [20.5, .5, 22, 2])).toBe(true);
    expect(previewBoundsIntersect([20, 0, 21, 1], [24, 0, 25, 1])).toBe(false);
  });
});
