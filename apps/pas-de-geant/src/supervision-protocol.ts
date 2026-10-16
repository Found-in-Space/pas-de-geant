import {
  type SolarSystemBodyId,
  type NavigationMode,
  validScaleDenominator,
} from "@found-in-space/pas-de-geant/worlds";

import type { AmazonForestOutlineControlState } from "./amazon-forest-outline-control.js";
import {
  parseLocationPin,
  type LocationPin,
} from "./location-pin.js";

import {
  EARTH_TO_GAIA_DURATION_MS,
  EARTH_TO_GAIA_JOURNEY_ID,
  idleJourneyState,
  type EarthToGaiaJourneyPhase,
  type EarthToGaiaJourneyState,
  type EarthToGaiaJourneyStatus,
} from "./earth-to-gaia-journey.js";

export const SUPERVISION_PATH = "/api/supervision";
export const SUPERVISION_SUBPROTOCOL = "pas-de-geant.supervision.v6";
export const SUPERVISION_PROTOCOL_VERSION = 6;

export interface SupervisionStellarState {
  readonly observerJ2000Pc: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly metresPerParsec: number;
  readonly roomTranslationBlend: number;
}

export interface SupervisionNavigationState {
  readonly sequence: number;
  readonly realm: "solar_system" | "stellar";
  readonly mode: NavigationMode;
  readonly focusBody: SolarSystemBodyId;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly scaleDenominator: number;
  readonly terrainMultiplier: number;
  readonly headingDegrees: number | null;
  readonly stellar: SupervisionStellarState | null;
}

export type SupervisionNavigationSnapshot = Omit<
  SupervisionNavigationState,
  "sequence"
>;

export interface SupervisionControlState {
  readonly amazonForestOutlines: AmazonForestOutlineControlState;
  readonly clock: SupervisionSimulationClockState | null;
  readonly eclipse: SupervisionEclipseControlState;
  readonly journey: EarthToGaiaJourneyState;
}

export interface SupervisionSimulationClockState {
  readonly atUtc: string;
  readonly anchorWallUtc: string;
  readonly offsetMs: number;
  readonly scale: number;
}

export interface SupervisionEclipseControlState {
  readonly experience: "none" | "world" | "observatory";
  readonly simulationActive: boolean;
  readonly conesVisible: boolean;
  readonly eventId: string | null;
  readonly eventKind: string | null;
  readonly peakUtc: string | null;
  readonly contactStartUtc: string | null;
  readonly contactEndUtc: string | null;
}

export const DEFAULT_SUPERVISION_CONTROL_STATE: SupervisionControlState = {
  amazonForestOutlines: {
    availableYears: [],
    visibleYears: [],
  },
  clock: null,
  eclipse: {
    experience: "none",
    simulationActive: false,
    conesVisible: false,
    eventId: null,
    eventKind: null,
    peakUtc: null,
    contactStartUtc: null,
    contactEndUtc: null,
  },
  journey: idleJourneyState(),
};

export type SupervisionCommand =
  | {
    readonly kind: "warp";
    readonly latitudeDegrees: number;
    readonly longitudeDegrees: number;
    /** Eased transition duration in seconds. Omit or use zero for an instant warp. */
    readonly time?: number;
  }
  | {
    readonly kind: "setScaleDenominator";
    readonly scaleDenominator: number;
    /** Eased transition duration in seconds. Omit or use zero for an instant change. */
    readonly time?: number;
  }
  | {
    readonly kind: "setTerrainMultiplier";
    readonly terrainMultiplier: number;
  }
  | {
    readonly kind: "setHeading";
    /** Absolute compass heading, in degrees clockwise from geographic north. */
    readonly headingDegrees: number;
    /** Eased transition duration in seconds. Omit or use zero for an instant turn. */
    readonly time?: number;
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
  }
  | {
    readonly kind: "setAmazonForestYearVisibility";
    readonly year: number;
    readonly visible: boolean;
  }
  | {
    readonly kind: "selectEclipseEvent";
    readonly eventId: string;
  }
  | {
    readonly kind: "returnToLiveTime";
  }
  | {
    readonly kind: "setEclipseConeVisibility";
    readonly visible: boolean;
  }
  | {
    readonly kind: "setSimulationClock";
    readonly mode: "realtime";
  }
  | {
    readonly kind: "setSimulationClock";
    readonly mode: "anchored";
    readonly atUtc?: string;
    readonly scale: number;
  }
  | {
    readonly kind: "startJourney";
    readonly journeyId: typeof EARTH_TO_GAIA_JOURNEY_ID;
  }
  | {
    readonly kind: "pauseJourney";
  }
  | {
    readonly kind: "resumeJourney";
  }
  | {
    readonly kind: "stopJourney";
  };

export interface SupervisionSession {
  readonly sessionId: string;
  readonly label: string | null;
  readonly connectedAtMs: number;
  readonly state: SupervisionNavigationState | null;
  readonly controls: SupervisionControlState;
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
  readonly controls: SupervisionControlState;
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
    readonly controls: SupervisionControlState;
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

function optionalTransitionTime(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const result = finiteNumber(value, "Transition time");
  if (result < 0) throw new Error("Transition time must be nonnegative.");
  return result;
}

function requiredBoolean(value: unknown, description: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${description} must be boolean.`);
  }
  return value;
}

function integerYears(value: unknown, description: string): readonly number[] {
  if (!Array.isArray(value)) throw new Error(`${description} must be an array.`);
  const years = value.map((year) => {
    if (typeof year !== "number" || !Number.isInteger(year)) {
      throw new Error(`${description} must contain integer years.`);
    }
    return year;
  });
  if (new Set(years).size !== years.length) {
    throw new Error(`${description} must not contain duplicate years.`);
  }
  return years;
}

function nullableString(value: unknown, description: string): string | null {
  if (value === null) return null;
  return requiredString(value, description);
}

function nullableUtc(value: unknown, description: string): string | null {
  const result = nullableString(value, description);
  if (result === null) return null;
  const timeMs = Date.parse(result);
  if (!Number.isFinite(timeMs)) throw new Error(`${description} must be valid.`);
  return new Date(timeMs).toISOString();
}

function requiredUtc(value: unknown, description: string): string {
  const result = nullableUtc(value, description);
  if (result === null) throw new Error(`${description} is required.`);
  return result;
}

const JOURNEY_STATUSES: ReadonlySet<EarthToGaiaJourneyStatus> = new Set([
  "idle",
  "preparing",
  "running",
  "paused",
  "completed",
  "failed",
]);
const JOURNEY_PHASES: ReadonlySet<EarthToGaiaJourneyPhase> = new Set([
  "idle",
  "preparing",
  "earth",
  "earth_scale",
  "whole_earth",
  "solar_scale",
  "solar_overview",
  "interstellar",
  "stellar_reveal",
  "failed",
]);

function parseJourneyState(value: unknown): EarthToGaiaJourneyState {
  if (value === undefined) return idleJourneyState();
  const candidate = record(value, "Journey state");
  if (candidate.id !== EARTH_TO_GAIA_JOURNEY_ID) {
    throw new Error("Unknown journey ID.");
  }
  if (!JOURNEY_STATUSES.has(candidate.status as EarthToGaiaJourneyStatus)) {
    throw new Error("Unknown journey status.");
  }
  if (!JOURNEY_PHASES.has(candidate.phase as EarthToGaiaJourneyPhase)) {
    throw new Error("Unknown journey phase.");
  }
  const elapsedMs = finiteNumber(candidate.elapsedMs, "Journey elapsed time");
  const durationMs = finiteNumber(candidate.durationMs, "Journey duration");
  const progress = finiteNumber(candidate.progress, "Journey progress");
  if (
    elapsedMs < 0 ||
    elapsedMs > EARTH_TO_GAIA_DURATION_MS ||
    durationMs !== EARTH_TO_GAIA_DURATION_MS
  ) {
    throw new Error("Journey timing is invalid.");
  }
  if (progress < 0 || progress > 1) {
    throw new Error("Journey progress must be between zero and one.");
  }
  const error = candidate.error === null
    ? null
    : requiredString(candidate.error, "Journey error");
  return {
    id: EARTH_TO_GAIA_JOURNEY_ID,
    status: candidate.status as EarthToGaiaJourneyStatus,
    phase: candidate.phase as EarthToGaiaJourneyPhase,
    elapsedMs,
    durationMs: EARTH_TO_GAIA_DURATION_MS,
    progress,
    error,
  };
}

export function parseSupervisionControlState(
  value: unknown,
): SupervisionControlState {
  if (value === undefined) return DEFAULT_SUPERVISION_CONTROL_STATE;
  const candidate = record(value, "Control state");
  const amazonForestOutlines = candidate.amazonForestOutlines === undefined
    ? DEFAULT_SUPERVISION_CONTROL_STATE.amazonForestOutlines
    : record(candidate.amazonForestOutlines, "Amazon forest outline control state");
  const clockCandidate = candidate.clock === null || candidate.clock === undefined
    ? null
    : record(candidate.clock, "Simulation clock state");
  const clock = clockCandidate === null
    ? null
    : {
        atUtc: requiredUtc(
          clockCandidate.atUtc,
          "Simulation clock current UTC",
        ),
        anchorWallUtc: requiredUtc(
          clockCandidate.anchorWallUtc,
          "Simulation clock anchor wall UTC",
        ),
        offsetMs: finiteNumber(
          clockCandidate.offsetMs,
          "Simulation clock offset",
        ),
        scale: finiteNumber(
          clockCandidate.scale,
          "Simulation clock scale",
        ),
      };
  const eclipse = candidate.eclipse === undefined
    ? DEFAULT_SUPERVISION_CONTROL_STATE.eclipse
    : record(candidate.eclipse, "Eclipse control state");
  const eclipseExperience = eclipse.experience;
  if (
    eclipseExperience !== "none" &&
    eclipseExperience !== "world" &&
    eclipseExperience !== "observatory"
  ) {
    throw new Error("Eclipse experience must be none, world, or observatory.");
  }
  const simulationActive = requiredBoolean(
    eclipse.simulationActive,
    "Eclipse simulation active",
  );
  const conesVisible = requiredBoolean(
    eclipse.conesVisible,
    "Eclipse cones visible",
  );
  const eventId = nullableString(eclipse.eventId, "Eclipse event ID");
  const eventKind = nullableString(eclipse.eventKind, "Eclipse event kind");
  const peakUtc = nullableUtc(eclipse.peakUtc, "Eclipse peak UTC");
  const contactStartUtc = nullableUtc(
    eclipse.contactStartUtc,
    "Eclipse contact start UTC",
  );
  const contactEndUtc = nullableUtc(
    eclipse.contactEndUtc,
    "Eclipse contact end UTC",
  );
  if (
    simulationActive &&
    (!eventId || !eventKind || !peakUtc || !contactStartUtc ||
      !contactEndUtc || !clock)
  ) {
    throw new Error(
      "An active eclipse simulation requires event and clock details.",
    );
  }
  if (simulationActive && eclipseExperience === "none") {
    throw new Error("An active eclipse simulation requires an eclipse experience.");
  }
  if (eclipseExperience === "observatory" && !simulationActive) {
    throw new Error("The Eclipse Observatory requires an active simulation.");
  }
  if (
    !simulationActive &&
    (eventId !== null || eventKind !== null || peakUtc !== null ||
      contactStartUtc !== null || contactEndUtc !== null)
  ) {
    throw new Error("Inactive eclipse telemetry cannot include an event timeline.");
  }
  if (eclipseExperience === "none" && conesVisible) {
    throw new Error("A session without eclipse support cannot report eclipse state.");
  }
  if (
    contactStartUtc && contactEndUtc &&
    Date.parse(contactEndUtc) <= Date.parse(contactStartUtc)
  ) {
    throw new Error("Eclipse contact end UTC must follow contact start UTC.");
  }
  const availableForestYears = integerYears(
    amazonForestOutlines.availableYears,
    "Available Amazon forest outline years",
  );
  const visibleForestYears = integerYears(
    amazonForestOutlines.visibleYears,
    "Visible Amazon forest outline years",
  );
  if (visibleForestYears.some((year) => !availableForestYears.includes(year))) {
    throw new Error("Visible Amazon forest outline years must be available.");
  }
  return {
    amazonForestOutlines: {
      availableYears: availableForestYears,
      visibleYears: visibleForestYears,
    },
    clock,
    eclipse: {
      experience: eclipseExperience,
      simulationActive,
      conesVisible,
      eventId,
      eventKind,
      peakUtc,
      contactStartUtc,
      contactEndUtc,
    },
    journey: parseJourneyState(candidate.journey),
  };
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
  if ("displayRadiusM" in candidate) {
    throw new Error(
      "displayRadiusM is not supported by protocol v6; use scaleDenominator.",
    );
  }
  if ("radialMultiplier" in candidate) {
    throw new Error(
      "radialMultiplier is not supported by protocol v6; use terrainMultiplier.",
    );
  }
  if (candidate.kind === "warp") {
    const time = optionalTransitionTime(candidate.time);
    return {
      kind: "warp",
      latitudeDegrees: latitude(candidate.latitudeDegrees),
      longitudeDegrees: longitude(candidate.longitudeDegrees),
      ...(time === undefined ? {} : { time }),
    };
  }
  if (candidate.kind === "setScaleDenominator") {
    const scaleDenominator = validScaleDenominator(finiteNumber(
      candidate.scaleDenominator,
      "Scale denominator",
    ));
    const time = optionalTransitionTime(candidate.time);
    return {
      kind: "setScaleDenominator",
      scaleDenominator,
      ...(time === undefined ? {} : { time }),
    };
  }
  if (candidate.kind === "setTerrainMultiplier") {
    const terrainMultiplier = finiteNumber(
      candidate.terrainMultiplier,
      "Terrain multiplier",
    );
    if (terrainMultiplier < 0) {
      throw new Error("Terrain multiplier must be nonnegative.");
    }
    return { kind: "setTerrainMultiplier", terrainMultiplier };
  }
  if (candidate.kind === "setHeading") {
    const time = optionalTransitionTime(candidate.time);
    return {
      kind: "setHeading",
      headingDegrees: finiteNumber(candidate.headingDegrees, "Heading"),
      ...(time === undefined ? {} : { time }),
    };
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
  if (candidate.kind === "setAmazonForestYearVisibility") {
    if (typeof candidate.year !== "number" || !Number.isInteger(candidate.year)) {
      throw new Error("Amazon forest outline year must be an integer.");
    }
    return {
      kind: "setAmazonForestYearVisibility",
      year: candidate.year,
      visible: requiredBoolean(
        candidate.visible,
        "Amazon forest outline visibility",
      ),
    };
  }
  if (candidate.kind === "selectEclipseEvent") {
    const eventId = requiredString(candidate.eventId, "Eclipse event ID").trim();
    if (!eventId) throw new Error("Eclipse event ID is required.");
    return { kind: "selectEclipseEvent", eventId };
  }
  if (candidate.kind === "returnToLiveTime") {
    return { kind: "returnToLiveTime" };
  }
  if (candidate.kind === "setEclipseConeVisibility") {
    return {
      kind: "setEclipseConeVisibility",
      visible: requiredBoolean(candidate.visible, "Eclipse cones visible"),
    };
  }
  if (candidate.kind === "setSimulationClock") {
    if (candidate.mode === "realtime") {
      return { kind: "setSimulationClock", mode: "realtime" };
    }
    if (candidate.mode !== "anchored") {
      throw new Error("Simulation clock mode must be realtime or anchored.");
    }
    const atUtc = candidate.atUtc === undefined
      ? undefined
      : requiredString(candidate.atUtc, "Simulation clock UTC");
    const atMs = atUtc === undefined ? undefined : Date.parse(atUtc);
    if (atMs !== undefined && !Number.isFinite(atMs)) {
      throw new Error("Simulation clock UTC must be valid.");
    }
    return {
      kind: "setSimulationClock",
      mode: "anchored",
      ...(atMs === undefined
        ? {}
        : { atUtc: new Date(atMs).toISOString() }),
      scale: finiteNumber(candidate.scale, "Simulation clock scale"),
    };
  }
  if (candidate.kind === "startJourney") {
    if (candidate.journeyId !== EARTH_TO_GAIA_JOURNEY_ID) {
      throw new Error("Unknown journey ID.");
    }
    return {
      kind: "startJourney",
      journeyId: EARTH_TO_GAIA_JOURNEY_ID,
    };
  }
  if (candidate.kind === "pauseJourney") return { kind: "pauseJourney" };
  if (candidate.kind === "resumeJourney") return { kind: "resumeJourney" };
  if (candidate.kind === "stopJourney") return { kind: "stopJourney" };
  throw new Error("Unknown supervision command.");
}

export function parseSupervisionNavigationState(
  value: unknown,
): SupervisionNavigationState {
  const candidate = record(value, "Navigation state");
  if ("displayRadiusM" in candidate) {
    throw new Error(
      "displayRadiusM is not supported by protocol v6; use scaleDenominator.",
    );
  }
  if ("radialMultiplier" in candidate) {
    throw new Error(
      "radialMultiplier is not supported by protocol v6; use terrainMultiplier.",
    );
  }
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
  if (candidate.realm !== "solar_system" && candidate.realm !== "stellar") {
    throw new Error("Unknown navigation realm.");
  }
  if (typeof candidate.focusBody !== "string" || !BODY_IDS.has(candidate.focusBody)) {
    throw new Error("Unknown focus body.");
  }
  const scaleDenominator = validScaleDenominator(finiteNumber(
    candidate.scaleDenominator,
    "Scale denominator",
  ));
  const terrainMultiplier = finiteNumber(
    candidate.terrainMultiplier,
    "Terrain multiplier",
  );
  if (terrainMultiplier < 0) {
    throw new Error("Terrain multiplier must be nonnegative.");
  }
  let headingDegrees: number | null = null;
  if (candidate.headingDegrees !== null) {
    headingDegrees = finiteNumber(candidate.headingDegrees, "Heading");
    if (headingDegrees < 0 || headingDegrees >= 360) {
      throw new Error("Heading must be between 0 and 360 degrees.");
    }
  }
  let stellar: SupervisionStellarState | null = null;
  if (candidate.stellar !== null && candidate.stellar !== undefined) {
    const stellarCandidate = record(candidate.stellar, "Stellar telemetry");
    const observer = record(
      stellarCandidate.observerJ2000Pc,
      "Stellar observer",
    );
    const metresPerParsec = finiteNumber(
      stellarCandidate.metresPerParsec,
      "Stellar metres per parsec",
    );
    const roomTranslationBlend = finiteNumber(
      stellarCandidate.roomTranslationBlend,
      "Stellar room-translation blend",
    );
    if (metresPerParsec <= 0) {
      throw new Error("Stellar metres per parsec must be positive.");
    }
    if (roomTranslationBlend < 0 || roomTranslationBlend > 1) {
      throw new Error(
        "Stellar room-translation blend must be between zero and one.",
      );
    }
    stellar = {
      observerJ2000Pc: {
        x: finiteNumber(observer.x, "Stellar observer x"),
        y: finiteNumber(observer.y, "Stellar observer y"),
        z: finiteNumber(observer.z, "Stellar observer z"),
      },
      metresPerParsec,
      roomTranslationBlend,
    };
  }
  if (candidate.realm === "stellar" && stellar === null) {
    throw new Error("The stellar realm requires stellar telemetry.");
  }
  return {
    sequence,
    realm: candidate.realm,
    mode: candidate.mode,
    focusBody: candidate.focusBody as SolarSystemBodyId,
    latitudeDegrees: latitude(candidate.latitudeDegrees),
    longitudeDegrees: longitude(candidate.longitudeDegrees),
    scaleDenominator,
    terrainMultiplier,
    headingDegrees,
    stellar,
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
    controls: parseSupervisionControlState(candidate.controls),
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
        controls: parseSupervisionControlState(candidate.controls),
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
          controls: parseSupervisionControlState(candidate.controls),
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
