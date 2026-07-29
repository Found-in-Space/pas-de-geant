import "./styles.css";
import {
  GeoJsonExporter,
  KmlExporter,
  type EclipseKind,
  type EclipseSummary,
  type EclipseScene,
  type ExportedEclipse,
  type LocalEclipse,
  type Observer,
  type ProviderMetadata,
} from "@found-in-space/shadowline";
import { EclipseMapWorkspace } from "./map-workspace.js";
import {
  DEFAULT_LAYER_VISIBILITY,
  ECLIPSE_LAYER_KEYS,
  type EclipseLayerKey,
  type EclipseLayerVisibility,
  type MapView,
} from "./renderer.js";
import {
  EclipseWorkerClient,
  type PageDirection,
} from "./worker-client.js";
import {
  resolveInitialLocation,
  type InitialLocationSource,
} from "../../shared/initial-location.js";

const PAGE_SIZE = 5;
const MATCHING_ECLIPSE_WINDOW_MS = 36 * 60 * 60 * 1000;
const worker = new EclipseWorkerClient();
const geoJsonExporter = new GeoJsonExporter();
const kmlExporter = new KmlExporter();

type LocatorMode = "date" | "place";

interface TimelineItem {
  key: string;
  peakUtc: string;
  kind: EclipseKind;
  summary?: EclipseSummary;
  local?: LocalEclipse;
}

interface TimelineState {
  items: TimelineItem[];
  heading: string;
  earlierBoundaryUtc: string;
  laterBoundaryUtc: string;
  initialized: boolean;
  version: number;
  loading: Record<PageDirection, boolean>;
  error: string;
}

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}.`);
  return value as T;
};

const dateTab = element<HTMLButtonElement>("date-tab");
const placeTab = element<HTMLButtonElement>("place-tab");
const dateControls = element<HTMLDivElement>("date-controls");
const placeControls = element<HTMLDivElement>("place-controls");
const yearForm = element<HTMLFormElement>("year-form");
const yearInput = element<HTMLInputElement>("year-input");
const placeForm = element<HTMLFormElement>("place-form");
const aroundInput = element<HTMLInputElement>("around-input");
const locatorPlace = element<HTMLDivElement>("locator-place");
const timelineHeading = element<HTMLParagraphElement>("timeline-heading");
const loadEarlierButton = element<HTMLButtonElement>("load-earlier-button");
const loadLaterButton = element<HTMLButtonElement>("load-later-button");
const eventList = element<HTMLDivElement>("event-list");
const discoveryStatus = element<HTMLDivElement>("discovery-status");
const eventSummary = element<HTMLDivElement>("event-summary");
const calculationStatus = element<HTMLDivElement>("calculation-status");
const fitButton = element<HTMLButtonElement>("fit-button");
const geoJsonButton = element<HTMLButtonElement>("geojson-button");
const kmlButton = element<HTMLButtonElement>("kml-button");
const locationResults = element<HTMLDivElement>("location-results");
const sidebar = element<HTMLElement>("sidebar");
const sidebarToggle = element<HTMLButtonElement>("sidebar-toggle");
const sidebarClose = element<HTMLButtonElement>("sidebar-close");

const nowUtc = new Date().toISOString();
let locatorMode: LocatorMode = "date";
let searchYear = new Date(nowUtc).getUTCFullYear();
let aroundDate = nowUtc.slice(0, 10);
let providerMetadata: ProviderMetadata | null = null;
let selectedEvent: EclipseSummary;
let selectedScene: EclipseScene | null = null;
let selectedObserver: Observer | null = null;
let selectionVersion = 0;
let locationVersion = 0;
const eventsById = new Map<string, EclipseSummary>();
const yearCache = new Map<number, Promise<EclipseSummary[]>>();

interface InitialMapView {
  view: MapView;
  source: InitialLocationSource | "url";
  fitSelectedEvent: boolean;
}

function timelineState(heading: string): TimelineState {
  return {
    items: [],
    heading,
    earlierBoundaryUtc: nowUtc,
    laterBoundaryUtc: nowUtc,
    initialized: false,
    version: 0,
    loading: { earlier: false, later: false },
    error: "",
  };
}

const dateTimeline = timelineState("Upcoming solar eclipses");
const placeTimeline = timelineState("Visible eclipses at a selected place");

const initialMapView = await readMapView();
document.body.dataset.locationSource = initialMapView.source;
const map = new EclipseMapWorkspace(
  {
    mercator: element("mercator-map"),
    globe: element("globe-map"),
    world: element("world-map"),
  },
  initialMapView.view,
);
map.onLocation = (observer) => {
  setSelectedObserver(observer);
};
map.onViewChanged = writeUrlState;

const layerInputs = [
  ...document.querySelectorAll<HTMLInputElement>("[data-layer-key]"),
];

function readLayerVisibility(): EclipseLayerVisibility {
  const visibility = { ...DEFAULT_LAYER_VISIBILITY };
  for (const input of layerInputs) {
    const key = input.dataset.layerKey as EclipseLayerKey | undefined;
    if (key && ECLIPSE_LAYER_KEYS.includes(key)) {
      visibility[key] = input.checked;
    }
  }
  return visibility;
}

for (const input of layerInputs) {
  input.addEventListener("change", () => {
    map.setLayerVisibility(readLayerVisibility());
  });
}

function kindLabel(kind: EclipseKind): string {
  return kind === "hybrid"
    ? "Hybrid"
    : kind.charAt(0).toUpperCase() + kind.slice(1);
}

function dateLabel(utc: string, includeTime = true): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
    ...(includeTime
      ? {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZoneName: "short",
        }
      : {}),
  }).format(new Date(utc));
}

function globalTimelineItem(event: EclipseSummary): TimelineItem {
  return {
    key: `global:${event.id}`,
    peakUtc: event.peakUtc,
    kind: event.kind,
    summary: event,
  };
}

function localTimelineItem(event: LocalEclipse): TimelineItem {
  return {
    key: `local:${event.peak.utc}`,
    peakUtc: event.peak.utc,
    kind: event.kind,
    local: event,
  };
}

function rememberEvents(events: EclipseSummary[]): EclipseSummary[] {
  for (const event of events) eventsById.set(event.id, event);
  return events;
}

function eventsForYear(year: number): Promise<EclipseSummary[]> {
  const cached = yearCache.get(year);
  if (cached) return cached;
  const pending = worker
    .eventsForYear(year)
    .then((result) => {
      providerMetadata = result.provider;
      return rememberEvents(result.events);
    })
    .catch((error) => {
      yearCache.delete(year);
      throw error;
    });
  yearCache.set(year, pending);
  return pending;
}

function activeTimeline(): TimelineState {
  return locatorMode === "date" ? dateTimeline : placeTimeline;
}

function sortedUnique(items: TimelineItem[]): TimelineItem[] {
  const unique = new Map<string, TimelineItem>();
  for (const item of items) unique.set(item.key, item);
  return [...unique.values()].sort((first, second) =>
    first.peakUtc.localeCompare(second.peakUtc),
  );
}

function matchesSelectedEvent(item: TimelineItem): boolean {
  if (!selectedEvent) return false;
  if (item.summary) return item.summary.id === selectedEvent.id;
  return (
    Math.abs(Date.parse(item.peakUtc) - Date.parse(selectedEvent.peakUtc)) <
    MATCHING_ECLIPSE_WINDOW_MS
  );
}

function timelineButton(item: TimelineItem): string {
  const selected = matchesSelectedEvent(item);
  const localDetail = item.local
    ? `${(item.local.obscuration * 100).toFixed(1)}% · Sun ${item.local.peak.sunAltitudeDeg.toFixed(0)}° high`
    : `${new Date(item.peakUtc).toISOString().slice(11, 16)} UTC`;
  const identity = item.summary
    ? `data-event-id="${item.summary.id}"`
    : `data-local-peak="${item.peakUtc}"`;
  return `<button class="event-card${selected ? " is-selected" : ""}" type="button" data-timeline-key="${item.key}" ${identity}>
    <span class="kind-pill kind-${item.kind}">${kindLabel(item.kind)}</span>
    <span class="event-card-details"><strong>${dateLabel(item.peakUtc, false)}</strong><span>${localDetail}</span></span>
    <span class="event-card-time" aria-hidden="true">Show</span>
  </button>`;
}

function renderLocatorPlace(): void {
  locatorPlace.innerHTML = selectedObserver
    ? `<span>Selected point</span><strong>${selectedObserver.latitudeDeg.toFixed(5)}°, ${selectedObserver.longitudeDeg.toFixed(5)}°</strong>`
    : "<span>Selected point</span><strong>Choose a point on a map</strong>";
}

function renderTimeline(): void {
  const state = activeTimeline();
  const placeReady = locatorMode === "date" || selectedObserver !== null;
  dateTab.setAttribute("aria-selected", String(locatorMode === "date"));
  dateTab.tabIndex = locatorMode === "date" ? 0 : -1;
  placeTab.setAttribute("aria-selected", String(locatorMode === "place"));
  placeTab.tabIndex = locatorMode === "place" ? 0 : -1;
  dateControls.hidden = locatorMode !== "date";
  placeControls.hidden = locatorMode !== "place";
  renderLocatorPlace();

  loadEarlierButton.disabled =
    !placeReady || !state.initialized || state.loading.earlier;
  loadLaterButton.disabled =
    !placeReady || !state.initialized || state.loading.later;
  loadEarlierButton.textContent = state.loading.earlier
    ? "Loading earlier…"
    : "Show 5 earlier eclipses";
  loadLaterButton.textContent = state.loading.later
    ? "Loading later…"
    : "Show 5 later eclipses";
  timelineHeading.textContent = state.heading;

  const message =
    locatorMode === "place" && !selectedObserver
      ? "Choose a point on any map to find eclipses visible there."
      : !state.initialized
        ? locatorMode === "place"
          ? "Finding visible eclipses…"
          : "Finding solar eclipses…"
        : state.items.length === 0
          ? locatorMode === "place"
            ? "No visible eclipse falls on this date. Use earlier or later to continue browsing."
            : "No solar eclipse falls in this year. Use earlier or later to continue browsing."
          : "";
  eventList.innerHTML = state.items.length
    ? state.items.map(timelineButton).join("")
    : `<p class="${state.initialized ? "empty-state" : "working"}">${message}</p>`;
  discoveryStatus.innerHTML = state.error
    ? `<p class="error-state">${escapeHtml(state.error)}</p>`
    : "";

  eventList
    .querySelectorAll<HTMLButtonElement>("[data-timeline-key]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const item = state.items.find(
          (candidate) => candidate.key === button.dataset.timelineKey,
        );
        if (!item) return;
        if (item.summary) {
          void selectEvent(item.summary);
          return;
        }
        button.disabled = true;
        discoveryStatus.textContent = "Loading the selected eclipse…";
        void eventForLocalPeak(item.peakUtc)
          .then(selectEvent)
          .catch((error) => {
            button.disabled = false;
            discoveryStatus.textContent = `Eclipse selection failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          });
      });
    });
}

function calendarYear(value: string | null): number | null {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  const year = Number(value);
  return Number.isSafeInteger(year) ? year : null;
}

function eventIdYear(eventId: string | null): number | null {
  return calendarYear(eventId?.match(/^solar-(\d{4})-/)?.[1] ?? null);
}

function yearBoundary(year: number): string {
  const value = new Date(0);
  value.setUTCFullYear(year, 0, 1);
  value.setUTCHours(0, 0, 0, 0);
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError(`Year is outside the supported date range: ${year}.`);
  }
  return value.toISOString();
}

function validAroundDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function dayRange(value: string): { startUtc: string; endUtc: string } {
  const start = new Date(`${value}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new RangeError(`Date is outside the supported range: ${value}.`);
  }
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

function closestEvent(
  events: EclipseSummary[],
  targetUtc: string,
): EclipseSummary | null {
  const target = Date.parse(targetUtc);
  return events.reduce<EclipseSummary | null>((closest, event) => {
    if (!closest) return event;
    return Math.abs(Date.parse(event.peakUtc) - target) <
      Math.abs(Date.parse(closest.peakUtc) - target)
      ? event
      : closest;
  }, null);
}

async function eventForLocalPeak(
  localPeakUtc: string,
): Promise<EclipseSummary> {
  const target = new Date(localPeakUtc);
  if (!Number.isFinite(target.getTime())) {
    throw new RangeError(`Invalid local eclipse date: ${localPeakUtc}`);
  }
  const year = target.getUTCFullYear();
  const events = await eventsForYear(year);
  let closest = closestEvent(events, localPeakUtc);
  if (
    !closest ||
    Math.abs(Date.parse(closest.peakUtc) - target.getTime()) >
      MATCHING_ECLIPSE_WINDOW_MS
  ) {
    const adjacentEvents = await Promise.all([
      eventsForYear(year - 1),
      eventsForYear(year + 1),
    ]);
    closest = closestEvent([...events, ...adjacentEvents.flat()], localPeakUtc);
  }
  if (
    !closest ||
    Math.abs(Date.parse(closest.peakUtc) - target.getTime()) >
      MATCHING_ECLIPSE_WINDOW_MS
  ) {
    throw new Error("The matching global eclipse could not be found.");
  }
  return closest;
}

function visibleAboveHorizon(event: LocalEclipse): boolean {
  return [
    event.partialBegin,
    event.centralBegin,
    event.peak,
    event.centralEnd,
    event.partialEnd,
  ].some((contact) => contact && contact.sunAltitudeDeg > -0.833);
}

async function resetDateTimeline(year: number): Promise<void> {
  const state = dateTimeline;
  const version = ++state.version;
  searchYear = year;
  yearInput.value = String(year);
  state.items = [];
  state.heading = `Solar eclipses · ${year}`;
  state.earlierBoundaryUtc = yearBoundary(year);
  state.laterBoundaryUtc = yearBoundary(year + 1);
  state.initialized = false;
  state.loading = { earlier: false, later: false };
  state.error = "";
  renderTimeline();
  writeUrlState();
  try {
    const events = await eventsForYear(year);
    if (version !== state.version) return;
    state.items = sortedUnique(events.map(globalTimelineItem));
    state.initialized = true;
    renderTimeline();
  } catch (error) {
    if (version !== state.version) return;
    state.initialized = true;
    state.error = `Eclipse search failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    renderTimeline();
  }
}

async function resetPlaceTimeline(): Promise<void> {
  if (!selectedObserver) {
    placeTimeline.version += 1;
    placeTimeline.items = [];
    placeTimeline.initialized = false;
    placeTimeline.error = "";
    renderTimeline();
    return;
  }
  const observer = selectedObserver;
  const state = placeTimeline;
  const version = ++state.version;
  const { startUtc, endUtc } = dayRange(aroundDate);
  state.items = [];
  state.heading = `Visible eclipses around ${dateLabel(startUtc, false)}`;
  state.earlierBoundaryUtc = startUtc;
  state.laterBoundaryUtc = endUtc;
  state.initialized = false;
  state.loading = { earlier: true, later: true };
  state.error = "";
  renderTimeline();
  writeUrlState();
  try {
    const [earlier, sameDay, later] = await Promise.all([
      worker.localEventsPage(observer, startUtc, "earlier", PAGE_SIZE),
      worker.localEventsInRange(observer, startUtc, endUtc),
      worker.localEventsPage(observer, endUtc, "later", PAGE_SIZE),
    ]);
    if (version !== state.version || observer !== selectedObserver) return;
    state.items = sortedUnique(
      [...earlier.events, ...sameDay.events, ...later.events]
        .filter(visibleAboveHorizon)
        .map(localTimelineItem),
    );
    state.initialized = true;
    state.loading = { earlier: false, later: false };
    renderTimeline();
  } catch (error) {
    if (version !== state.version) return;
    state.initialized = true;
    state.loading = { earlier: false, later: false };
    state.error = `Visible-eclipse search failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    renderTimeline();
  }
}

async function loadTimelinePage(direction: PageDirection): Promise<void> {
  const state = activeTimeline();
  const mode = locatorMode;
  if (!state.initialized || state.loading[direction]) return;
  const version = state.version;
  const observer = selectedObserver;
  const first = state.items.at(0);
  const last = state.items.at(-1);
  const boundaryUtc =
    direction === "earlier"
      ? first?.peakUtc ?? state.earlierBoundaryUtc
      : last?.peakUtc ?? state.laterBoundaryUtc;
  state.loading[direction] = true;
  state.error = "";
  renderTimeline();
  try {
    const items =
      mode === "date"
        ? (
            await worker.globalEventsPage(
              boundaryUtc,
              direction,
              PAGE_SIZE,
            )
          ).events.map((event) => {
            rememberEvents([event]);
            return globalTimelineItem(event);
          })
        : observer
          ? (
              await worker.localEventsPage(
                observer,
                boundaryUtc,
                direction,
                PAGE_SIZE,
              )
            ).events
              .filter(visibleAboveHorizon)
              .map(localTimelineItem)
          : [];
    if (
      version !== state.version ||
      (mode === "place" && observer !== selectedObserver)
    ) {
      return;
    }
    const previousHeight = sidebar.scrollHeight;
    const previousTop = sidebar.scrollTop;
    state.items = sortedUnique([...state.items, ...items]);
    state.loading[direction] = false;
    if (state === activeTimeline()) renderTimeline();
    if (direction === "earlier" && state === activeTimeline()) {
      sidebar.scrollTop =
        previousTop + (sidebar.scrollHeight - previousHeight);
    }
  } catch (error) {
    if (version !== state.version) return;
    state.loading[direction] = false;
    state.error = `Could not calculate ${direction} eclipses: ${
      error instanceof Error ? error.message : String(error)
    }`;
    if (state === activeTimeline()) renderTimeline();
  }
}

function renderSummary(event: EclipseSummary): void {
  const location = event.peakLocation
    ? `${event.peakLocation.latitudeDeg.toFixed(2)}°, ${event.peakLocation.longitudeDeg.toFixed(2)}°`
    : "No central shadow";
  eventSummary.innerHTML = `
    <div class="summary-title"><span class="kind-pill kind-${event.kind}">${kindLabel(event.kind)}</span><strong>${dateLabel(event.peakUtc, false)}</strong></div>
    <dl class="summary-grid">
      <div><dt>Global peak</dt><dd>${dateLabel(event.peakUtc)}</dd></div>
      <div><dt>Peak location</dt><dd>${location}</dd></div>
      <div><dt>Ephemeris</dt><dd>${providerMetadata?.name ?? "Provider"} ${providerMetadata?.version ?? ""}</dd></div>
    </dl>`;
}

function renderCurrentEventLocal(local: LocalEclipse | null): string {
  if (!local) {
    return `<div class="current-local is-not-visible"><strong>Selected eclipse</strong><p>The selected eclipse is not visible from this point.</p></div>`;
  }
  const centralDuration =
    local.centralBegin && local.centralEnd
      ? (new Date(local.centralEnd.utc).getTime() -
          new Date(local.centralBegin.utc).getTime()) /
        1000
      : null;
  return `<div class="current-local">
    <strong>${kindLabel(local.kind)} at this point</strong>
    <dl class="local-grid">
      <div><dt>Local maximum</dt><dd>${dateLabel(local.peak.utc)}</dd></div>
      <div><dt>Obscuration</dt><dd>${(local.obscuration * 100).toFixed(1)}%</dd></div>
      <div><dt>Sun altitude</dt><dd>${local.peak.sunAltitudeDeg.toFixed(1)}°</dd></div>
      <div><dt>Sun azimuth</dt><dd>${local.peak.sunAzimuthDeg.toFixed(1)}°</dd></div>
      ${centralDuration === null ? "" : `<div><dt>Central phase</dt><dd>${formatDuration(centralDuration)}</dd></div>`}
    </dl>
  </div>`;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}

async function calculateSelectedLocation(observer: Observer): Promise<void> {
  const version = ++locationVersion;
  const event = selectedEvent;
  map.clearShadowOutline();
  locationResults.innerHTML = `<div class="place-coordinate">
      <span>Selected point</span>
      <strong>${observer.latitudeDeg.toFixed(5)}°, ${observer.longitudeDeg.toFixed(5)}°</strong>
    </div><p class="working">Calculating local circumstances…</p>`;
  try {
    const result = await worker.calculateLocation(event, observer);
    if (version !== locationVersion || event.id !== selectedEvent.id) return;
    map.showShadowOutline(result.shadowScene);
    locationResults.innerHTML = `<div class="place-coordinate">
        <span>Selected point</span>
        <strong>${observer.latitudeDeg.toFixed(5)}°, ${observer.longitudeDeg.toFixed(5)}°</strong>
      </div>
      ${renderCurrentEventLocal(result.selected)}
      ${
        result.shadowScene
          ? `<p class="window-note">${kindLabel(result.selected!.kind)} and penumbra outlines shown at this location’s maximum.</p>`
          : ""
      }`;
  } catch (error) {
    if (version !== locationVersion) return;
    locationResults.innerHTML = `<div class="place-coordinate">
        <span>Selected point</span>
        <strong>${observer.latitudeDeg.toFixed(5)}°, ${observer.longitudeDeg.toFixed(5)}°</strong>
      </div><p class="error-state">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

function setSelectedObserver(observer: Observer): void {
  selectedObserver = observer;
  map.setLocation(observer);
  renderTimeline();
  writeUrlState();
  if (selectedEvent) void calculateSelectedLocation(observer);
  if (locatorMode === "place") {
    void resetPlaceTimeline();
  } else {
    placeTimeline.version += 1;
    placeTimeline.items = [];
    placeTimeline.initialized = false;
    placeTimeline.loading = { earlier: false, later: false };
    placeTimeline.error = "";
  }
}

async function selectEvent(
  event: EclipseSummary,
  fitEvent = true,
): Promise<void> {
  const version = ++selectionVersion;
  locationVersion += 1;
  selectedEvent = event;
  rememberEvents([event]);
  renderTimeline();
  selectedScene = null;
  fitButton.disabled = true;
  geoJsonButton.disabled = true;
  kmlButton.disabled = true;
  map.clearPath();
  map.showPeak(
    event.peakLocation?.latitudeDeg,
    event.peakLocation?.longitudeDeg,
  );
  renderSummary(event);
  writeUrlState();
  calculationStatus.textContent =
    event.kind === "partial"
      ? "Calculating global partial-eclipse visibility…"
      : "Calculating the complete central track and global visibility…";
  try {
    const { scene } = await worker.calculateEventGeometry(event);
    if (version !== selectionVersion) return;
    selectedScene = scene;
    selectedEvent = scene.event;
    rememberEvents([scene.event]);
    renderTimeline();
    if (scene.centralPath) {
      map.showPath(scene);
      map.showGlobalVisibility(scene);
      if (fitEvent) map.fitPath();
      fitButton.disabled = false;
      geoJsonButton.disabled = false;
      kmlButton.disabled = false;
      calculationStatus.textContent = `${kindLabel(scene.centralPath.kind)} track calculated from ${dateLabel(scene.centralPath.centralBeginUtc)} to ${dateLabel(scene.centralPath.centralEndUtc)}.`;
      renderSummary(scene.event);
    } else {
      map.showGlobalVisibility(scene);
      if (fitEvent) map.fitGlobalVisibility();
      geoJsonButton.disabled = false;
      kmlButton.disabled = false;
      calculationStatus.textContent = `Partial-eclipse visibility calculated from ${dateLabel(scene.contacts[0]!.utc)} to ${dateLabel(scene.contacts.at(-1)!.utc)}; no central track exists.`;
    }
  } catch (error) {
    if (version !== selectionVersion) return;
    calculationStatus.textContent = `Eclipse calculation failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (selectedObserver) {
    void calculateSelectedLocation(selectedObserver);
  }
}

function download(exported: ExportedEclipse): void {
  const blob = new Blob([exported.contents as BlobPart], {
    type: exported.mimeType,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value: string): string {
  const node = document.createElement("div");
  node.textContent = value;
  return node.innerHTML;
}

function mapViewFromUrl(): InitialMapView | undefined {
  const match = location.hash.match(
    /^#map=([0-9.]+)\/(-?[0-9.]+)\/(-?[0-9.]+)$/,
  );
  if (match) {
    const view = {
      zoom: Number(match[1]),
      latitude: Number(match[2]),
      longitude: Number(match[3]),
    };
    if (
      Number.isFinite(view.zoom) &&
      Number.isFinite(view.latitude) &&
      Number.isFinite(view.longitude) &&
      view.latitude >= -90 &&
      view.latitude <= 90
    ) {
      return { view, source: "url", fitSelectedEvent: false };
    }
  }

  const params = new URLSearchParams(location.search);
  const latitude = Number(params.get("lat"));
  const longitude = Number(params.get("lon"));
  if (
    params.has("lat") &&
    params.has("lon") &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  ) {
    return {
      view: { latitude, longitude, zoom: 5 },
      source: "url",
      fitSelectedEvent: false,
    };
  }
  return undefined;
}

async function readMapView(): Promise<InitialMapView> {
  const requestedView = mapViewFromUrl();
  if (requestedView) return requestedView;
  const detected = await resolveInitialLocation();
  return {
    view: {
      latitude: detected.latitudeDegrees,
      longitude: detected.longitudeDegrees,
      zoom: detected.source === "fallback" ? 2 : 5,
    },
    source: detected.source,
    fitSelectedEvent: detected.source === "fallback",
  };
}

function writeUrlState(): void {
  if (!selectedEvent) return;
  const url = new URL(location.href);
  url.searchParams.set("eclipse", selectedEvent.id);
  url.searchParams.set("locator", locatorMode);
  url.searchParams.set("year", String(searchYear));
  url.searchParams.set("around", aroundDate);
  if (selectedObserver) {
    url.searchParams.set("lat", selectedObserver.latitudeDeg.toFixed(5));
    url.searchParams.set("lon", selectedObserver.longitudeDeg.toFixed(5));
  } else {
    url.searchParams.delete("lat");
    url.searchParams.delete("lon");
  }
  const view = map.getView();
  url.hash = `map=${view.zoom}/${view.latitude.toFixed(4)}/${view.longitude.toFixed(4)}`;
  history.replaceState(null, "", url);
}

function setLocatorMode(mode: LocatorMode): void {
  locatorMode = mode;
  renderTimeline();
  writeUrlState();
  if (mode === "place" && selectedObserver && !placeTimeline.initialized) {
    void resetPlaceTimeline();
  }
}

dateTab.addEventListener("click", () => setLocatorMode("date"));
placeTab.addEventListener("click", () => setLocatorMode("place"));
for (const tab of [dateTab, placeTab]) {
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextMode: LocatorMode = locatorMode === "date" ? "place" : "date";
    setLocatorMode(nextMode);
    (nextMode === "date" ? dateTab : placeTab).focus();
  });
}

yearForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const year = calendarYear(yearInput.value);
  if (year === null) {
    dateTimeline.error = "Enter a whole calendar year.";
    renderTimeline();
    return;
  }
  void resetDateTimeline(year);
});

placeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const date = validAroundDate(aroundInput.value);
  if (!date) {
    placeTimeline.error = "Enter a valid reference date.";
    renderTimeline();
    return;
  }
  aroundDate = date;
  writeUrlState();
  void resetPlaceTimeline();
});

loadEarlierButton.addEventListener("click", () => {
  void loadTimelinePage("earlier");
});
loadLaterButton.addEventListener("click", () => {
  void loadTimelinePage("later");
});

fitButton.addEventListener("click", () => map.fitPath());
geoJsonButton.addEventListener("click", () => {
  if (selectedScene) download(geoJsonExporter.export(selectedScene));
});
kmlButton.addEventListener("click", () => {
  if (selectedScene) download(kmlExporter.export(selectedScene));
});
sidebarToggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("is-open");
  sidebarToggle.setAttribute("aria-expanded", String(open));
});
sidebarClose.addEventListener("click", () => {
  sidebar.classList.remove("is-open");
  sidebarToggle.setAttribute("aria-expanded", "false");
});

async function start(): Promise<void> {
  try {
    const params = new URLSearchParams(location.search);
    const requested = params.get("eclipse");
    const requestedSearchYear = calendarYear(params.get("year"));
    const requestedSelectedYear =
      eventIdYear(requested) ?? requestedSearchYear;
    const selectedCandidates =
      requestedSelectedYear === null
        ? []
        : await eventsForYear(requestedSelectedYear);
    const requestedDate = requested?.match(
      /^solar-(\d{4}-\d{2}-\d{2})-/,
    )?.[1];
    const requestedEvent =
      selectedCandidates.find((event) => event.id === requested) ??
      selectedCandidates.find((event) =>
        requestedDate ? event.peakUtc.startsWith(requestedDate) : false,
      );

    searchYear =
      requestedSearchYear ??
      requestedSelectedYear ??
      new Date(nowUtc).getUTCFullYear();
    yearInput.value = String(searchYear);

    let initialEvents: EclipseSummary[];
    let initialEvent = requestedEvent;
    if (requestedSearchYear !== null || requestedEvent) {
      initialEvents = await eventsForYear(searchYear);
      initialEvent ??= initialEvents[0];
      dateTimeline.heading = `Solar eclipses · ${searchYear}`;
      dateTimeline.earlierBoundaryUtc = yearBoundary(searchYear);
      dateTimeline.laterBoundaryUtc = yearBoundary(searchYear + 1);
    } else {
      const result = await worker.globalEventsPage(
        nowUtc,
        "later",
        PAGE_SIZE,
      );
      providerMetadata = result.provider;
      initialEvents = rememberEvents(result.events);
      initialEvent = initialEvents[0];
      dateTimeline.heading = "Upcoming solar eclipses";
      dateTimeline.earlierBoundaryUtc = nowUtc;
      dateTimeline.laterBoundaryUtc =
        initialEvents.at(-1)?.peakUtc ?? nowUtc;
    }
    if (!initialEvent) {
      throw new Error("No solar eclipses could be calculated.");
    }
    selectedEvent = initialEvent;
    dateTimeline.items = sortedUnique(initialEvents.map(globalTimelineItem));
    dateTimeline.initialized = true;

    const latitude = Number(params.get("lat"));
    const longitude = Number(params.get("lon"));
    if (
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      params.has("lat") &&
      params.has("lon")
    ) {
      selectedObserver = {
        latitudeDeg: latitude,
        longitudeDeg: longitude,
        elevationMeters: 0,
      };
      map.setLocation(selectedObserver);
    }

    locatorMode = params.get("locator") === "place" ? "place" : "date";
    aroundDate =
      validAroundDate(params.get("around")) ??
      selectedEvent.peakUtc.slice(0, 10) ??
      nowUtc.slice(0, 10);
    aroundInput.value = aroundDate;
    renderTimeline();
    await selectEvent(selectedEvent, initialMapView.fitSelectedEvent);
    if (locatorMode === "place" && selectedObserver) {
      await resetPlaceTimeline();
    }
  } catch (error) {
    eventSummary.innerHTML = `<p class="error-state">Eclipse discovery failed: ${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</p>`;
  }
}

void start();
