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
} from "./renderer.js";
import { EclipseWorkerClient } from "./worker-client.js";

const UPCOMING_PAGE_SIZE = 5;
const FUTURE_SEARCH_YEARS = 10;
const LOCAL_HISTORY_YEARS = 50;
const worker = new EclipseWorkerClient();
const geoJsonExporter = new GeoJsonExporter();
const kmlExporter = new KmlExporter();

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}.`);
  return value as T;
};

const yearForm = element<HTMLFormElement>("year-form");
const yearInput = element<HTMLInputElement>("year-input");
const loadMoreButton = element<HTMLButtonElement>("load-more-button");
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

let providerMetadata: ProviderMetadata | null = null;
let selectedEvent: EclipseSummary;
let selectedScene: EclipseScene | null = null;
let selectedObserver: Observer | null = null;
let selectionVersion = 0;
let discoveryVersion = 0;
let locationVersion = 0;
let discoveredEvents: EclipseSummary[] = [];
let discoveryHeading = "Upcoming solar eclipses";
let discoveryAppendHeading: string | null = null;
let discoveryCursorUtc = new Date().toISOString();
const eventsById = new Map<string, EclipseSummary>();
const yearCache = new Map<number, Promise<EclipseSummary[]>>();

const map = new EclipseMapWorkspace(
  {
    mercator: element("mercator-map"),
    globe: element("globe-map"),
    world: element("world-map"),
  },
  readMapView(),
);
map.onLocation = (observer) => {
  void calculateLocation(observer);
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
    ...(includeTime
      ? {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZone: "UTC",
          timeZoneName: "short",
        }
      : {}),
  }).format(new Date(utc));
}

function eventButton(event: EclipseSummary): string {
  const selected = event.id === selectedEvent?.id;
  return `<button class="event-card${selected ? " is-selected" : ""}" type="button" data-event-id="${event.id}">
    <span class="kind-pill kind-${event.kind}">${kindLabel(event.kind)}</span>
    <strong>${dateLabel(event.peakUtc, false)}</strong>
    <span>${new Date(event.peakUtc).toISOString().slice(11, 16)} UTC</span>
  </button>`;
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

function renderEvents(): void {
  eventList.innerHTML = `<p class="event-list-heading">${discoveryHeading}</p>${
    discoveredEvents.length
      ? discoveredEvents.map(eventButton).join("")
      : '<p class="empty-state">No solar eclipses were found in this year.</p>'
  }`;
  eventList.querySelectorAll<HTMLButtonElement>("[data-event-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const event = eventsById.get(button.dataset.eventId ?? "");
      if (event) void selectEvent(event);
    });
  });
}

function setDiscoveredEvents(
  events: EclipseSummary[],
  heading: string,
  cursorUtc: string,
  appendHeading: string | null = null,
): void {
  discoveredEvents = rememberEvents(events);
  discoveryHeading = heading;
  discoveryAppendHeading = appendHeading;
  discoveryCursorUtc = cursorUtc;
  discoveryStatus.textContent = "";
  renderEvents();
}

function appendDiscoveredEvents(events: EclipseSummary[]): void {
  const knownIds = new Set(discoveredEvents.map((event) => event.id));
  const additions = rememberEvents(events).filter(
    (event) => !knownIds.has(event.id),
  );
  discoveredEvents = [...discoveredEvents, ...additions];
  if (discoveryAppendHeading) {
    discoveryHeading = discoveryAppendHeading;
    discoveryAppendHeading = null;
  }
  const lastEvent = discoveredEvents.at(-1);
  if (lastEvent) discoveryCursorUtc = instantAfter(lastEvent.peakUtc);
  renderEvents();
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

function visibleAboveHorizon(event: LocalEclipse): boolean {
  return [
    event.partialBegin,
    event.centralBegin,
    event.peak,
    event.centralEnd,
    event.partialEnd,
  ].some((contact) => contact && contact.sunAltitudeDeg > -0.833);
}

function renderNearby(events: LocalEclipse[], selectedPeakUtc: string): string {
  const selectedPeak = new Date(selectedPeakUtc).getTime();
  const visible = events
    .filter(visibleAboveHorizon)
    .filter(
      (event) =>
        Math.abs(new Date(event.peak.utc).getTime() - selectedPeak) >
        36 * 60 * 60 * 1000,
    );
  const past = visible
    .filter((event) => new Date(event.peak.utc).getTime() < selectedPeak)
    .slice(-5)
    .reverse();
  const future = visible
    .filter((event) => new Date(event.peak.utc).getTime() > selectedPeak)
    .slice(0, 5);
  const cards = (items: LocalEclipse[]) =>
    items.length
      ? items
          .map(
            (event) => `<li><button class="nearby-event" type="button" data-nearby-peak="${event.peak.utc}" aria-label="Show ${kindLabel(event.kind).toLowerCase()} eclipse on ${dateLabel(event.peak.utc, false)}">
              <span class="kind-pill kind-${event.kind}">${kindLabel(event.kind)}</span>
              <span class="nearby-event-details"><strong>${dateLabel(event.peak.utc, false)}</strong><span>${(event.obscuration * 100).toFixed(1)}% · Sun ${event.peak.sunAltitudeDeg.toFixed(0)}° high</span></span>
              <span class="nearby-event-action" aria-hidden="true">Show</span>
            </button></li>`,
          )
          .join("")
      : "<li class=\"empty-state\">None in this window.</li>";
  return `<div class="nearby-grid">
    <section><h3>Previous visible eclipses</h3><ul>${cards(past)}</ul></section>
    <section><h3>Next visible eclipses</h3><ul>${cards(future)}</ul></section>
  </div>
  <div class="nearby-status" data-nearby-status role="status" aria-live="polite"></div>`;
}

function calendarYear(value: string | null): number | null {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  const year = Number(value);
  return Number.isSafeInteger(year) ? year : null;
}

function requestedEventYear(
  eventId: string | null,
  yearParameter: string | null,
): number | null {
  return (
    calendarYear(eventId?.match(/^solar-(\d{4})-/)?.[1] ?? null) ??
    calendarYear(yearParameter)
  );
}

function yearBoundary(year: number): string {
  const value = new Date(0);
  value.setUTCFullYear(year, 0, 1);
  value.setUTCHours(0, 0, 0, 0);
  return value.toISOString();
}

function instantAfter(utc: string): string {
  return new Date(Date.parse(utc) + 1).toISOString();
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
      36 * 60 * 60 * 1000
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
      36 * 60 * 60 * 1000
  ) {
    throw new Error("The matching global eclipse could not be found.");
  }
  return closest;
}

function bindNearbyEventButtons(): void {
  const buttons = [
    ...locationResults.querySelectorAll<HTMLButtonElement>(
      "[data-nearby-peak]",
    ),
  ];
  const status =
    locationResults.querySelector<HTMLElement>("[data-nearby-status]");
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const localPeakUtc = button.dataset.nearbyPeak;
      if (!localPeakUtc) return;
      for (const candidate of buttons) candidate.disabled = true;
      if (status) status.textContent = "Loading the selected eclipse…";
      void eventForLocalPeak(localPeakUtc)
        .then(selectEvent)
        .catch((error) => {
          for (const candidate of buttons) candidate.disabled = false;
          if (status) {
            status.textContent = `Eclipse selection failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        });
    });
  }
}

async function futureEvents(
  fromUtc: string,
  limit = UPCOMING_PAGE_SIZE,
): Promise<EclipseSummary[]> {
  const from = new Date(fromUtc);
  if (!Number.isFinite(from.getTime())) {
    throw new RangeError(`Invalid future-event date: ${fromUtc}`);
  }
  const firstYear = from.getUTCFullYear();
  const finalYear = firstYear + FUTURE_SEARCH_YEARS;
  const events: EclipseSummary[] = [];
  for (
    let year = firstYear;
    year <= finalYear && events.length < limit;
    year += 1
  ) {
    events.push(
      ...(await eventsForYear(year)).filter(
        (event) => Date.parse(event.peakUtc) >= from.getTime(),
      ),
    );
  }
  return events
    .sort((first, second) =>
      first.peakUtc.localeCompare(second.peakUtc),
    )
    .slice(0, limit);
}

async function calculateLocation(observer: Observer): Promise<void> {
  const version = ++locationVersion;
  const event = selectedEvent;
  selectedObserver = observer;
  map.setLocation(observer);
  map.clearShadowOutline();
  writeUrlState();
  locationResults.innerHTML = '<p class="working">Calculating local eclipses…</p>';
  try {
    const referenceYear = new Date(event.peakUtc).getUTCFullYear();
    const result = await worker.calculateLocation(
      event,
      observer,
      referenceYear,
      LOCAL_HISTORY_YEARS,
    );
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
      }
      <p class="nearby-range">Nearby visible eclipses · ${result.startYear}–${result.endYear}</p>
      ${renderNearby(result.nearby, event.peakUtc)}`;
    bindNearbyEventButtons();
  } catch (error) {
    if (version !== locationVersion) return;
    locationResults.innerHTML = `<p class="error-state">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

async function selectEvent(event: EclipseSummary): Promise<void> {
  const version = ++selectionVersion;
  locationVersion += 1;
  selectedEvent = event;
  rememberEvents([event]);
  renderEvents();
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
    if (scene.centralPath) {
      map.showPath(scene);
      map.showGlobalVisibility(scene);
      map.fitPath();
      fitButton.disabled = false;
      geoJsonButton.disabled = false;
      kmlButton.disabled = false;
      calculationStatus.textContent = `${kindLabel(scene.centralPath.kind)} track calculated from ${dateLabel(scene.centralPath.centralBeginUtc)} to ${dateLabel(scene.centralPath.centralEndUtc)}.`;
      renderSummary(scene.event);
    } else {
      map.showGlobalVisibility(scene);
      map.fitGlobalVisibility();
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
    void calculateLocation(selectedObserver);
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

function readMapView(): { latitude: number; longitude: number; zoom: number } {
  const match = location.hash.match(/^#map=([0-9.]+)\/(-?[0-9.]+)\/(-?[0-9.]+)$/);
  return match
    ? {
        zoom: Number(match[1]),
        latitude: Number(match[2]),
        longitude: Number(match[3]),
      }
    : { latitude: 28, longitude: -12, zoom: 2 };
}

function writeUrlState(): void {
  if (!selectedEvent) return;
  const url = new URL(location.href);
  url.searchParams.set("eclipse", selectedEvent.id);
  url.searchParams.set(
    "year",
    String(new Date(selectedEvent.peakUtc).getUTCFullYear()),
  );
  if (selectedObserver) {
    url.searchParams.set("lat", selectedObserver.latitudeDeg.toFixed(5));
    url.searchParams.set("lon", selectedObserver.longitudeDeg.toFixed(5));
  }
  const view = map.getView();
  url.hash = `map=${view.zoom}/${view.latitude.toFixed(4)}/${view.longitude.toFixed(4)}`;
  history.replaceState(null, "", url);
}

yearForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const version = ++discoveryVersion;
  loadMoreButton.disabled = false;
  const year = calendarYear(yearInput.value);
  if (year === null) {
    eventList.innerHTML =
      '<p class="error-state">Enter a whole calendar year.</p>';
    return;
  }
  eventList.innerHTML =
    `<p class="working">Finding solar eclipses in ${year}…</p>`;
  void eventsForYear(year)
    .then((events) => {
      if (version !== discoveryVersion) return;
      setDiscoveredEvents(
        events,
        `Solar eclipses in ${year}`,
        yearBoundary(year + 1),
        `Solar eclipses from ${year} onward`,
      );
    })
    .catch((error) => {
      if (version !== discoveryVersion) return;
      eventList.innerHTML = `<p class="error-state">Eclipse search failed: ${escapeHtml(
        error instanceof Error ? error.message : String(error),
      )}</p>`;
    });
});

loadMoreButton.addEventListener("click", () => {
  const version = ++discoveryVersion;
  loadMoreButton.disabled = true;
  loadMoreButton.textContent = "Loading…";
  discoveryStatus.textContent = "Finding more solar eclipses…";
  void futureEvents(discoveryCursorUtc)
    .then((events) => {
      if (version !== discoveryVersion) return;
      appendDiscoveredEvents(events);
      discoveryStatus.textContent = events.length
        ? ""
        : "No more eclipses were found in the search range.";
    })
    .catch((error) => {
      if (version !== discoveryVersion) return;
      discoveryStatus.innerHTML = `<p class="error-state">Eclipse search failed: ${escapeHtml(
        error instanceof Error ? error.message : String(error),
      )}</p>`;
    })
    .finally(() => {
      if (version === discoveryVersion) {
        loadMoreButton.disabled = false;
        loadMoreButton.textContent = "Load 5 more";
      }
    });
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
    const now = new Date().toISOString();
    const requested = params.get("eclipse");
    const requestedYear = requestedEventYear(
      requested,
      params.get("year"),
    );
    const requestedEvents =
      requestedYear === null
        ? []
        : await eventsForYear(requestedYear);
    const requestedDate = requested?.match(
      /^solar-(\d{4}-\d{2}-\d{2})-/,
    )?.[1];
    const requestedEvent =
      requestedEvents.find((event) => event.id === requested) ??
      requestedEvents.find((event) =>
        requestedDate
          ? event.peakUtc.startsWith(requestedDate)
          : false,
      );
    const future = requestedEvent || requestedEvents.length > 0
      ? []
      : await futureEvents(now);
    const initialEvent =
      requestedEvent ??
      requestedEvents[0] ??
      future[0];
    if (!initialEvent) {
      throw new Error(
        "No solar eclipses were found in the forward search window.",
      );
    }
    selectedEvent = initialEvent;
    yearInput.value = String(
      requestedYear ?? new Date(now).getUTCFullYear(),
    );
    if (requestedYear !== null && requestedEvents.length > 0) {
      setDiscoveredEvents(
        requestedEvents,
        `Solar eclipses in ${requestedYear}`,
        yearBoundary(requestedYear + 1),
        `Solar eclipses from ${requestedYear} onward`,
      );
    } else {
      const lastFutureEvent = future.at(-1);
      setDiscoveredEvents(
        future,
        "Upcoming solar eclipses",
        lastFutureEvent ? instantAfter(lastFutureEvent.peakUtc) : now,
      );
    }
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
    }
    await selectEvent(selectedEvent);
  } catch (error) {
    eventSummary.innerHTML = `<p class="error-state">Eclipse discovery failed: ${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</p>`;
  }
}

void start();
