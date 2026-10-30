import { describe, expect, it } from "vitest";
import { projectedTilePoint, tilePointToGeographic, WEB_MERCATOR_MAX_LATITUDE } from "../packages/pas-de-geant/src/worlds/index.js";

describe("public grid conversion used by renderer adapters", () => {
  it("round trips geographic and Mercator points across resolutions", () => {
    for (const projection of ["web-mercator", "geographic"] as const) {
      for (const z of [0, 5, 17]) for (const [lat, lon] of [[54.5,-2.5],[0,0],[-70,170]] as const) {
        const p = projectedTilePoint(lat, lon, z, projection);
        const q = tilePointToGeographic(p.x, p.y, z, projection);
        expect(q.latitudeDegrees).toBeCloseTo(lat, 10);
        expect(q.longitudeDegrees).toBeCloseTo(lon, 10);
      }
    }
  });
  it("keeps inverse grid edges distinct and declares forward wrapping and clamping", () => {
    expect(tilePointToGeographic(0,0.5,0).longitudeDegrees).toBe(-180);
    expect(tilePointToGeographic(1,0.5,0).longitudeDegrees).toBe(180);
    expect(projectedTilePoint(0,180,0).x).toBe(0);
    expect(projectedTilePoint(90,0,0)).toEqual(projectedTilePoint(WEB_MERCATOR_MAX_LATITUDE,0,0));
  });
});
