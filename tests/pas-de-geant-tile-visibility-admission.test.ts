import { describe, expect, it } from "vitest";
import {
  plannerVisibilityCandidates,
  TileVisibilityAdmission,
} from "../apps/pas-de-geant/src/tile-visibility-admission.js";
import {
  tileIdentityKey,
  type ReplacementGroup,
  type TileIdentity,
} from "../apps/pas-de-geant/src/tile-transition-planner.js";

const currentView = {
  footprint: [{ latitudeDegrees: -5, longitudeDegrees: 22.5 }],
};

function group(
  id: string,
  after: readonly TileIdentity[],
): ReplacementGroup {
  return {
    id,
    region: { z: 0, x: 0, y: 0 },
    before: [{ z: 1, x: 0, y: 0 }],
    after,
  };
}

describe("planner-bounded tile visibility admission", () => {
  it("deduplicates only committed tiles and planner replacement after-sets", () => {
    const committed = [{ z: 3, x: 4, y: 4 }];
    const planned = { z: 3, x: 5, y: 4 };

    expect(plannerVisibilityCandidates(
      committed,
      [group("visible", [committed[0]!, planned])],
    ).map(tileIdentityKey)).toEqual([
      tileIdentityKey(committed[0]!),
      tileIdentityKey(planned),
    ]);
  });

  it("selects a current visible subset with no adjacent tile ring", () => {
    const visible = { z: 3, x: 4, y: 4 };
    const adjacent = { z: 3, x: 5, y: 4 };
    const admission = new TileVisibilityAdmission();

    expect(admission.update({
      revision: 0,
      committedTiles: [visible],
      replacementGroups: [group("adjacent", [adjacent])],
      view: currentView,
    })?.map(tileIdentityKey)).toEqual([tileIdentityKey(visible)]);
    expect(admission.visibleKeys.has(tileIdentityKey(adjacent))).toBe(false);
  });

  it("movement changes only the intersection with current planner candidates", () => {
    const first = { z: 3, x: 4, y: 4 };
    const second = { z: 3, x: 5, y: 4 };
    const outsidePlan = { z: 3, x: 6, y: 4 };
    const admission = new TileVisibilityAdmission();

    admission.update({
      revision: 0,
      committedTiles: [first],
      replacementGroups: [group("next", [second])],
      view: currentView,
    });
    const moved = admission.update({
      revision: 0,
      committedTiles: [first],
      replacementGroups: [group("next", [second])],
      view: {
        ...currentView,
        footprint: [{ latitudeDegrees: -5, longitudeDegrees: 67.5 }],
      },
    });

    expect(moved?.map(tileIdentityKey)).toEqual([tileIdentityKey(second)]);
    expect(moved).not.toContainEqual(outsidePlan);
  });

  it("suppresses only unchanged scheduler updates, not classification", () => {
    const admission = new TileVisibilityAdmission();
    const input = {
      revision: 0,
      committedTiles: [{ z: 3, x: 4, y: 4 }],
      replacementGroups: [] as readonly ReplacementGroup[],
      view: currentView,
    };

    expect(admission.update(input)).toBeDefined();
    expect(admission.update(input)).toBeUndefined();
    expect(admission.metrics.classificationTotal).toBe(2);
  });

  it("notifies the scheduler again when the planner revision changes", () => {
    const admission = new TileVisibilityAdmission();
    const tile = { z: 3, x: 4, y: 4 };
    const input = {
      revision: 0,
      committedTiles: [tile],
      replacementGroups: [] as readonly ReplacementGroup[],
      view: currentView,
    };

    expect(admission.update(input)).toEqual([tile]);
    expect(admission.update({ ...input, revision: 1 })).toEqual([tile]);
    expect(admission.update({ ...input, revision: 1 })).toBeUndefined();
  });
});
