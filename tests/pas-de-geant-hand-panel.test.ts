import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import {
  earthMapImageRects,
  earthMapPoint,
} from "../apps/pas-de-geant/src/hand-panel.js";
import { directionOnHandPanel } from "../apps/pas-de-geant/src/hand-panel-orientation.js";

describe("Pas de Géant hand-panel regressions", () => {
  it("keeps the user centred while the north-up map wraps beneath them", () => {
    const rect = { x: 10, y: 20, width: 360, height: 180 };
    const initial = earthMapImageRects(40, -4, rect);
    const moved = earthMapImageRects(41, -3, rect);
    const antimeridian = earthMapImageRects(0, 179, rect);
    const centre = { x: 190, y: 110 };

    expect(earthMapPoint(40, -4, initial[0]!)).toEqual(centre);
    expect(earthMapPoint(41, -3, moved[0]!)).toEqual(centre);
    expect(moved[0]!.x).not.toBe(initial[0]!.x);
    expect(moved[0]!.y).not.toBe(initial[0]!.y);
    for (const x of [rect.x, centre.x, rect.x + rect.width]) {
      expect(
        antimeridian.some(
          (candidate) =>
            candidate.x <= x &&
            candidate.x + candidate.width >= x,
        ),
      ).toBe(true);
    }
  });

  it("projects geographic north into the tablet face", () => {
    const identity = new Quaternion();
    expect(
      directionOnHandPanel(new Vector3(0, 1, 0), identity),
    ).toEqual({ x: 0, y: -1 });
    expect(
      directionOnHandPanel(new Vector3(0, 0, 1), identity),
    ).toBeUndefined();

    const quarterTurn = new Quaternion().setFromAxisAngle(
      new Vector3(0, 0, 1),
      Math.PI / 2,
    );
    const turned = directionOnHandPanel(
      new Vector3(0, 1, 0),
      quarterTurn,
    );
    expect(turned?.x).toBeCloseTo(1);
    expect(turned?.y).toBeCloseTo(0);
  });
});
