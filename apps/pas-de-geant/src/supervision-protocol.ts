import type { SolarSystemBodyId } from "./solar-system.js";
import type { NavigationMode } from "./world-navigation.js";
import {
  parseLocationPin,
  type LocationPin,
} from "./location-pin.js";

export const SUPERVISION_PATH = "/api/supervision";
export const SUPERVISION_SUBPROTOCOL = "pas-de-geant.supervision.v1";
export const SUPERVISION_PROTOCOL_VERSION = 1;

export interface SupervisionNavigationState {
  readonly sequence: number;
  readonly mode: NavigationMode;
  readonly focusBody: SolarSystemBodyId;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly displayRadiusM: number;
  readonly radialMultiplier: number;
  readonly headingDegrees: number | null;
}

export type SupervisionNavigationSnapshot = Omit<
  SupervisionNavigationState,
  "sequence"
>;

export type SupervisionCommand =
  | {
    readonly kind: "warp";
    readonly latitudeDegrees: number;
    readonly longitudeDegrees: number;
  }
  | {
    readonly kind: "setDisplayRadius";
    readonly displayRadiusM: number;
  }
  | {
    readonly kind: "setPin";
    readonly pin: LocationPin;
  }
  | {
    readonly kind: "removePin";
    readonly pinId: string;
  }
  | {
    readonly kind: "setPinGuidance";
    readonly pin: LocationPin;
    readonly enabled: boolean;
  };

export interface SupervisionSession {
  readonly sessionId: string;
  readonly label: string | null;
  readonly connectedAtMs: number;
  readonly state: SupervisionNavigationState | null;
  readonly pins: readonly LocationPin[];
  readonly guidedPinIds: readonly string[];
}

interface ProtocolMessage {
  readonly protocolVersion: typeof SUPERVISION_PROTOCOL_VERSION;
  readonly type: string;
}

export interface HeadsetHelloMessage extends ProtocolMessage {
  readonly type: "headset.hello";
  readonly sessionId: string;
  readonly label?: string;
  readonly startedAtMs: number;
}

export interface HeadsetStateMessage extends ProtocolMessage {
  readonly type: "headset.state";
  readonly state: SupervisionNavigationState;
  readonly pins: readonly LocationPin[];
  readonly guidedPinIds: readonly string[];
}

export interface SupervisorHelloMessage extends ProtocolMessage {
  readonly type: "supervisor.hello";
}

export interface SessionReadyMessage extends ProtocolMessage {
  readonly type: "session.ready";
  readonly sessionId: string;
}

export interface SessionsSnapshotMessage extends ProtocolMessage {
  readonly type: "sessions.snapshot";
  readonly sessions: readonly SupervisionSession[];
}

export interface SessionUpdatedMessage extends ProtocolMessage {
  readonly type: "session.updated";
  readonly session: SupervisionSession;
}

export interface SessionRemovedMessage extends ProtocolMessage {
  readonly type: "session.removed";
  readonly sessionId: string;
}

export interface SessionCommandMessage extends ProtocolMessage {
  readonly type: "session.command";
  readonly sessionId: string;
  readonly commandId: string;
  readonly command: SupervisionCommand;
}

export interface CommandMessage extends ProtocolMessage {
  readonly type: "command";
  readonly commandId: string;
  readonly command: SupervisionCommand;
}

export type CommandResultMessage = ProtocolMessage & {
  readonly type: "command.result";
  readonly commandId: string;
} & (
  | {
    readonly ok: true;
    readonly state: SupervisionNavigationState;
    readonly pins: readonly LocationPin[];
    readonly guidedPinIds: readonly string[];
  }
  | {
    readonly ok: false;
    readonly error: string;
  }
);

export type SupervisionMessage =
  | HeadsetHelloMessage
  | HeadsetStateMessage
  | SupervisorHelloMessage
  | SessionReadyMessage
  | SessionsSnapshotMessage
  | SessionUpdatedMessage
  | SessionRemovedMessage
  | SessionCommandMessage
  | CommandMessage
  | CommandResultMessage;

const BODY_IDS: ReadonlySet<string> = new Set([
  "sun",
  "mercury",
  "venus",
  "earth",
  "moon",
  "mars",
  "jupiter",
  "saturn",
  "uranus",
  "neptune",
]);

function record(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${description} must be a non-empty string.`);
  }
  return value;
}

function finiteNumber(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${description} must be finite.`);
  }
  return value;
}

function latitude(value: unknown): number {
  const result = finiteNumber(value, "Latitude");
  if (result < -90 || result > 90) {
    throw new Error("Latitude must be between -90 and 90 degrees.");
  }
  return result;
}

function longitude(value: unknown): number {
  const result = finiteNumber(value, "Longitude");
  if (result < -180 || result > 180) {
    throw new Error("Longitude must be between -180 and 180 degrees.");
  }
  return result;
}

function parsePins(value: unknown): readonly LocationPin[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Location pins must be an array.");
  const pins = value.map(parseLocationPin);
  if (new Set(pins.map(({ pinId }) => pinId)).size !== pins.length) {
    throw new Error("Location pin IDs must be unique.");
  }
  return pins;
}

function parseGuidedPinIds(
  value: unknown,
  pins: readonly LocationPin[],
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Guided pin IDs must be an array.");
  }
  const pinIds = value.map((pinId) =>
    requiredString(pinId, "Guided pin ID").trim()
  );
  if (new Set(pinIds).size !== pinIds.length) {
    throw new Error("Guided pin IDs must be unique.");
  }
  if (pinIds.some((pinId) => !pins.some((pin) => pin.pinId === pinId))) {
    throw new Error("Each guided pin ID must identify an existing pin.");
  }
  return pinIds;
}

export function parseSupervisionCommand(value: unknown): SupervisionCommand {
  const candidate = record(value, "Supervision command");
  if (candidate.kind === "warp") {
    return {
      kind: "warp",
      latitudeDegrees: latitude(candidate.latitudeDegrees),
      longitudeDegrees: longitude(candidate.longitudeDegrees),
    };
  }
  if (candidate.kind === "setDisplayRadius") {
    const displayRadiusM = finiteNumber(
      candidate.displayRadiusM,
      "Display radius",
    );
    if (displayRadiusM <= 0) {
      throw new Error("Display radius must be positive.");
    }
    return { kind: "setDisplayRadius", displayRadiusM };
  }
  if (candidate.kind === "setPin") {
    return { kind: "setPin", pin: parseLocationPin(candidate.pin) };
  }
  if (candidate.kind === "removePin") {
    return {
      kind: "removePin",
      pinId: requiredString(candidate.pinId, "Pin ID").trim(),
    };
  }
  if (candidate.kind === "setPinGuidance") {
    if (typeof candidate.enabled !== "boolean") {
      throw new Error("Pin guidance enabled must be boolean.");
    }
    return {
      kind: "setPinGuidance",
      pin: parseLocationPin(candidate.pin),
      enabled: candidate.enabled,
    };
  }
  throw new Error("Unknown supervision command.");
}

export function parseSupervisionNavigationState(
  value: unknown,
): SupervisionNavigationState {
  const candidate = record(value, "Navigation state");
  const sequence = finiteNumber(candidate.sequence, "State sequence");
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error("State sequence must be a nonnegative integer.");
  }
  if (
    candidate.mode !== "surface" &&
    candidate.mode !== "orbit" &&
    candidate.mode !== "free"
  ) {
    throw new Error("Unknown navigation mode.");
  }
  if (typeof candidate.focusBody !== "string" || !BODY_IDS.has(candidate.focusBody)) {
    throw new Error("Unknown focus body.");
  }
  const displayRadiusM = finiteNumber(
    candidate.displayRadiusM,
    "Display radius",
  );
  if (displayRadiusM <= 0) throw new Error("Display radius must be positive.");
  const radialMultiplier = finiteNumber(
    candidate.radialMultiplier,
    "Radial multiplier",
  );
  if (radialMultiplier < 0) {
    throw new Error("Radial multiplier must be nonnegative.");
  }
  let headingDegrees: number | null = null;
  if (candidate.headingDegrees !== null) {
    headingDegrees = finiteNumber(candidate.headingDegrees, "Heading");
    if (headingDegrees < 0 || headingDegrees >= 360) {
      throw new Error("Heading must be between 0 and 360 degrees.");
    }
  }
  return {
    sequence,
    mode: candidate.mode,
    focusBody: candidate.focusBody as SolarSystemBodyId,
    latitudeDegrees: latitude(candidate.latitudeDegrees),
    longitudeDegrees: longitude(candidate.longitudeDegrees),
    displayRadiusM,
    radialMultiplier,
    headingDegrees,
  };
}

function parseSession(value: unknown): SupervisionSession {
  const candidate = record(value, "Session");
  const rawLabel = candidate.label;
  if (rawLabel !== null && typeof rawLabel !== "string") {
    throw new Error("Session label must be a string or null.");
  }
  const connectedAtMs = finiteNumber(candidate.connectedAtMs, "Connection time");
  if (connectedAtMs < 0) throw new Error("Connection time must be nonnegative.");
  const pins = parsePins(candidate.pins);
  return {
    sessionId: requiredString(candidate.sessionId, "Session ID"),
    label: rawLabel,
    connectedAtMs,
    state: candidate.state === null
      ? null
      : parseSupervisionNavigationState(candidate.state),
    pins,
    guidedPinIds: parseGuidedPinIds(candidate.guidedPinIds, pins),
  };
}

export function parseSupervisionMessage(value: unknown): SupervisionMessage {
  const decoded = typeof value === "string" ? JSON.parse(value) as unknown : value;
  const candidate = record(decoded, "Supervision message");
  if (candidate.protocolVersion !== SUPERVISION_PROTOCOL_VERSION) {
    throw new Error("Unsupported supervision protocol version.");
  }
  switch (candidate.type) {
    case "headset.hello": {
      const label = candidate.label;
      if (label !== undefined && (typeof label !== "string" || !label.trim())) {
        throw new Error("Session label must be a non-empty string when supplied.");
      }
      const startedAtMs = finiteNumber(candidate.startedAtMs, "Session start time");
      if (startedAtMs < 0) throw new Error("Session start time must be nonnegative.");
      return {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "headset.hello",
        sessionId: requiredString(candidate.sessionId, "Session ID"),
        ...(label === undefined ? {} : { label }),
        startedAtMs,
      };
    }
    case "headset.state": {
      const pins = parsePins(candidate.pins);
      return {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "headset.state",
        state: parseSupervisionNavigationState(candidate.state),
        pins,
        guidedPinIds: parseGuidedPinIds(candidate.guidedPinIds, pins),
      };
    }
    case "supervisor.hello":
      return {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "supervisor.hello",
      };
    case "session.ready":
      return {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "session.ready",
        sessionId: requiredString(candidate.sessionId, "Session ID"),
      };
    case "sessions.snapshot":
      if (!Array.isArray(candidate.sessions)) {
        throw new Error("Session snapshot must contain an array.");
      }
      return {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "sessions.snapshot",
        sessions: candidate.sessions.map(parseSession),
      };
    case "session.updated":
      return {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "session.updated",
        session: parseSession(candidate.session),
      };
    case "session.removed":
      return {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "session.removed",
        sessionId: requiredString(candidate.sessionId, "Session ID"),
      };
    case "session.command":
      return {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "session.command",
        sessionId: requiredString(candidate.sessionId, "Session ID"),
        commandId: requiredString(candidate.commandId, "Command ID"),
        command: parseSupervisionCommand(candidate.command),
      };
    case "command":
      return {
        protocolVersion: SUPERVISION_PROTOCOL_VERSION,
        type: "command",
        commandId: requiredString(candidate.commandId, "Command ID"),
        command: parseSupervisionCommand(candidate.command),
      };
    case "command.result": {
      const commandId = requiredString(candidate.commandId, "Command ID");
      if (candidate.ok === true) {
        const pins = parsePins(candidate.pins);
        return {
          protocolVersion: SUPERVISION_PROTOCOL_VERSION,
          type: "command.result",
          commandId,
          ok: true,
          state: parseSupervisionNavigationState(candidate.state),
          pins,
          guidedPinIds: parseGuidedPinIds(candidate.guidedPinIds, pins),
        };
      }
      if (candidate.ok === false) {
        return {
          protocolVersion: SUPERVISION_PROTOCOL_VERSION,
          type: "command.result",
          commandId,
          ok: false,
          error: requiredString(candidate.error, "Command error"),
        };
      }
      throw new Error("Command result must declare success or failure.");
    }
    default:
      throw new Error("Unknown supervision message type.");
  }
}
