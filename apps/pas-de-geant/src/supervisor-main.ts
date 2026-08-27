import "leaflet/dist/leaflet.css";
import "./supervisor.css";

import * as L from "leaflet";
import { normalizeLongitudeDegrees } from "./earth-map.js";
import {
  formatLocationPinDistance,
  greatCircleDistanceKm,
  type LocationPin,
} from "./location-pin.js";
import {
  SupervisorClient,
  type SupervisorConnectionStatus,
} from "./supervisor-client.js";
import { SupervisorSavedLocationStore } from "./supervisor-saved-locations.js";
import {
  UI_SCALE_TRANSITION_SECONDS,
  uiWarpTransitionTime,
} from "./supervisor-transition-timing.js";
import type {
  CommandResultMessage,
  SupervisionCommand,
  SupervisionSession,
} from "./supervision-protocol.js";

const INITIAL_MAP_CENTER: L.LatLngExpression = [20, 0];
const INITIAL_MAP_ZOOM = 2;
const SESSION_MAP_ZOOM = 8;

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
const mapElement = element<HTMLDivElement>("earth-map");
const centerMapButton = element<HTMLButtonElement>("center-map-button");
const warpForm = element<HTMLFormElement>("warp-form");
const destinationLatitude = element<HTMLInputElement>("destination-latitude");
const destinationLongitude = element<HTMLInputElement>("destination-longitude");
const useCurrentButton = element<HTMLButtonElement>("use-current-button");
const warpButton = element<HTMLButtonElement>("warp-button");
const addPinButton = element<HTMLButtonElement>("add-pin-button");
const scaleForm = element<HTMLFormElement>("scale-form");
const displayRadius = element<HTMLInputElement>("display-radius");
const scaleButton = element<HTMLButtonElement>("scale-button");
const commandStatus = element<HTMLParagraphElement>("command-status");
const savedLocationCount = element<HTMLSpanElement>("saved-location-count");
const savedLocationList = element<HTMLDivElement>("saved-location-list");

interface PendingCommand {
  readonly sessionId: string;
  readonly description: string;
  readonly kind: SupervisionCommand["kind"];
  readonly command: SupervisionCommand;
}

interface SessionListEntry {
  readonly button: HTMLButtonElement;
  readonly name: HTMLElement;
  readonly timing: HTMLElement;
  readonly location: HTMLElement;
}

interface SavedLocationListEntry {
  readonly row: HTMLDivElement;
  readonly name: HTMLElement;
  readonly metadata: HTMLElement;
  readonly source: HTMLElement;
  readonly warp: HTMLButtonElement;
  readonly visible: HTMLInputElement;
  readonly guide: HTMLInputElement;
  readonly more: HTMLButtonElement;
  readonly rename: HTMLInputElement;
  readonly remove: HTMLButtonElement;
}

let sessions = new Map<string, SupervisionSession>();
let selectedSessionId: string | undefined;
let selectedSessionCache: SupervisionSession | undefined;
let destinationDraft: { latitudeDegrees: number; longitudeDegrees: number } |
  undefined;
let destinationInitialized = false;
let scaleDraftInitialized = false;
let scaleDraftDirty = false;
let mapCenteredSessionId: string | undefined;
const pendingCommands = new Map<string, PendingCommand>();
const sessionListEntries = new Map<string, SessionListEntry>();
const savedLocationListEntries = new Map<string, SavedLocationListEntry>();
const pinMapMarkers = new Map<string, { marker: L.Marker; signature: string }>();
const savedLocationStore = new SupervisorSavedLocationStore(window.localStorage);
let savedLocations = new Map(
  savedLocationStore.snapshot().map((pin) => [pin.pinId, pin]),
);

const leafletMap = L.map(mapElement, {
  center: INITIAL_MAP_CENTER,
  zoom: INITIAL_MAP_ZOOM,
  minZoom: 2,
  worldCopyJump: true,
  zoomControl: true,
});

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(leafletMap);
L.control.scale({ imperial: false, maxWidth: 120 }).addTo(leafletMap);

let currentPositionMarker: L.CircleMarker | undefined;
let destinationMapMarker: L.CircleMarker | undefined;
let gazeDirectionMarker: L.Marker | undefined;

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function sessionName(session: Pick<SupervisionSession, "sessionId" | "label">): string {
  return session.label || shortSessionId(session.sessionId);
}

function formatRadius(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value)} m`;
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

function showCurrentPosition(
  latitudeDegrees: number,
  longitudeDegrees: number,
  headingDegrees: number | null,
): void {
  const latLng = L.latLng(latitudeDegrees, longitudeDegrees);
  if (!currentPositionMarker) {
    currentPositionMarker = L.circleMarker(latLng, {
      radius: 6,
      color: "#e9ffff",
      weight: 2,
      fillColor: "#52e3d2",
      fillOpacity: 1,
      interactive: false,
      pane: "markerPane",
    }).addTo(leafletMap);
  } else {
    currentPositionMarker.setLatLng(latLng);
    if (!leafletMap.hasLayer(currentPositionMarker)) currentPositionMarker.addTo(leafletMap);
  }

  if (headingDegrees === null) {
    if (gazeDirectionMarker) leafletMap.removeLayer(gazeDirectionMarker);
    return;
  }
  if (!gazeDirectionMarker) {
    gazeDirectionMarker = L.marker(latLng, {
      interactive: false,
      keyboard: false,
      zIndexOffset: 200,
      icon: L.divIcon({
        className: "gaze-direction-icon",
        html: '<span class="leaflet-gaze-arrow"></span>',
        iconAnchor: [20, 20],
        iconSize: [40, 40],
      }),
    }).addTo(leafletMap);
  } else {
    gazeDirectionMarker.setLatLng(latLng);
    if (!leafletMap.hasLayer(gazeDirectionMarker)) gazeDirectionMarker.addTo(leafletMap);
  }
  const arrow = gazeDirectionMarker.getElement()
    ?.querySelector<HTMLElement>(".leaflet-gaze-arrow");
  if (arrow) arrow.style.transform = `rotate(${headingDegrees}deg)`;
}

function hideCurrentPosition(): void {
  if (currentPositionMarker) leafletMap.removeLayer(currentPositionMarker);
  if (gazeDirectionMarker) leafletMap.removeLayer(gazeDirectionMarker);
}

function showDestination(latitudeDegrees: number, longitudeDegrees: number): void {
  const latLng = L.latLng(latitudeDegrees, longitudeDegrees);
  if (!destinationMapMarker) {
    destinationMapMarker = L.circleMarker(latLng, {
      radius: 8,
      color: "#ffe0a3",
      weight: 2,
      fillColor: "#071015",
      fillOpacity: 0.7,
      bubblingMouseEvents: true,
    }).addTo(leafletMap);
  } else {
    destinationMapMarker.setLatLng(latLng);
    if (!leafletMap.hasLayer(destinationMapMarker)) destinationMapMarker.addTo(leafletMap);
  }
}

function hideDestination(): void {
  if (destinationMapMarker) leafletMap.removeLayer(destinationMapMarker);
}

function centerMapOnSession(session: SupervisionSession, setSessionZoom: boolean): void {
  if (!session.state) return;
  const center: L.LatLngExpression = [
    session.state.latitudeDegrees,
    session.state.longitudeDegrees,
  ];
  if (setSessionZoom) leafletMap.setView(center, SESSION_MAP_ZOOM, { animate: false });
  else leafletMap.panTo(center);
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

function setDestinationFieldValues(
  latitudeDegrees: number,
  longitudeDegrees: number,
): void {
  destinationLatitude.value = latitudeDegrees.toFixed(6);
  destinationLongitude.value = longitudeDegrees.toFixed(6);
}

function initializeDrafts(session: SupervisionSession): void {
  if (!session.state) return;
  if (!destinationInitialized) {
    destinationDraft = {
      latitudeDegrees: session.state.latitudeDegrees,
      longitudeDegrees: session.state.longitudeDegrees,
    };
    setDestinationFieldValues(
      session.state.latitudeDegrees,
      session.state.longitudeDegrees,
    );
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
    mapCenteredSessionId = undefined;
    resetDrafts(session);
    setCommandStatus("Ready.", "idle");
  }
  render();
}

function createSessionListEntry(sessionId: string): SessionListEntry {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-button";
  const heading = document.createElement("span");
  heading.className = "session-button-heading";
  const name = document.createElement("strong");
  const timing = document.createElement("span");
  heading.append(name, timing);
  const location = document.createElement("span");
  location.className = "session-location";
  button.append(heading, location);
  button.addEventListener("click", () => {
    const session = sessions.get(sessionId);
    if (session) selectSession(session);
  });
  return { button, name, timing, location };
}

function renderSessionList(): void {
  sessionCount.textContent = `${sessions.size} live`;
  if (sessions.size === 0) {
    sessionListEntries.clear();
    const empty = document.createElement("p");
    empty.className = "session-empty";
    empty.textContent = "No immersive XR sessions are connected.";
    sessionList.replaceChildren(empty);
    return;
  }

  sessionList.querySelector(".session-empty")?.remove();
  for (const [sessionId, entry] of sessionListEntries) {
    if (sessions.has(sessionId)) continue;
    entry.button.remove();
    sessionListEntries.delete(sessionId);
  }

  let insertionPoint = sessionList.firstElementChild;
  for (const session of sessions.values()) {
    let entry = sessionListEntries.get(session.sessionId);
    if (!entry) {
      entry = createSessionListEntry(session.sessionId);
      sessionListEntries.set(session.sessionId, entry);
    }
    entry.button.ariaCurrent = String(session.sessionId === selectedSessionId);
    entry.name.textContent = sessionName(session);
    entry.timing.textContent = elapsedLabel(session.connectedAtMs);
    entry.location.textContent = session.state
      ? `${session.state.latitudeDegrees.toFixed(3)}°, ${session.state.longitudeDegrees.toFixed(3)}° · ${formatRadius(session.state.displayRadiusM)} · ${
        session.state.headingDegrees === null
          ? "—"
          : `${Math.round(session.state.headingDegrees) % 360}°`
      }`
      : "Waiting for telemetry";
    if (entry.button !== insertionPoint) {
      sessionList.insertBefore(entry.button, insertionPoint);
    }
    insertionPoint = entry.button.nextElementSibling;
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
  centerMapButton.disabled = !supported || !connected;
  warpButton.disabled = !supported || !connected || warpPending;
  addPinButton.disabled = !supported || !connected;
  displayRadius.disabled = !supported || !connected || scalePending;
  scaleButton.disabled = !supported || !connected || scalePending;
}

function showPinDestination(pin: LocationPin): void {
  destinationDraft = {
    latitudeDegrees: pin.latitudeDegrees,
    longitudeDegrees: pin.longitudeDegrees,
  };
  destinationInitialized = true;
  setDestinationFieldValues(pin.latitudeDegrees, pin.longitudeDegrees);
  showDestination(pin.latitudeDegrees, pin.longitudeDegrees);
}

function saveLocationPin(pin: LocationPin): boolean {
  try {
    savedLocations = new Map(
      savedLocationStore.set(pin).map((savedPin) => [savedPin.pinId, savedPin]),
    );
    setCommandStatus(`${pin.label} saved in this browser.`, "acknowledged");
    render();
    return true;
  } catch (error) {
    setCommandStatus(
      error instanceof Error ? error.message : "Location could not be saved.",
      "failed",
    );
    return false;
  }
}

function createPinMapMarker(pin: LocationPin, guided: boolean): L.Marker {
  const marker = L.marker([pin.latitudeDegrees, pin.longitudeDegrees], {
    title: pin.label,
    alt: `${pin.label}${guided ? ", guidance enabled" : ""}`,
    icon: L.divIcon({
      className: "location-pin-icon",
      html: `<span class="leaflet-location-pin" data-active="${String(guided)}"></span>`,
      iconAnchor: [10, 25],
      iconSize: [20, 28],
      tooltipAnchor: [0, -23],
    }),
  });
  const tooltip = document.createElement("span");
  tooltip.textContent = `${pin.label}${guided ? " · guiding" : ""}`;
  marker.bindTooltip(tooltip, { direction: "top", opacity: 0.96 });
  marker.on("click", () => showPinDestination(pin));
  return marker;
}

function syncPinMapMarkers(session: SupervisionSession): void {
  const retainedPinIds = new Set<string>();
  for (const pin of session.pins) {
    retainedPinIds.add(pin.pinId);
    const guided = session.guidedPinIds.includes(pin.pinId);
    const signature = [
      pin.latitudeDegrees,
      pin.longitudeDegrees,
      pin.label,
      guided,
    ].join("\u0000");
    const existing = pinMapMarkers.get(pin.pinId);
    if (existing?.signature === signature) continue;
    if (existing) leafletMap.removeLayer(existing.marker);
    const marker = createPinMapMarker(pin, guided).addTo(leafletMap);
    pinMapMarkers.set(pin.pinId, { marker, signature });
  }
  for (const [pinId, entry] of pinMapMarkers) {
    if (retainedPinIds.has(pinId)) continue;
    leafletMap.removeLayer(entry.marker);
    pinMapMarkers.delete(pinId);
  }
}

function selectedLocation(pinId: string): LocationPin | undefined {
  return savedLocations.get(pinId) ??
    (selectedLiveSession() ?? selectedSessionCache)
      ?.pins.find((pin) => pin.pinId === pinId);
}

function combinedLocations(session: SupervisionSession): Map<string, LocationPin> {
  const locations = new Map(savedLocations);
  for (const pin of session.pins) {
    if (!locations.has(pin.pinId)) locations.set(pin.pinId, pin);
  }
  return locations;
}

function nextDefaultPinLabel(): string {
  const usedLabels = new Set(
    [
      ...savedLocations.values(),
      ...((selectedLiveSession() ?? selectedSessionCache)?.pins ?? []),
    ].map((pin) => pin.label),
  );
  let number = 1;
  while (usedLabels.has(`Pin ${number}`)) number += 1;
  return `Pin ${number}`;
}

function commandLocationId(command: SupervisionCommand): string | undefined {
  if (command.kind === "setPin" || command.kind === "setPinGuidance") {
    return command.pin.pinId;
  }
  return command.kind === "removePin" ? command.pinId : undefined;
}

function pendingLocationCommand(
  pinId: string,
  kinds: readonly SupervisionCommand["kind"][],
): PendingCommand | undefined {
  return [...pendingCommands.values()].find(
    (pending) => pending.sessionId === selectedSessionId &&
      kinds.includes(pending.kind) &&
      commandLocationId(pending.command) === pinId,
  );
}

function removeLocation(pin: LocationPin): void {
  const stored = savedLocations.has(pin.pinId);
  if (stored) {
    try {
      savedLocations = new Map(
        savedLocationStore.remove(pin.pinId)
          .map((savedPin) => [savedPin.pinId, savedPin]),
      );
    } catch (error) {
      setCommandStatus(
        error instanceof Error ? error.message : "Location could not be removed.",
        "failed",
      );
      return;
    }
  }
  const session = selectedLiveSession();
  const visible = session?.pins.some(({ pinId }) => pinId === pin.pinId) ?? false;
  if (visible && session && isSupported(session)) {
    sendCommand({ kind: "removePin", pinId: pin.pinId }, "Remove " + pin.label);
    return;
  }
  if (!stored) {
    setCommandStatus("This session-only location cannot be removed while disconnected.", "failed");
  } else {
    setCommandStatus(pin.label + " removed.", "acknowledged");
  }
  render();
}

function renameLocation(pin: LocationPin, label: string): void {
  const renamed = { ...pin, label };
  if (!saveLocationPin(renamed)) return;
  const session = selectedLiveSession();
  if (
    session &&
    isSupported(session) &&
    session.pins.some(({ pinId }) => pinId === pin.pinId)
  ) {
    sendCommand({ kind: "setPin", pin: renamed }, "Rename " + pin.label);
  }
}

function createSavedLocationListEntry(pinId: string): SavedLocationListEntry {
  const row = document.createElement("div");
  row.className = "saved-location-row";
  const copy = document.createElement("div");
  copy.className = "saved-location-copy";
  const name = document.createElement("strong");
  copy.append(name);
  copy.addEventListener("click", () => {
    const pin = selectedLocation(pinId);
    if (pin) showPinDestination(pin);
  });

  const warp = document.createElement("button");
  warp.type = "button";
  warp.className = "location-row-button";
  warp.textContent = "Warp";
  warp.addEventListener("click", () => {
    const pin = selectedLocation(pinId);
    const state = selectedLiveSession()?.state;
    if (!pin || !state) return;
    showPinDestination(pin);
    sendCommand({
      kind: "warp",
      latitudeDegrees: pin.latitudeDegrees,
      longitudeDegrees: pin.longitudeDegrees,
      time: uiWarpTransitionTime(state, pin),
    }, `Warp to ${pin.label}`);
  });

  const visibleLabel = document.createElement("label");
  visibleLabel.className = "location-toggle";
  const visible = document.createElement("input");
  visible.type = "checkbox";
  const visibleText = document.createElement("span");
  visibleText.textContent = "Visible";
  visibleLabel.append(visible, visibleText);
  visible.addEventListener("change", () => {
    const pin = selectedLocation(pinId);
    if (!pin) return;
    sendCommand(
      visible.checked
        ? { kind: "setPin", pin }
        : { kind: "removePin", pinId },
      (visible.checked ? "Show " : "Hide ") + pin.label,
    );
  });

  const guideLabel = document.createElement("label");
  guideLabel.className = "location-toggle";
  const guide = document.createElement("input");
  guide.type = "checkbox";
  const guideText = document.createElement("span");
  guideText.textContent = "Guide";
  guideLabel.append(guide, guideText);
  guide.addEventListener("change", () => {
    const pin = selectedLocation(pinId);
    if (pin) sendCommand({
      kind: "setPinGuidance",
      pin,
      enabled: guide.checked,
    }, (guide.checked ? "Guide to " : "Stop guiding to ") + pin.label);
  });

  const more = document.createElement("button");
  more.type = "button";
  more.className = "location-more-button";
  more.textContent = "More";
  more.ariaExpanded = "false";
  const panel = document.createElement("div");
  panel.className = "location-more-panel";
  panel.hidden = true;
  more.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    more.ariaExpanded = String(!panel.hidden);
  });
  const metadata = document.createElement("span");
  metadata.className = "saved-location-metadata";
  const source = document.createElement("span");
  source.className = "saved-location-source";
  const renameForm = document.createElement("form");
  renameForm.className = "location-rename-form";
  const rename = document.createElement("input");
  rename.type = "text";
  rename.required = true;
  rename.setAttribute("aria-label", "Location name");
  const renameButton = document.createElement("button");
  renameButton.type = "submit";
  renameButton.textContent = "Rename";
  renameForm.append(rename, renameButton);
  renameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const pin = selectedLocation(pinId);
    const label = rename.value.trim();
    if (!pin || !label) {
      rename.setCustomValidity("Enter a location name.");
      rename.reportValidity();
      rename.setCustomValidity("");
      return;
    }
    panel.hidden = true;
    more.ariaExpanded = "false";
    renameLocation(pin, label);
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "delete-saved-location";
  remove.textContent = "Remove location";
  remove.addEventListener("click", () => {
    const pin = selectedLocation(pinId);
    if (pin) removeLocation(pin);
  });
  panel.append(metadata, source, renameForm, remove);
  row.append(copy, warp, visibleLabel, guideLabel, more, panel);
  return {
    row,
    name,
    metadata,
    source,
    warp,
    visible,
    guide,
    more,
    rename,
    remove,
  };
}

function renderSavedLocations(
  session: SupervisionSession,
  supported: boolean,
  connected: boolean,
): void {
  const locations = combinedLocations(session);
  savedLocationCount.textContent = locations.size + " " +
    (locations.size === 1 ? "location" : "locations");
  if (locations.size === 0) {
    savedLocationListEntries.clear();
    const empty = document.createElement("p");
    empty.className = "saved-location-empty";
    empty.textContent = "No locations saved or visible in this headset.";
    savedLocationList.replaceChildren(empty);
    return;
  }

  savedLocationList.querySelector(".saved-location-empty")?.remove();
  for (const [pinId, entry] of savedLocationListEntries) {
    if (locations.has(pinId)) continue;
    entry.row.remove();
    savedLocationListEntries.delete(pinId);
  }
  const warpPending = [...pendingCommands.values()].some(
    (pending) => pending.sessionId === selectedSessionId && pending.kind === "warp",
  );
  let insertionPoint = savedLocationList.firstElementChild;
  for (const pin of locations.values()) {
    let entry = savedLocationListEntries.get(pin.pinId);
    if (!entry) {
      entry = createSavedLocationListEntry(pin.pinId);
      savedLocationListEntries.set(pin.pinId, entry);
    }
    entry.name.textContent = pin.label;
    entry.metadata.textContent =
      `${pin.latitudeDegrees.toFixed(6)}°, ${pin.longitudeDegrees.toFixed(6)}°` +
      (session.state
        ? ` · ${formatLocationPinDistance(greatCircleDistanceKm(
          session.state.latitudeDegrees,
          session.state.longitudeDegrees,
          pin.latitudeDegrees,
          pin.longitudeDegrees,
        ))}`
        : "");
    const stored = savedLocations.has(pin.pinId);
    const visiblePin = session.pins.find(({ pinId }) => pinId === pin.pinId);
    const visible = visiblePin !== undefined;
    const viewPending = pendingLocationCommand(pin.pinId, ["setPin", "removePin"]);
    const guidePending = pendingLocationCommand(pin.pinId, ["setPinGuidance"]);
    const pendingGuidance = guidePending?.command.kind === "setPinGuidance"
      ? guidePending.command.enabled
      : undefined;
    const guided = session.guidedPinIds.includes(pin.pinId);
    entry.source.textContent = stored
      ? visible ? "Saved · visible" : "Saved"
      : "Session only";
    entry.warp.disabled = !supported || !connected || warpPending;
    const pendingVisibility = viewPending?.command.kind === "setPin"
      ? true
      : viewPending?.command.kind === "removePin"
        ? false
        : undefined;
    entry.visible.checked = pendingVisibility ?? visible;
    entry.visible.disabled = !supported || !connected || viewPending !== undefined;
    entry.guide.checked = pendingGuidance ?? guided;
    entry.guide.disabled = !supported || !connected ||
      guidePending !== undefined || viewPending !== undefined;
    entry.remove.disabled = (!stored && (!supported || !connected)) ||
      viewPending !== undefined || guidePending !== undefined;
    if (document.activeElement !== entry.rename) entry.rename.value = pin.label;
    if (entry.row !== insertionPoint) {
      savedLocationList.insertBefore(entry.row, insertionPoint);
    }
    insertionPoint = entry.row.nextElementSibling;
  }
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
    showCurrentPosition(
      state.latitudeDegrees,
      state.longitudeDegrees,
      state.headingDegrees,
    );
    if (!scaleDraftDirty && !scaleDraftInitialized) {
      displayRadius.value = String(state.displayRadiusM);
    }
    if (mapCenteredSessionId !== session.sessionId) {
      mapCenteredSessionId = session.sessionId;
      window.requestAnimationFrame(() => {
        leafletMap.invalidateSize();
        centerMapOnSession(session, true);
      });
    }
  } else {
    hideCurrentPosition();
  }
  if (destinationDraft) {
    showDestination(
      destinationDraft.latitudeDegrees,
      destinationDraft.longitudeDegrees,
    );
  } else {
    hideDestination();
  }
  syncPinMapMarkers(session);
  renderSavedLocations(session, supported, connected);
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
    showDestination(latitudeDegrees, longitudeDegrees);
  } else {
    destinationDraft = undefined;
    hideDestination();
  }
}

leafletMap.on("click", (event: L.LeafletMouseEvent) => {
  const session = selectedLiveSession();
  if (!isSupported(session)) return;
  destinationDraft = {
    latitudeDegrees: event.latlng.lat,
    longitudeDegrees: normalizeLongitudeDegrees(event.latlng.lng),
  };
  destinationInitialized = true;
  setDestinationFieldValues(
    destinationDraft.latitudeDegrees,
    destinationDraft.longitudeDegrees,
  );
  showDestination(
    destinationDraft.latitudeDegrees,
    destinationDraft.longitudeDegrees,
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
  setDestinationFieldValues(state.latitudeDegrees, state.longitudeDegrees);
  showDestination(state.latitudeDegrees, state.longitudeDegrees);
});

centerMapButton.addEventListener("click", () => {
  const session = selectedLiveSession();
  if (!session || !isSupported(session)) return;
  centerMapOnSession(session, false);
});

function sendCommand(command: SupervisionCommand, description: string): void {
  if (!selectedSessionId) return;
  try {
    const commandId = client.sendCommand(selectedSessionId, command);
    pendingCommands.set(commandId, {
      sessionId: selectedSessionId,
      description,
      kind: command.kind,
      command,
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
  const state = selectedLiveSession()?.state;
  if (!state) return;
  sendCommand({
    kind: "warp",
    ...destinationDraft,
    time: uiWarpTransitionTime(state, destinationDraft),
  }, "Warp");
});

addPinButton.addEventListener("click", () => {
  updateDestinationFromFields();
  if (!destinationDraft || !warpForm.reportValidity()) return;
  const pin: LocationPin = {
    pinId: crypto.randomUUID(),
    label: nextDefaultPinLabel(),
    ...destinationDraft,
  };
  saveLocationPin(pin);
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
  if (!scaleForm.reportValidity()) return;
  if (!selectedLiveSession()?.state) return;
  sendCommand({
    kind: "setDisplayRadius",
    displayRadiusM,
    time: UI_SCALE_TRANSITION_SECONDS,
  }, "Scale change");
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
      const updated = {
        ...session,
        state: result.state,
        pins: result.pins,
        guidedPinIds: result.guidedPinIds,
      };
      sessions.set(pending.sessionId, updated);
      if (pending.sessionId === selectedSessionId) selectedSessionCache = updated;
    }
    if (pending.command.kind === "setDisplayRadius") {
      displayRadius.value = String(pending.command.displayRadiusM);
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
