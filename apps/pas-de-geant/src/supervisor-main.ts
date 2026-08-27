import "./supervisor.css";

import { earthMapCoordinates, earthMapPoint } from "./earth-map.js";
import {
  SupervisorClient,
  type SupervisorConnectionStatus,
} from "./supervisor-client.js";
import type {
  CommandResultMessage,
  SupervisionCommand,
  SupervisionSession,
} from "./supervision-protocol.js";

const EARTH_REFERENCE_RADIUS_M = 6_378_137;
const MAP_PERCENT_RECT = { x: 0, y: 0, width: 100, height: 100 } as const;

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}.`);
  return value as T;
};

const relayStatus = element<HTMLParagraphElement>("relay-status");
const sessionCount = element<HTMLSpanElement>("session-count");
const sessionList = element<HTMLDivElement>("session-list");
const selectedTitle = element<HTMLHeadingElement>("selected-title");
const selectedMode = element<HTMLParagraphElement>("selected-mode");
const emptyState = element<HTMLDivElement>("empty-state");
const sessionWorkspace = element<HTMLDivElement>("session-workspace");
const unsupportedNotice = element<HTMLParagraphElement>("unsupported-notice");
const map = element<HTMLDivElement>("earth-map");
const mapImage = element<HTMLImageElement>("earth-map-image");
const currentMarker = element<HTMLSpanElement>("current-marker");
const gazeArrow = element<HTMLSpanElement>("gaze-arrow");
const destinationMarker = element<HTMLSpanElement>("destination-marker");
const currentLatitude = element<HTMLElement>("current-latitude");
const currentLongitude = element<HTMLElement>("current-longitude");
const currentHeading = element<HTMLElement>("current-heading");
const currentRadius = element<HTMLElement>("current-radius");
const groundScale = element<HTMLElement>("ground-scale");
const currentRadial = element<HTMLElement>("current-radial");
const warpForm = element<HTMLFormElement>("warp-form");
const destinationLatitude = element<HTMLInputElement>("destination-latitude");
const destinationLongitude = element<HTMLInputElement>("destination-longitude");
const useCurrentButton = element<HTMLButtonElement>("use-current-button");
const warpButton = element<HTMLButtonElement>("warp-button");
const scaleForm = element<HTMLFormElement>("scale-form");
const displayRadius = element<HTMLInputElement>("display-radius");
const scaleButton = element<HTMLButtonElement>("scale-button");
const commandStatus = element<HTMLParagraphElement>("command-status");

interface PendingCommand {
  readonly sessionId: string;
  readonly description: string;
  readonly kind: SupervisionCommand["kind"];
}

let sessions = new Map<string, SupervisionSession>();
let selectedSessionId: string | undefined;
let selectedSessionCache: SupervisionSession | undefined;
let destinationDraft: { latitudeDegrees: number; longitudeDegrees: number } |
  undefined;
let destinationInitialized = false;
let scaleDraftInitialized = false;
let scaleDraftDirty = false;
const pendingCommands = new Map<string, PendingCommand>();

mapImage.src = new URL("/bluemarble-2048.png", window.location.href).href;

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function sessionName(session: Pick<SupervisionSession, "sessionId" | "label">): string {
  return session.label || shortSessionId(session.sessionId);
}

function formatCoordinate(value: number): string {
  return `${value.toFixed(6)}°`;
}

function formatRadius(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value)} m`;
}

function formatGroundScale(displayRadiusM: number): string {
  const representedMetres = EARTH_REFERENCE_RADIUS_M / displayRadiusM;
  return representedMetres >= 1_000
    ? `1 room m = ${(representedMetres / 1_000).toLocaleString(undefined, { maximumFractionDigits: 3 })} km`
    : `1 room m = ${representedMetres.toLocaleString(undefined, { maximumFractionDigits: 3 })} m`;
}

function elapsedLabel(startedAtMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1_000));
  if (seconds < 60) return `${seconds}s live`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m live` : `${Math.floor(minutes / 60)}h live`;
}

function isSupported(session: SupervisionSession | undefined): boolean {
  return session?.state?.mode === "surface" && session.state.focusBody === "earth";
}

function selectedLiveSession(): SupervisionSession | undefined {
  return selectedSessionId ? sessions.get(selectedSessionId) : undefined;
}

function setMarker(
  marker: HTMLElement,
  latitudeDegrees: number,
  longitudeDegrees: number,
): void {
  const point = earthMapPoint(
    latitudeDegrees,
    longitudeDegrees,
    MAP_PERCENT_RECT,
  );
  marker.hidden = false;
  marker.style.left = `${point.x}%`;
  marker.style.top = `${point.y}%`;
}

function setCommandStatus(
  text: string,
  state: "idle" | "pending" | "acknowledged" | "failed",
): void {
  commandStatus.textContent = text;
  commandStatus.dataset.state = state;
}

function resetDrafts(session: SupervisionSession): void {
  destinationDraft = undefined;
  destinationInitialized = false;
  scaleDraftInitialized = false;
  scaleDraftDirty = false;
  if (session.state) initializeDrafts(session);
}

function initializeDrafts(session: SupervisionSession): void {
  if (!session.state) return;
  if (!destinationInitialized) {
    destinationDraft = {
      latitudeDegrees: session.state.latitudeDegrees,
      longitudeDegrees: session.state.longitudeDegrees,
    };
    destinationLatitude.value = String(session.state.latitudeDegrees);
    destinationLongitude.value = String(session.state.longitudeDegrees);
    destinationInitialized = true;
  }
  if (!scaleDraftInitialized) {
    displayRadius.value = String(session.state.displayRadiusM);
    scaleDraftInitialized = true;
  }
}

function selectSession(session: SupervisionSession): void {
  if (selectedSessionId !== session.sessionId) {
    selectedSessionId = session.sessionId;
    selectedSessionCache = session;
    resetDrafts(session);
    setCommandStatus("Ready.", "idle");
  }
  render();
}

function renderSessionList(): void {
  sessionCount.textContent = `${sessions.size} live`;
  sessionList.replaceChildren();
  if (sessions.size === 0) {
    const empty = document.createElement("p");
    empty.className = "session-empty";
    empty.textContent = "No immersive XR sessions are connected.";
    sessionList.append(empty);
    return;
  }
  for (const session of sessions.values()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-button";
    button.ariaCurrent = String(session.sessionId === selectedSessionId);
    const name = document.createElement("strong");
    name.textContent = sessionName(session);
    const timing = document.createElement("span");
    timing.textContent = `${shortSessionId(session.sessionId)} · ${elapsedLabel(session.connectedAtMs)}`;
    const location = document.createElement("span");
    location.className = "session-location";
    location.textContent = session.state
      ? `${session.state.latitudeDegrees.toFixed(3)}°, ${session.state.longitudeDegrees.toFixed(3)}° · ${formatRadius(session.state.displayRadiusM)}`
      : "Waiting for telemetry";
    button.append(name, timing, location);
    button.addEventListener("click", () => selectSession(session));
    sessionList.append(button);
  }
}

function renderControls(supported: boolean, connected: boolean): void {
  const warpPending = [...pendingCommands.values()].some(
    (pending) => pending.sessionId === selectedSessionId && pending.kind === "warp",
  );
  const scalePending = [...pendingCommands.values()].some(
    (pending) => pending.sessionId === selectedSessionId && pending.kind === "setDisplayRadius",
  );
  destinationLatitude.disabled = !supported || !connected || warpPending;
  destinationLongitude.disabled = !supported || !connected || warpPending;
  useCurrentButton.disabled = !supported || !connected || warpPending;
  warpButton.disabled = !supported || !connected || warpPending;
  displayRadius.disabled = !supported || !connected || scalePending;
  scaleButton.disabled = !supported || !connected || scalePending;
}

function render(): void {
  renderSessionList();
  if (!selectedSessionId) {
    selectedTitle.textContent = "Choose a headset";
    selectedMode.textContent = "No session selected";
    emptyState.hidden = false;
    sessionWorkspace.hidden = true;
    return;
  }

  const liveSession = selectedLiveSession();
  if (liveSession) selectedSessionCache = liveSession;
  const session = liveSession ?? selectedSessionCache;
  if (!session) return;
  selectedTitle.textContent = sessionName(session);
  emptyState.hidden = true;
  sessionWorkspace.hidden = false;
  const connected = liveSession !== undefined;
  selectedMode.textContent = connected
    ? session.state
      ? `${session.state.focusBody} · ${session.state.mode}`
      : "Connected · awaiting telemetry"
    : "Disconnected";

  initializeDrafts(session);
  const supported = connected && isSupported(session);
  unsupportedNotice.hidden = supported;
  if (!connected) {
    unsupportedNotice.textContent = "This headset has disconnected. Select another session explicitly to continue.";
  } else if (!session.state) {
    unsupportedNotice.textContent = "Waiting for the headset’s first navigation update.";
  } else if (!isSupported(session)) {
    unsupportedNotice.textContent = `Controls are unavailable in ${session.state.focusBody} ${session.state.mode} mode. Earth surface mode is supported in this iteration.`;
  }

  const state = session.state;
  if (state) {
    currentLatitude.textContent = formatCoordinate(state.latitudeDegrees);
    currentLongitude.textContent = formatCoordinate(state.longitudeDegrees);
    currentHeading.textContent = state.headingDegrees === null
      ? "Unavailable"
      : `${state.headingDegrees.toFixed(3)}°`;
    currentRadius.textContent = formatRadius(state.displayRadiusM);
    groundScale.textContent = formatGroundScale(state.displayRadiusM);
    currentRadial.textContent = `${state.radialMultiplier.toLocaleString()}×`;
    setMarker(currentMarker, state.latitudeDegrees, state.longitudeDegrees);
    if (state.headingDegrees === null) {
      gazeArrow.hidden = true;
    } else {
      gazeArrow.hidden = false;
      gazeArrow.style.left = currentMarker.style.left;
      gazeArrow.style.top = currentMarker.style.top;
      gazeArrow.style.transform = `translate(-50%, -100%) rotate(${state.headingDegrees}deg)`;
    }
    if (!scaleDraftDirty && !scaleDraftInitialized) {
      displayRadius.value = String(state.displayRadiusM);
    }
  } else {
    currentLatitude.textContent = "—";
    currentLongitude.textContent = "—";
    currentHeading.textContent = "—";
    currentRadius.textContent = "—";
    groundScale.textContent = "—";
    currentRadial.textContent = "—";
    currentMarker.hidden = true;
    gazeArrow.hidden = true;
  }
  if (destinationDraft) {
    setMarker(
      destinationMarker,
      destinationDraft.latitudeDegrees,
      destinationDraft.longitudeDegrees,
    );
  } else {
    destinationMarker.hidden = true;
  }
  renderControls(supported, connected);
}

function updateDestinationFromFields(): void {
  const latitudeDegrees = destinationLatitude.valueAsNumber;
  const longitudeDegrees = destinationLongitude.valueAsNumber;
  if (
    Number.isFinite(latitudeDegrees) &&
    latitudeDegrees >= -90 &&
    latitudeDegrees <= 90 &&
    Number.isFinite(longitudeDegrees) &&
    longitudeDegrees >= -180 &&
    longitudeDegrees <= 180
  ) {
    destinationDraft = { latitudeDegrees, longitudeDegrees };
    destinationInitialized = true;
    setMarker(destinationMarker, latitudeDegrees, longitudeDegrees);
  } else {
    destinationDraft = undefined;
    destinationMarker.hidden = true;
  }
}

map.addEventListener("click", (event) => {
  const session = selectedLiveSession();
  if (!isSupported(session)) return;
  const rect = map.getBoundingClientRect();
  const coordinates = earthMapCoordinates(event.clientX, event.clientY, rect);
  destinationDraft = coordinates;
  destinationInitialized = true;
  destinationLatitude.value = String(coordinates.latitudeDegrees);
  destinationLongitude.value = String(coordinates.longitudeDegrees);
  setMarker(
    destinationMarker,
    coordinates.latitudeDegrees,
    coordinates.longitudeDegrees,
  );
});

destinationLatitude.addEventListener("input", updateDestinationFromFields);
destinationLongitude.addEventListener("input", updateDestinationFromFields);
displayRadius.addEventListener("input", () => {
  scaleDraftDirty = true;
  scaleDraftInitialized = true;
});

useCurrentButton.addEventListener("click", () => {
  const state = selectedLiveSession()?.state;
  if (!state) return;
  destinationDraft = {
    latitudeDegrees: state.latitudeDegrees,
    longitudeDegrees: state.longitudeDegrees,
  };
  destinationInitialized = true;
  destinationLatitude.value = String(state.latitudeDegrees);
  destinationLongitude.value = String(state.longitudeDegrees);
  setMarker(destinationMarker, state.latitudeDegrees, state.longitudeDegrees);
});

function sendCommand(command: SupervisionCommand, description: string): void {
  if (!selectedSessionId) return;
  try {
    const commandId = client.sendCommand(selectedSessionId, command);
    pendingCommands.set(commandId, {
      sessionId: selectedSessionId,
      description,
      kind: command.kind,
    });
    setCommandStatus(`${description} pending…`, "pending");
    render();
  } catch (error) {
    setCommandStatus(
      error instanceof Error ? error.message : "Command could not be sent.",
      "failed",
    );
  }
}

warpForm.addEventListener("submit", (event) => {
  event.preventDefault();
  updateDestinationFromFields();
  if (!destinationDraft || !warpForm.reportValidity()) return;
  sendCommand({ kind: "warp", ...destinationDraft }, "Warp");
});

scaleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const displayRadiusM = displayRadius.valueAsNumber;
  if (!Number.isFinite(displayRadiusM) || displayRadiusM <= 0) {
    displayRadius.setCustomValidity("Enter a positive finite radius.");
    displayRadius.reportValidity();
    displayRadius.setCustomValidity("");
    return;
  }
  sendCommand({ kind: "setDisplayRadius", displayRadiusM }, "Scale change");
});

function handleRelayStatus(status: SupervisorConnectionStatus): void {
  relayStatus.dataset.state = status;
  relayStatus.textContent = status === "connected"
    ? "Relay connected"
    : status === "connecting"
      ? "Connecting…"
      : "Reconnecting…";
  if (status === "reconnecting" && pendingCommands.size > 0) {
    pendingCommands.clear();
    setCommandStatus("Connection lost before acknowledgement.", "failed");
  }
}

function handleCommandResult(result: CommandResultMessage): void {
  const pending = pendingCommands.get(result.commandId);
  if (!pending) return;
  pendingCommands.delete(result.commandId);
  if (result.ok) {
    const session = sessions.get(pending.sessionId);
    if (session) {
      const updated = { ...session, state: result.state };
      sessions.set(pending.sessionId, updated);
      if (pending.sessionId === selectedSessionId) selectedSessionCache = updated;
    }
    if (pending.kind === "setDisplayRadius") {
      displayRadius.value = String(result.state.displayRadiusM);
      scaleDraftDirty = false;
      scaleDraftInitialized = true;
    }
    setCommandStatus(
      `${pending.description} acknowledged at state ${result.state.sequence}.`,
      "acknowledged",
    );
  } else {
    setCommandStatus(`${pending.description} failed: ${result.error}`, "failed");
  }
  render();
}

const client = new SupervisorClient({
  onStatus: handleRelayStatus,
  onSessions(nextSessions) {
    sessions = new Map(nextSessions.map((session) => [session.sessionId, session]));
    const selected = selectedLiveSession();
    if (selected) selectedSessionCache = selected;
    render();
  },
  onCommandResult: handleCommandResult,
});

window.addEventListener("beforeunload", () => client.stop());
window.setInterval(renderSessionList, 1_000);
render();
client.start();
