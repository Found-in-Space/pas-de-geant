import {
  createButton,
  createChoiceGroup,
  createColumn,
  createRow,
  createSlider,
  createTextLabel,
  createValueReadout,
  type DisplayNode,
  type RuntimeOutput,
} from "@found-in-space/touch-os";
import type { RealtimeAgentState } from "./realtime-agent.js";
import type { EclipseViewPreset } from "./eclipse-types.js";
import {
  HAND_PANEL_SURFACE,
  HAND_PANEL_THEME,
} from "./hand-panel.js";

export { HAND_PANEL_SURFACE, HAND_PANEL_THEME };

export const ECLIPSE_PANEL_ACTION = {
  playback: "eclipse.playback.toggle",
  resetStage: "eclipse.stage.reset",
  voice: "eclipse.voice.toggle",
} as const;

export const ECLIPSE_PANEL_FIELD = {
  timeline: "eclipse.timeline",
  view: "eclipse.view",
} as const;

export interface EclipsePanelState {
  eventLabel: string;
  atUtc: string;
  status: string;
  timeFraction: number;
  playing: boolean;
  activePreset: EclipseViewPreset | null;
  metresPerEarthRadius: number;
  voiceState: RealtimeAgentState;
}

export type EclipsePanelCommand =
  | { type: "toggle-playback" }
  | { type: "reset-stage" }
  | { type: "toggle-voice" }
  | { type: "set-time-fraction"; value: number }
  | { type: "set-view"; preset: EclipseViewPreset };

const VIEW_OPTIONS: ReadonlyArray<{
  value: EclipseViewPreset;
  label: string;
}> = [
  { value: "system", label: "System" },
  { value: "earth", label: "Earth" },
  { value: "moon", label: "Moon" },
  { value: "shadow", label: "Shadow" },
];

export function eclipsePanelCommand(
  output: RuntimeOutput,
): EclipsePanelCommand | null {
  if (output.type === "action") {
    if (output.actionId === ECLIPSE_PANEL_ACTION.playback) {
      return { type: "toggle-playback" };
    }
    if (output.actionId === ECLIPSE_PANEL_ACTION.resetStage) {
      return { type: "reset-stage" };
    }
    if (output.actionId === ECLIPSE_PANEL_ACTION.voice) {
      return { type: "toggle-voice" };
    }
    return null;
  }
  if (output.type !== "change-request") return null;
  if (
    output.field === ECLIPSE_PANEL_FIELD.timeline &&
    typeof output.value === "number"
  ) {
    return {
      type: "set-time-fraction",
      value: Math.max(0, Math.min(1, output.value)),
    };
  }
  if (
    output.field === ECLIPSE_PANEL_FIELD.view &&
    VIEW_OPTIONS.some(({ value }) => value === output.value)
  ) {
    return { type: "set-view", preset: output.value as EclipseViewPreset };
  }
  return null;
}

export function createEclipsePanelRoot(
  state: EclipsePanelState,
): DisplayNode<unknown> {
  const viewProps = {
    label: "View",
    options: VIEW_OPTIONS,
    selectionMode: "single" as const,
    field: ECLIPSE_PANEL_FIELD.view,
    orientation: "horizontal" as const,
    columns: 4,
    ...(state.activePreset ? { value: state.activePreset } : {}),
  };
  return createColumn("eclipse-hand-panel", {
    padding: 10,
    gap: 7,
    backgroundColor: HAND_PANEL_THEME.backgroundColor,
    children: [
      createTextLabel("eclipse-panel-title", {
        text: state.eventLabel,
        align: "center",
      }),
      createRow("eclipse-panel-time-status", {
        gap: 6,
        children: [
          createValueReadout("eclipse-panel-time", {
            label: "UTC",
            value: formatPanelUtc(state.atUtc),
          }),
          createValueReadout("eclipse-panel-shadow-status", {
            label: "Shadow",
            value: state.status,
          }),
        ],
      }),
      createSlider("eclipse-panel-timeline", {
        label: "Global contacts",
        min: 0,
        max: 1,
        step: 0.001,
        value: state.timeFraction,
        field: ECLIPSE_PANEL_FIELD.timeline,
      }),
      createChoiceGroup("eclipse-panel-view", viewProps),
      createRow("eclipse-panel-actions", {
        gap: 6,
        children: [
          createButton("eclipse-panel-playback", {
            label: state.playing ? "Pause · X" : "Play · X",
            actionId: ECLIPSE_PANEL_ACTION.playback,
          }),
          createButton("eclipse-panel-reset", {
            label: "Reset · B",
            actionId: ECLIPSE_PANEL_ACTION.resetStage,
          }),
          createButton("eclipse-panel-voice", {
            label: state.voiceState === "off" ? "Voice · A" : "Voice off · A",
            actionId: ECLIPSE_PANEL_ACTION.voice,
          }),
        ],
      }),
      createRow("eclipse-panel-readouts", {
        gap: 6,
        children: [
          createValueReadout("eclipse-panel-scale", {
            label: "Physical scale",
            value: `1 R⊕ = ${formatRoomDistance(state.metresPerEarthRadius)}`,
          }),
          createValueReadout("eclipse-panel-agent", {
            label: "Voice agent",
            value: state.voiceState.toUpperCase(),
          }),
        ],
      }),
    ],
  });
}

function formatPanelUtc(value: string): string {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return "—";
  return at.toISOString().slice(11, 19);
}

function formatRoomDistance(metres: number): string {
  if (metres < 0.01) return `${(metres * 1_000).toFixed(1)} mm`;
  if (metres < 1) return `${(metres * 100).toFixed(1)} cm`;
  return `${metres.toFixed(2)} m`;
}
