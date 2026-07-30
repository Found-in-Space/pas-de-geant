import { describe, expect, it } from "vitest";
import {
  selectTerrainTiles,
  terrainMaximumLevel,
} from "../apps/pas-de-geant/src/terrain-tiles.js";

describe("Pas de Géant terrain regressions", () => {
  it("keeps Quest-scale tile selection bounded while refining the apex", () => {
    for (const radius of [1, 63.71, 318.55]) {
      const tiles = selectTerrainTiles(40, -104, radius);
      expect(tiles.length).toBeGreaterThanOrEqual(2);
      expect(tiles.length).toBeLessThan(180);
      expect(Math.max(...tiles.map((tile) => tile.z))).toBe(
        terrainMaximumLevel(radius, 40),
      );
    }
  });
});
