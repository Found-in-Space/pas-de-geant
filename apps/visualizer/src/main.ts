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

const FUTURE_EVENT_LIMIT = 16;
const FUTURE_SEARCH_YEARS = 10;
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
const futureButton = element<HTMLButtonElement>("future-button");
const eventList = element<HTMLDivElement>("event-list");
const eventSummary = element<HTMLDivElement>("event-summary");
const calculationStatus = element<HTMLDivElement>("calculation-status");
const fitButton = element<HTMLButtonElement>("fit-button");
const geoJsonButton = element<HTMLButtonElement>("geojson-button");
const kmlButton = element<HTMLButtonElement>("kml-button");
const coordinateForm = element<HTMLFormElement>("coordinate-form");
const coordinateInput = element<HTMLInputElement>("coordinate-input");
const windowInput = element<HTMLInputElement>("window-input");
const locateButton = element<HTMLButtonElement>("locate-button");
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
  coordinateInput.value = `${observer.latitudeDeg.toFixed(5)}, ${observer.longitudeDeg.toFixed(5)}`;
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

function renderEvents(events: EclipseSummary[], heading: string): void {
  rememberEvents(events);
  eventList.innerHTML = `<p class="event-list-heading">${heading}</p>${
    events.length
      ? events.slice(0, 16).map(eventButton).join("")
      : '<p class="empty-state">No solar eclipses were found in this year.</p>'
  }`;
  eventList.querySelectorAll<HTMLButtonElement>("[data-event-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const event = eventsById.get(button.dataset.eventId ?? "");
      if (event) void selectEvent(event);
    });
  });
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
            (event) => `<li><span class="kind-pill kind-${event.kind}">${kindLabel(event.kind)}</span><div><strong>${dateLabel(event.peak.utc, false)}</strong><span>${(event.obscuration * 100).toFixed(1)}% · Sun ${event.peak.sunAltitudeDeg.toFixed(0)}° high</span></div></li>`,
          )
          .join("")
      : "<li class=\"empty-state\">None in this window.</li>";
  return `<div class="nearby-grid">
    <section><h3>Previous visible eclipses</h3><ul>${cards(past)}</ul></section>
    <section><h3>Next visible eclipses</h3><ul>${cards(future)}</ul></section>
  </div>`;
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

async function futureEvents(
  fromUtc: string,
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
    year <= finalYear && events.length < FUTURE_EVENT_LIMIT;
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
    .slice(0, FUTURE_EVENT_LIMIT);
}

async function calculateLocation(observer: Observer): Promise<void> {
  const version = ++locationVersion;
  const event = selectedEvent;
  selectedObserver = observer;
  map.setLocation(observer);
  map.clearShadowOutline();
  writeUrlState();
  locationResults.innerHTML = '<p class="working">Calculating local eclipses…</p>';
  const yearsEachSide = Math.max(
    1,
    Math.min(100, Number.parseInt(windowInput.value, 10) || 50),
  );
  windowInput.value = String(yearsEachSide);
  try {
    const referenceYear = new Date(event.peakUtc).getUTCFullYear();
    const result = await worker.calculateLocation(
      event,
      observer,
      referenceYear,
      yearsEachSide,
    );
    if (version !== locationVersion || event.id !== selectedEvent.id) return;
    map.showShadowOutline(result.shadowScene);
    locationResults.innerHTML = `${renderCurrentEventLocal(result.selected)}
      ${
        result.shadowScene
          ? `<p class="window-note">${kindLabel(result.selected!.kind)} and penumbra outlines shown at this location’s maximum.</p>`
          : ""
      }
      <p class="window-note">Visible events from ${result.startYear} through ${result.endYear}</p>
      ${renderNearby(result.nearby, event.peakUtc)}`;
  } catch (error) {
    if (version !== locationVersion) return;
    locationResults.innerHTML = `<p class="error-state">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

async function selectEvent(event: EclipseSummary): Promise<void> {
  const version = ++selectionVersion;
  const listVersion = ++discoveryVersion;
  locationVersion += 1;
  futureButton.disabled = false;
  selectedEvent = event;
  rememberEvents([event]);
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
  const year = new Date(event.peakUtc).getUTCFullYear();
  yearInput.value = String(year);
  eventList.innerHTML =
    `<p class="working">Finding solar eclipses in ${year}…</p>`;
  writeUrlState();
  calculationStatus.textContent =
    event.kind === "partial"
      ? "Calculating global partial-eclipse visibility…"
      : "Calculating the complete central track and global visibility…";
  try {
    const [yearEvents, { scene }] = await Promise.all([
      eventsForYear(year),
      worker.calculateEventGeometry(event),
    ]);
    if (version !== selectionVersion) return;
    if (listVersion === discoveryVersion) {
      renderEvents(yearEvents, `Solar eclipses in ${year}`);
    }
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

function parseCoordinates(value: string): Observer | null {
  const match = value
    .trim()
    .match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*[, ]\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
  if (!match) return null;
  const latitudeDeg = Number(match[1]);
  const longitudeDeg = Number(match[2]);
  if (
    latitudeDeg < -90 ||
    latitudeDeg > 90 ||
    longitudeDeg < -180 ||
    longitudeDeg > 180
  ) {
    return null;
  }
  return { latitudeDeg, longitudeDeg, elevationMeters: 0 };
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
  futureButton.disabled = false;
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
      renderEvents(events, `Solar eclipses in ${year}`);
    })
    .catch((error) => {
      if (version !== discoveryVersion) return;
      eventList.innerHTML = `<p class="error-state">Eclipse search failed: ${escapeHtml(
        error instanceof Error ? error.message : String(error),
      )}</p>`;
    });
});

futureButton.addEventListener("click", () => {
  const version = ++discoveryVersion;
  futureButton.disabled = true;
  eventList.innerHTML =
    '<p class="working">Finding the next solar eclipses…</p>';
  void futureEvents(new Date().toISOString())
    .then((events) => {
      if (version !== discoveryVersion) return;
      renderEvents(events, "Next solar eclipses");
    })
    .catch((error) => {
      if (version !== discoveryVersion) return;
      eventList.innerHTML = `<p class="error-state">Eclipse search failed: ${escapeHtml(
        error instanceof Error ? error.message : String(error),
      )}</p>`;
    })
    .finally(() => {
      if (version === discoveryVersion) {
        futureButton.disabled = false;
      }
    });
});

coordinateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const observer = parseCoordinates(coordinateInput.value);
  if (!observer) {
    locationResults.innerHTML =
      '<p class="error-state">Enter decimal latitude and longitude, for example 41.39, 2.17.</p>';
    return;
  }
  void calculateLocation(observer);
});

windowInput.addEventListener("change", () => {
  if (selectedObserver) void calculateLocation(selectedObserver);
});

locateButton.addEventListener("click", () => {
  if (!navigator.geolocation) {
    locationResults.innerHTML =
      '<p class="error-state">Geolocation is unavailable in this browser.</p>';
    return;
  }
  locateButton.disabled = true;
  locateButton.textContent = "Locating…";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      locateButton.disabled = false;
      locateButton.textContent = "Use my current location";
      const observer = {
        latitudeDeg: position.coords.latitude,
        longitudeDeg: position.coords.longitude,
        elevationMeters: position.coords.altitude ?? 0,
      };
      coordinateInput.value = `${observer.latitudeDeg.toFixed(5)}, ${observer.longitudeDeg.toFixed(5)}`;
      void calculateLocation(observer);
    },
    () => {
      locateButton.disabled = false;
      locateButton.textContent = "Use my current location";
      locationResults.innerHTML =
        '<p class="error-state">Your location could not be determined.</p>';
    },
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
  );
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
      : await futureEvents(new Date().toISOString());
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
      coordinateInput.value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    }
    await selectEvent(selectedEvent);
  } catch (error) {
    eventSummary.innerHTML = `<p class="error-state">Eclipse discovery failed: ${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</p>`;
  }
}

void start();
