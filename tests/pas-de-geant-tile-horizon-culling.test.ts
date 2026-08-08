import { describe, expect, it } from "vitest";
import {
  TileHorizonCulling,
  classifyTilesWithinHorizon,
  geometricHorizonRadians,
  plannerHorizonCandidates,
} from "../apps/pas-de-geant/src/tile-horizon-culling.js";
import { tileIdentityKey } from "../apps/pas-de-geant/src/tile-transition-planner.js";

describe("planner horizon culling", () => {
  it("considers only committed tiles and planner replacement outputs", () => {
    const committed = [{ z: 1, x: 0, y: 0 }];
    const incoming = { z: 2, x: 0, y: 0 };
    const candidates = plannerHorizonCandidates(committed, [{
      id: "replacement",
      region: committed[0]!,
      before: committed,
      after: [incoming],
    }]);

    expect(candidates.map(tileIdentityKey)).toEqual(["1/0/0", "2/0/0"]);
  });

  it("uses the geometric horizon and excludes the opposite side of the world", () => {
    const local = { z: 3, x: 4, y: 4 };
    const opposite = { z: 3, x: 0, y: 4 };
    const retained = classifyTilesWithinHorizon([local, opposite], {
      latitudeDegrees: -20,
      longitudeDegrees: 22.5,
      displayRadiusM: 1_000,
      observerHeightWorldM: 1.65,
    });

    expect(retained).toEqual(new Set([tileIdentityKey(local)]));
    expect(geometricHorizonRadians(1_000, 0)).toBe(0);
  });

  it("suppresses unchanged horizon sets without any camera-orientation input", () => {
    const tile = { z: 3, x: 4, y: 4 };
    const culling = new TileHorizonCulling();
    const input = {
      revision: 3,
      committedTiles: [tile],
      replacementGroups: [],
      view: {
        latitudeDegrees: -20,
        longitudeDegrees: 22.5,
        displayRadiusM: 1_000,
        observerHeightWorldM: 1.65,
      },
    };

    expect(culling.update(input)).toEqual([tile]);
    expect(culling.update(input)).toBeUndefined();
  });
});
