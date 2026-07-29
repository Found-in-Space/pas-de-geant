import {
  createRuntime,
  type BitmapHandle,
  type DrawCommand,
} from "@found-in-space/touch-os";
import { describe, expect, it } from "vitest";
import {
  createHandPanelRoot,
  earthMapPoint,
  HAND_PANEL_SURFACE,
  HAND_PANEL_THEME,
} from "../apps/little-prince/src/hand-panel.js";

const map: BitmapHandle = {
  kind: "bitmap",
  image: {},
  width: 2_048,
  height: 1_024,
  revision: 1,
};

describe("Little Planet hand panel", () => {
  it("renders the whole-Earth map, underfoot marker, and coordinates", () => {
    const runtime = createRuntime({
      root: createHandPanelRoot(
        { latitudeDegrees: 40, longitudeDegrees: -4 },
        map,
      ),
      surface: HAND_PANEL_SURFACE,
      theme: HAND_PANEL_THEME,
    });

    const commands = runtime.render().commands;
    const image = commandWithRole(commands, "earth-map-image", "bitmap");
    const marker = commandWithRole(commands, "earth-map-marker", "circle");
    const coordinates = commandWithRole(
      commands,
      "value-readout-value",
      "text",
    );
    const expected = earthMapPoint(40, -4, image.rect);

    expect(image.handle).toBe(map);
    expect(marker.cx).toBeCloseTo(expected.x);
    expect(marker.cy).toBeCloseTo(expected.y);
    expect(coordinates.text).toBe("40.00° N · 4.00° W");

    runtime.dispose();
  });

  it("clamps latitude and wraps longitude onto the world map", () => {
    const rect = { x: 10, y: 20, width: 360, height: 180 };

    expect(earthMapPoint(100, 0, rect)).toEqual({ x: 190, y: 20 });
    expect(earthMapPoint(-100, 0, rect)).toEqual({ x: 190, y: 200 });
    expect(earthMapPoint(0, 181, rect)).toEqual({ x: 11, y: 110 });
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
