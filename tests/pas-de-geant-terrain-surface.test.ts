import { describe, expect, it } from "vitest";
import {
  flatSurfaceObserverHeightMetres,
  sourceUvForTilePoint,
} from "../apps/pas-de-geant/src/terrain-surface.js";

describe("Terrain surface composition", () => {
  it("maps adjacent overzoom children to the same source coordinate at their join", () => {
    const westChild = {
      sourceScale: 2,
      sourceOffsetX: 0,
      sourceOffsetY: 0,
    };
    const eastChild = {
      sourceScale: 2,
      sourceOffsetX: 1,
      sourceOffsetY: 0,
    };
    const northChild = westChild;
    const southChild = {
      sourceScale: 2,
      sourceOffsetX: 0,
      sourceOffsetY: 1,
    };

    expect(sourceUvForTilePoint(westChild, 1, 0.37)).toEqual(
      sourceUvForTilePoint(eastChild, 0, 0.37),
    );
    expect(sourceUvForTilePoint(northChild, 0.42, 0)).toEqual(
      sourceUvForTilePoint(southChild, 0.42, 1),
    );
  });

  it("derives physical observer height only from flat-surface scale", () => {
    const first = flatSurfaceObserverHeightMetres(1.65, 64);
    const sameScaleRatio = flatSurfaceObserverHeightMetres(3.3, 128);
    const higherObserver = flatSurfaceObserverHeightMetres(3.3, 64);

    expect(sameScaleRatio).toBeCloseTo(first, 12);
    expect(higherObserver).toBeCloseTo(first * 2, 12);
  });
});
