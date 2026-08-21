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
  parseEclipseViewArguments,
} from "../apps/pas-de-geant/src/eclipse-tools.js";

function action(actionId: string): RuntimeOutput {
  return { type: "action", actionId, componentId: "test" };
}

function change(field: string, value: unknown): RuntimeOutput {
  return { type: "change-request", field, value, componentId: "test" };
}

describe("Eclipse observatory control surfaces", () => {
  it("maps touchOS timeline, playback, views, reset, and voice to commands", () => {
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
    for (const preset of ["system", "earth", "moon", "shadow"] as const) {
      expect(eclipsePanelCommand(change(ECLIPSE_PANEL_FIELD.view, preset))).toEqual({
        type: "set-view",
        preset,
      });
    }
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
      toggleVoice: true,
      resetStage: true,
      togglePlayback: true,
      togglePanel: true,
    });
    expect(eclipseControllerIntent(session, latch)).toEqual({
      toggleVoice: false,
      resetStage: false,
      togglePlayback: false,
      togglePanel: false,
    });
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
    expect(parseEclipseViewArguments({ preset: "shadow" })).toBe("shadow");
    expect(parseEclipseScaleArguments({ metres_per_earth_radius: 1e-9 }))
      .toBe(1e-9);
    expect(parseEclipseScaleArguments({ metres_per_earth_radius: 1e9 }))
      .toBe(1e9);
    expect(eclipseYearFromEventId("solar-2027-08-02-total")).toBe(2027);
    expect(eclipseYearFromEventId("made-up-2027-eclipse")).toBeNull();
    expect(() => parseEclipseViewArguments({ preset: "flight" })).toThrow();
    expect(() => parseEclipseScaleArguments({ metres_per_earth_radius: 0 }))
      .toThrow();
  });
});
