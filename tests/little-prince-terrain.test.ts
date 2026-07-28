import { describe, expect, it } from "vitest";
import {
  boundsForTile,
  imageryUrlForTile,
  selectTerrainTiles,
} from "../apps/little-prince/src/terrain-tiles.js";

describe("Little Planet terrain selection", () => {
  it("uses two geographic root tiles", () => {
    expect(boundsForTile({ z: 0, x: 0, y: 0 })).toEqual({
      west: -180,
      east: 0,
      north: 90,
      south: -90,
    });
    expect(boundsForTile({ z: 0, x: 1, y: 0 })).toEqual({
      west: 0,
      east: 180,
      north: 90,
      south: -90,
    });
  });

  it("requests NASA imagery for the exact geographic tile bounds", () => {
    const url = new URL(imageryUrlForTile({ z: 5, x: 31, y: 8 }));
    expect(url.hostname).toBe("gibs.earthdata.nasa.gov");
    expect(url.searchParams.get("SERVICE")).toBe("WMS");
    expect(url.searchParams.get("VERSION")).toBe("1.1.1");
    expect(url.searchParams.get("BBOX")).toBe("-5.625,39.375,0,45");
  });

  it("keeps Quest-scale tile counts bounded while refining the apex", () => {
    for (const radius of [1, 63.71, 318.55]) {
      const tiles = selectTerrainTiles(40, -4, radius);
      expect(tiles.length).toBeGreaterThan(2);
      expect(tiles.length, `radius ${radius}`).toBeLessThan(120);
      expect(Math.max(...tiles.map((tile) => tile.z))).toBeGreaterThanOrEqual(
        2,
      );
    }
  });
});
