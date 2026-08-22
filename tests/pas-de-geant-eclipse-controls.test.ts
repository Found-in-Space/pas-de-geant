import type { RuntimeOutput } from "@found-in-space/touch-os";
import { describe, expect, it } from "vitest";
import { freshButtonLatch } from "../apps/pas-de-geant/src/controller-input.js";
import { eclipseControllerIntent } from "../apps/pas-de-geant/src/eclipse-controller-input.js";
import {
  ECLIPSE_PANEL_ACTION,
  ECLIPSE_PANEL_FIELD,
  eclipsePanelCommand,
} from "../apps/pas-de-geant/src/eclipse-panel.js";
import {
  eclipseYearFromEventId,
  parseEclipsePlaybackArguments,
  parseEclipseRangeArguments,
  parseEclipseScaleArguments,
  parseEclipseSelectionArguments,
  parseEclipseTimeArguments,
} from "../apps/pas-de-geant/src/eclipse-tools.js";

function action(actionId: string): RuntimeOutput {
  return { type: "action", actionId, componentId: "test" };
}

function change(field: string, value: unknown): RuntimeOutput {
  return { type: "change-request", field, value, componentId: "test" };
}

describe("Eclipse observatory control surfaces", () => {
  it("maps touchOS timeline, playback, reset, and voice without view modes", () => {
    expect(eclipsePanelCommand(action(ECLIPSE_PANEL_ACTION.playback))).toEqual({
      type: "toggle-playback",
    });
    expect(eclipsePanelCommand(action(ECLIPSE_PANEL_ACTION.resetStage))).toEqual({
      type: "reset-stage",
    });
    expect(eclipsePanelCommand(action(ECLIPSE_PANEL_ACTION.voice))).toEqual({
      type: "toggle-voice",
    });
    expect(eclipsePanelCommand(change(ECLIPSE_PANEL_FIELD.timeline, 1.4))).toEqual({
      type: "set-time-fraction",
      value: 1,
    });
    expect(eclipsePanelCommand(change("eclipse.view", "earth"))).toBeNull();
  });

  it("maps A/B/X/Y once per controller-button press", () => {
    const leftButtons = Array.from({ length: 6 }, () => ({ pressed: false, value: 0 }));
    const rightButtons = Array.from({ length: 6 }, () => ({ pressed: false, value: 0 }));
    const session = {
      inputSources: [
        { handedness: "left", gamepad: { buttons: leftButtons } },
        { handedness: "right", gamepad: { buttons: rightButtons } },
      ],
    } as unknown as XRSession;
    const latch = freshButtonLatch();
    rightButtons[4]!.pressed = true;
    rightButtons[5]!.pressed = true;
    leftButtons[4]!.pressed = true;
    leftButtons[5]!.pressed = true;

    expect(eclipseControllerIntent(session, latch)).toEqual({
      orbitX: 0,
      orbitY: 0,
      altitudeAxis: 0,
      scaleAxis: 0,
      toggleVoice: true,
      resetStage: true,
      togglePlayback: true,
      togglePanel: true,
    });
    expect(eclipseControllerIntent(session, latch)).toEqual({
      orbitX: 0,
      orbitY: 0,
      altitudeAxis: 0,
      scaleAxis: 0,
      toggleVoice: false,
      resetStage: false,
      togglePlayback: false,
      togglePanel: false,
    });
  });

  it("maps the sticks to Earth orbit, altitude, and system scale", () => {
    const leftAxes = [0, 0, 0.7, -0.8];
    const rightAxes = [0, 0, -0.75, -0.9];
    const session = {
      inputSources: [
        { handedness: "left", gamepad: { axes: leftAxes, buttons: [] } },
        { handedness: "right", gamepad: { axes: rightAxes, buttons: [] } },
      ],
    } as unknown as XRSession;
    const intent = eclipseControllerIntent(session, freshButtonLatch());

    expect(intent.orbitX).toBeGreaterThan(0);
    expect(intent.orbitY).toBeGreaterThan(0);
    expect(intent.altitudeAxis).toBeLessThan(0);
    expect(intent.scaleAxis).toBeGreaterThan(0);
  });

  it("parses the Realtime eclipse tool arguments without inventing limits", () => {
    expect(parseEclipseRangeArguments({
      start_utc: "2027-01-01T00:00:00Z",
      end_utc: "2028-01-01T00:00:00Z",
    })).toEqual({
      startUtc: "2027-01-01T00:00:00.000Z",
      endUtc: "2028-01-01T00:00:00.000Z",
    });
    expect(parseEclipseSelectionArguments({
      event_id: " solar-2027-08-02-total ",
    })).toBe("solar-2027-08-02-total");
    expect(parseEclipseTimeArguments({ utc: "2027-08-02T10:07:49Z" }))
      .toBe("2027-08-02T10:07:49.000Z");
    expect(parseEclipsePlaybackArguments({ playing: true })).toBe(true);
    expect(parseEclipseScaleArguments({ metres_per_earth_radius: 1e-9 }))
      .toBe(1e-9);
    expect(parseEclipseScaleArguments({ metres_per_earth_radius: 1e9 }))
      .toBe(1e9);
    expect(eclipseYearFromEventId("solar-2027-08-02-total")).toBe(2027);
    expect(eclipseYearFromEventId("made-up-2027-eclipse")).toBeNull();
    expect(() => parseEclipseScaleArguments({ metres_per_earth_radius: 0 }))
      .toThrow();
  });
});
