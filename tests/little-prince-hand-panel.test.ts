import {
  createRuntime,
  type BitmapHandle,
  type DrawCommand,
} from "@found-in-space/touch-os";
import { describe, expect, it } from "vitest";
import {
  compassBorderPoint,
  createHandPanelRoot,
  earthMapImageRects,
  earthMapPoint,
  HAND_PANEL_SURFACE,
  HAND_PANEL_THEME,
} from "../apps/little-prince/src/hand-panel.js";
import { directionOnHandPanel } from "../apps/little-prince/src/hand-panel-orientation.js";
import { Quaternion, Vector3 } from "three";

const map: BitmapHandle = {
  kind: "bitmap",
  image: {},
  width: 2_048,
  height: 1_024,
  revision: 1,
};

describe("Little Planet hand panel", () => {
  it("keeps the underfoot point centred while the map scrolls beneath it", () => {
    const runtime = createRuntime({
      root: createHandPanelRoot(
        { latitudeDegrees: 40, longitudeDegrees: -4 },
        map,
        { x: 0, y: -1 },
      ),
      surface: HAND_PANEL_SURFACE,
      theme: HAND_PANEL_THEME,
    });

    const commands = runtime.render().commands;
    const images = commands.filter(
      (
        command,
      ): command is Extract<DrawCommand, { type: "bitmap" }> =>
        command.role === "earth-map-image" && command.type === "bitmap",
    );
    const image = images[0];
    if (!image?.clipRect) throw new Error("Missing clipped map image.");
    const marker = commandWithRole(commands, "earth-map-marker", "circle");
    const border = commandWithRole(commands, "earth-map-border", "rect");
    const northPointer = commandWithRole(
      commands,
      "earth-map-north-pointer",
      "circle",
    );
    const coordinates = commandWithRole(
      commands,
      "value-readout-value",
      "text",
    );
    const expected = earthMapPoint(40, -4, image.rect);

    expect(images).toHaveLength(3);
    expect(image.handle).toBe(map);
    expect(marker.cx).toBeCloseTo(expected.x);
    expect(marker.cy).toBeCloseTo(expected.y);
    expect(marker.cx).toBeCloseTo(
      image.clipRect.x + image.clipRect.width / 2,
    );
    expect(marker.cy).toBeCloseTo(
      image.clipRect.y + image.clipRect.height / 2,
    );
    expect(image.rect.width).toBeGreaterThan(image.clipRect.width);
    expect(border.stroke).toBe("#000000");
    expect(northPointer.cx).toBeCloseTo(
      border.rect.x + border.rect.width / 2,
    );
    expect(northPointer.cy).toBeCloseTo(border.rect.y);
    expect(coordinates.text).toBe("40.00° N · 4.00° W");

    runtime.dispose();
  });

  it("moves and wraps the north-up bitmap without moving the user marker", () => {
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

  it("places the north marker where its centre ray meets the border", () => {
    const rect = { x: 10, y: 20, width: 360, height: 180 };

    expect(compassBorderPoint({ x: 0, y: -1 }, rect)).toEqual({
      x: 190,
      y: 20,
    });
    expect(compassBorderPoint({ x: 1, y: 0 }, rect)).toEqual({
      x: 370,
      y: 110,
    });
    expect(compassBorderPoint({ x: 0, y: 1 }, rect)).toEqual({
      x: 190,
      y: 200,
    });
    expect(compassBorderPoint({ x: -1, y: 0 }, rect)).toEqual({
      x: 10,
      y: 110,
    });
  });

  it("projects geographic north into the tablet face", () => {
    const identity = new Quaternion();

    expect(
      directionOnHandPanel(new Vector3(0, 1, 0), identity),
    ).toEqual({ x: 0, y: -1 });
    expect(
      directionOnHandPanel(new Vector3(1, 0, 0), identity),
    ).toEqual({ x: 1, y: -0 });
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

function commandWithRole<TType extends DrawCommand["type"]>(
  commands: readonly DrawCommand[],
  role: string,
  type: TType,
): Extract<DrawCommand, { type: TType }> {
  const command = commands.find(
    (candidate) => candidate.role === role && candidate.type === type,
  );
  if (!command) throw new Error(`Missing ${role} ${type} command.`);
  return command as Extract<DrawCommand, { type: TType }>;
}
