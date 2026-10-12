import "./lunar-imagery-study.css";
import * as L from "leaflet";
import type { MultiPolygon } from "geojson";
import { LUNAR_DISPLAY_TONE_EXPONENT } from "./lunar-configuration.js";
import {
  APOLLO_STUDY_SITES, apolloImageryVersions, lunarStudyMetresPerPixel,
  lunarStudyTileBounds, lunarStudyToneTable, lunarStudyWmsUrl,
  lunarStudyBrightnessMatch,
  lunarStudyAreaBounds,
  LUNAR_STUDY_RADIUS_METRES, LUNAR_STUDY_TILE_WIDTH, LUNAR_STUDY_TILE_HEIGHT,
  type ApolloImageryVersion, type ApolloStudySite,
} from "./lunar-imagery-study.js";
import { paintLunarRegionalTile } from "./lunar-regional-imagery.js";
import { APOLLO_REGIONAL_IMAGERY, type LunarRegionalImagery } from "./lunar-regional-imagery-metadata.js";
import { geographicStudyPreview, paintLunarPreviewTile, type LunarPreviewProduct } from "./lunar-preview-pyramid.js";

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

type ComparisonMode = "blend" | "swipe" | "blink";
const siteSelect = element<HTMLSelectElement>("site");
const versionSelect = element<HTMLSelectElement>("version");
const referenceSelect = element<HTMLSelectElement>("reference");
const toneSelect = element<HTMLSelectElement>("tone");
const opacityInput = element<HTMLInputElement>("opacity");
const swipeInput = element<HTMLInputElement>("swipe");
const gainInput = element<HTMLInputElement>("gain");
const contrastInput = element<HTMLInputElement>("contrast");
const brightnessOffsetInput = element<HTMLInputElement>("brightness-offset");
const eastInput = element<HTMLInputElement>("east-offset");
const northInput = element<HTMLInputElement>("north-offset");
const pixelatedInput = element<HTMLInputElement>("pixelated");
const mapElement = element<HTMLDivElement>("study-map");
const query = new URLSearchParams(location.search);

let site: ApolloStudySite = APOLLO_STUDY_SITES.find((entry) => String(entry.mission) === query.get("site")) ?? APOLLO_STUDY_SITES[0]!;
let versions = apolloImageryVersions(site.mission);
let mode: ComparisonMode = ["blend", "swipe", "blink"].includes(query.get("mode") ?? "")
  ? query.get("mode") as ComparisonMode : "blend";
let showingBase = false;
let blinkCandidateVisible = true;
let blinkTimer: ReturnType<typeof setInterval> | undefined;
let urlTimer: ReturnType<typeof setTimeout> | undefined;
let currentCandidate: StudyTileLayer | undefined;
let currentReference: StudyTileLayer | undefined;
let marker: L.CircleMarker;
let areaOutline: L.Rectangle | undefined;
let areaKilometres = [50, 100].includes(Number(query.get("area"))) ? Number(query.get("area")) : query.has("zoom") ? 0 : 100;
let previewProduct: LunarPreviewProduct | undefined;
let previewError: string | undefined;
const coverageInput = element<HTMLInputElement>("show-coverage");
const footprintLayers: L.Layer[] = [];
const baseMaximumZoom = 8;
let baseTemplate = import.meta.env.PAS_DE_GEANT_LUNAR_STUDY_IMAGERY_URL_TEMPLATE ||
  "https://data.foundin.space/textures/moon/lroc-wac-global-100m/20261011.1/imagery/{z}/{x}/{y}.png";

function numeric(input: HTMLInputElement, fallback: number): number {
  return Number.isFinite(input.valueAsNumber) && input.checkValidity() ? input.valueAsNumber : fallback;
}

function setNumberFromQuery(input: HTMLInputElement, key: string): void {
  const value = query.get(key);
  if (value !== null && Number.isFinite(Number(value))) input.value = value;
}
setNumberFromQuery(opacityInput, "opacity");
setNumberFromQuery(swipeInput, "swipe");
setNumberFromQuery(gainInput, "gain");
setNumberFromQuery(contrastInput, "contrast");
setNumberFromQuery(brightnessOffsetInput, "offset");
setNumberFromQuery(eastInput, "east");
setNumberFromQuery(northInput, "north");
toneSelect.value = query.get("tone") === "stored" ? "stored" : "viewer";
pixelatedInput.checked = query.get("pixels") === "true";
mapElement.classList.toggle("show-base-pixels", pixelatedInput.checked);

function toneTable(candidate = false): Uint8ClampedArray {
  return lunarStudyToneTable(
    toneSelect.value === "viewer" ? LUNAR_DISPLAY_TONE_EXPONENT : 1,
    candidate ? numeric(gainInput, 1) : 1,
    candidate ? numeric(contrastInput, 1) : 1,
    candidate ? numeric(brightnessOffsetInput, 0) : 0,
  );
}

interface StudyLayerOptions {
  readonly base?: boolean;
  readonly candidate?: boolean;
  readonly version?: ApolloImageryVersion;
  readonly pane: string;
}

class StudyTileLayer extends L.GridLayer {
  private readonly rawPixels = new WeakMap<HTMLCanvasElement, ImageData>();
  private readonly loadingImages = new WeakMap<HTMLCanvasElement, HTMLImageElement>();
  private readonly regionalRequests = new WeakMap<HTMLCanvasElement, AbortController>();
  private readonly regionalImagery: LunarRegionalImagery | undefined;
  private table: Uint8ClampedArray;
  errors = 0;

  constructor(readonly studyOptions: StudyLayerOptions) {
    super({
      tileSize: L.point(LUNAR_STUDY_TILE_WIDTH, LUNAR_STUDY_TILE_HEIGHT),
      pane: studyOptions.pane,
      maxNativeZoom: studyOptions.base ? baseMaximumZoom : undefined,
      noWrap: true, bounds: L.latLngBounds([-90, -180], [90, 180]),
      keepBuffer: 1, updateWhenIdle: true,
      attribution: studyOptions.base ? "WAC: NASA/GSFC/ASU · Found in Space" : studyOptions.version?.pyramid ? "Kaguya: ISAS/JAXA · SELENE TC; NAC: NASA/GSFC/ASU · LROC" : "NAC: NASA/GSFC/ASU · LROC/Lunaserv",
    });
    this.table = toneTable(studyOptions.candidate);
    this.regionalImagery = studyOptions.version?.regional
      ? Object.values(APOLLO_REGIONAL_IMAGERY).find((entry) => entry.product === studyOptions.version?.layer) : undefined;
    this.on("loading", () => { this.errors = 0; updateStatus(); });
    this.on("load tileload tileerror", updateStatus);
    this.on("tileunload", (event: L.TileEvent) => {
      const tile: HTMLElement = event.tile;
      if (!(tile instanceof HTMLCanvasElement)) return;
      this.regionalRequests.get(tile)?.abort();
      const image = this.loadingImages.get(tile);
      if (image) { image.onload = null; image.onerror = null; image.src = ""; }
    });
  }

  override createTile(coords: L.Coords, done: L.DoneCallback): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = LUNAR_STUDY_TILE_WIDTH;
    // Keep all 512 stored base rows. Leaflet displays them over the correct
    // 512 × 256 geographic rectangle, without discarding vertical samples.
    canvas.height = this.studyOptions.base || this.studyOptions.version?.pyramid ? 512 : LUNAR_STUDY_TILE_HEIGHT;
    if (this.studyOptions.version?.pyramid) {
      if (!previewProduct) {
        queueMicrotask(() => { this.errors++; done(new Error(previewError ?? "The preview product is unavailable."), canvas); });
        return canvas;
      }
      const controller = new AbortController();
      this.regionalRequests.set(canvas, controller);
      void paintLunarPreviewTile(canvas, coords, controller.signal, previewProduct).then((errors) => {
        if (controller.signal.aborted) return;
        this.regionalRequests.delete(canvas);
        this.errors += errors.length;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        this.rawPixels.set(canvas, context.getImageData(0, 0, canvas.width, canvas.height));
        this.paint(canvas);
        done(undefined, canvas);
      }, (error: unknown) => {
        if (controller.signal.aborted) return;
        this.regionalRequests.delete(canvas);
        this.errors++;
        done(error instanceof Error ? error : new Error(String(error)), canvas);
      });
      return canvas;
    }
    if (this.regionalImagery) {
      const controller = new AbortController();
      this.regionalRequests.set(canvas, controller);
      void paintLunarRegionalTile(canvas, lunarStudyTileBounds(coords.z, coords.x, coords.y), controller.signal, this.regionalImagery).then(() => {
        if (controller.signal.aborted) return;
        this.regionalRequests.delete(canvas);
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        this.rawPixels.set(canvas, context.getImageData(0, 0, canvas.width, canvas.height));
        this.paint(canvas);
        done(undefined, canvas);
      }, (error: unknown) => {
        if (controller.signal.aborted) return;
        this.regionalRequests.delete(canvas);
        this.errors++;
        done(error instanceof Error ? error : new Error(String(error)), canvas);
      });
      return canvas;
    }
    const image = new Image();
    image.crossOrigin = "anonymous";
    this.loadingImages.set(canvas, image);
    image.onload = () => {
      this.loadingImages.delete(canvas);
      try {
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        this.rawPixels.set(canvas, context.getImageData(0, 0, canvas.width, canvas.height));
        this.paint(canvas);
        done(undefined, canvas);
      } catch (error) {
        this.errors++;
        done(error instanceof Error ? error : new Error(String(error)), canvas);
      }
    };
    image.onerror = () => {
      this.loadingImages.delete(canvas);
      this.errors++;
      done(new Error("The image source could not be loaded."), canvas);
    };
    image.src = this.studyOptions.base
      ? baseTemplate.replaceAll("{z}", String(coords.z)).replaceAll("{x}", String(coords.x)).replaceAll("{y}", String(coords.y))
      : lunarStudyWmsUrl(this.studyOptions.version!.layer, lunarStudyTileBounds(coords.z, coords.x, coords.y));
    return canvas;
  }

  private paint(canvas: HTMLCanvasElement): void {
    const raw = this.rawPixels.get(canvas);
    if (!raw) return;
    const output = new ImageData(new Uint8ClampedArray(raw.data), raw.width, raw.height);
    for (let index = 0; index < output.data.length; index += 4) {
      output.data[index] = this.table[raw.data[index]!]!;
      output.data[index + 1] = this.table[raw.data[index + 1]!]!;
      output.data[index + 2] = this.table[raw.data[index + 2]!]!;
      // Preserve alpha exactly: a dark valid source pixel is not missing data.
    }
    canvas.getContext("2d")!.putImageData(output, 0, 0);
  }

  refreshTone(): void {
    this.table = toneTable(this.studyOptions.candidate);
    this.getContainer()?.querySelectorAll<HTMLCanvasElement>("canvas").forEach((canvas) => this.paint(canvas));
  }

  /** Unadjusted samples at the same ground locations. Element bounds include
   * zoom and metre offsets; blend opacity and swipe clipping do not affect this.
   */
  sampleView(width: number, height: number): ImageData {
    const sample = document.createElement("canvas");
    sample.width = width; sample.height = height;
    const context = sample.getContext("2d", { willReadFrequently: true })!;
    context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
    const view = mapElement.getBoundingClientRect();
    const canvases = [...this.getContainer()?.querySelectorAll<HTMLCanvasElement>("canvas") ?? []];
    canvases.sort((first, second) => Number(first.parentElement!.style.zIndex) - Number(second.parentElement!.style.zIndex));
    for (const canvas of canvases) {
      const raw = this.rawPixels.get(canvas);
      const bounds = canvas.getBoundingClientRect();
      if (!raw || bounds.right <= view.left || bounds.left >= view.right || bounds.bottom <= view.top || bounds.top >= view.bottom) continue;
      const original = document.createElement("canvas");
      original.width = raw.width; original.height = raw.height;
      original.getContext("2d")!.putImageData(raw, 0, 0);
      context.drawImage(original,
        (bounds.left - view.left) / view.width * width, (bounds.top - view.top) / view.height * height,
        bounds.width / view.width * width, bounds.height / view.height * height);
    }
    return context.getImageData(0, 0, width, height);
  }

  hasImagery(): boolean {
    const canvases = this.getContainer()?.querySelectorAll<HTMLCanvasElement>("canvas");
    if (!canvases) return false;
    for (const canvas of canvases) {
      const raw = this.rawPixels.get(canvas);
      if (!raw) continue;
      for (let index = 3; index < raw.data.length; index += 4) if (raw.data[index]! > 0) return true;
    }
    return false;
  }
}

// One z=0 source tile covers 360° × 180°. Displaying it as 512 × 256
// keeps longitude/latitude at the same angular scale, rather than Mercator.
const lunarCrs = L.Util.extend({}, L.CRS.Simple, {
  code: "IAU2000:30100", projection: L.Projection.LonLat,
  transformation: new L.Transformation(1 / 360, 0.5, -1 / 360, 0.25),
  scale: (zoom: number) => LUNAR_STUDY_TILE_WIDTH * 2 ** zoom,
  zoom: (scale: number) => Math.log2(scale / LUNAR_STUDY_TILE_WIDTH),
  infinite: false,
  distance(first: L.LatLng, second: L.LatLng): number {
    const radians = Math.PI / 180;
    const halfLatitude = (second.lat - first.lat) * radians / 2;
    const halfLongitude = (second.lng - first.lng) * radians / 2;
    const haversine = Math.sin(halfLatitude) ** 2 + Math.cos(first.lat * radians) * Math.cos(second.lat * radians) * Math.sin(halfLongitude) ** 2;
    return 2 * LUNAR_STUDY_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(haversine)));
  },
}) as L.CRS;

const map = L.map(mapElement, {
  crs: lunarCrs, minZoom: 0, maxZoom: 18, zoomSnap: 0.25, zoomDelta: 0.5,
  zoomControl: false, zoomAnimation: false, fadeAnimation: false,
  attributionControl: true,
});
L.control.zoom({ position: "topright" }).addTo(map);
const basePane = map.createPane("wac-base");
basePane.classList.add("wac-base-pane");
basePane.style.zIndex = "200";
map.createPane("study-reference").style.zIndex = "300";
const candidatePane = map.createPane("study-candidate");
candidatePane.style.zIndex = "400";
// Footprints, the area outline and LM marker must stay above opaque imagery.
map.getPane("overlayPane")!.style.zIndex = "450";
let baseLayer: StudyTileLayer;

function selectedVersion(): ApolloImageryVersion {
  return versions.find((version) => version.id === versionSelect.value) ?? versions[0]!;
}

function coordinates(latitude: number, longitude: number, places = 5): string {
  return `${Math.abs(latitude).toFixed(places)}° ${latitude < 0 ? "S" : "N"} · ${Math.abs(longitude).toFixed(places)}° ${longitude < 0 ? "W" : "E"}`;
}

function updateStatus(): void {
  if (!baseLayer) return;
  element("base-status").textContent = baseLayer.errors ? "WAC base: source request failed" : baseLayer.isLoading() ? "Loading WAC base…" : "WAC base · 100 m";
  const candidate = currentCandidate;
  element("candidate-status").textContent = !candidate ? "Choose a candidate" : candidate.errors
    ? selectedVersion().pyramid && previewError ? previewError : "Some imagery requests failed · coarser imagery remains visible" : candidate.isLoading() ? "Loading candidate…"
      : candidate.hasImagery() ? `${selectedVersion().label} · ready` : "No candidate coverage here · try another version or view";
  if (currentReference?.errors) element("candidate-status").textContent += " · Reference request failed";
  element("retry").hidden = !baseLayer.errors && !candidate?.errors && !currentReference?.errors;
  element<HTMLButtonElement>("match-brightness").disabled = baseLayer.isLoading() || !candidate || candidate.isLoading() || !candidate.hasImagery();
}

function updateComposite(): void {
  if (!currentCandidate) return;
  const centre = map.getCenter();
  const degreesPerMetre = 180 / (Math.PI * LUNAR_STUDY_RADIUS_METRES);
  const origin = map.project(centre);
  const shifted = map.project(L.latLng(
    centre.lat + numeric(northInput, 0) * degreesPerMetre,
    centre.lng + numeric(eastInput, 0) * degreesPerMetre / Math.cos(centre.lat * Math.PI / 180),
  ));
  const offset = shifted.subtract(origin);
  candidatePane.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
  currentReference?.setOpacity(showingBase ? 0 : 1);
  currentCandidate.setOpacity(showingBase ? 0 : mode === "blend" ? numeric(opacityInput, 65) / 100 : mode === "blink" && !blinkCandidateVisible ? 0 : 1);
  const container = currentCandidate.getContainer();
  if (container) {
    if (mode === "swipe") {
      const topLeft = map.containerPointToLayerPoint(L.point(0, 0)).subtract(offset);
      const size = map.getSize();
      const divider = numeric(swipeInput, 50) / 100;
      container.style.clip = `rect(${topLeft.y}px, ${topLeft.x + size.x}px, ${topLeft.y + size.y}px, ${topLeft.x + size.x * divider}px)`;
    } else container.style.clip = "";
  }
  element("swipe-divider").style.left = `${swipeInput.value}%`;
  element("swipe-handle").setAttribute("aria-valuenow", swipeInput.value);
  element("base-flash").hidden = !showingBase;
}

function updateReadout(): void {
  const centre = map.getCenter();
  const metresPerPixel = lunarStudyMetresPerPixel(centre.lat, map.getZoom());
  element("view-coordinates").textContent = coordinates(centre.lat, centre.lng, 4);
  element("sampling-readout").textContent = `${metresPerPixel >= 10 ? metresPerPixel.toFixed(0) : metresPerPixel.toFixed(2)} m / screen pixel · z ${map.getZoom().toFixed(2)}`;
  const target = metresPerPixel * 100;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const scale = [1, 2, 5].map((factor) => factor * magnitude).filter((distance) => distance <= target).at(-1) ?? magnitude;
  element("scale-bar").style.width = `${scale / metresPerPixel}px`;
  element("scale-label").textContent = scale >= 1000 ? `${scale / 1000} km` : `${scale} m`;
  updateComposite();
}

function writeComparisonUrl(): void {
  const centre = map.getCenter();
  const parameters = new URLSearchParams({
    site: String(site.mission), image: versionSelect.value, reference: referenceSelect.value,
    mode, tone: toneSelect.value, pixels: String(pixelatedInput.checked), opacity: opacityInput.value, swipe: swipeInput.value,
    lat: centre.lat.toFixed(6), lon: centre.lng.toFixed(6), zoom: map.getZoom().toFixed(2),
    gain: gainInput.value, contrast: contrastInput.value, offset: brightnessOffsetInput.value, east: eastInput.value, north: northInput.value,
    area: String(areaKilometres),
  });
  history.replaceState(null, "", `${location.pathname}?${parameters}`);
}

function updateLink(): void {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(writeComparisonUrl, 150);
}

interface Assessment { readonly [key: string]: unknown }
const assessmentStorageKey = "pas-de-geant-apollo-imagery-assessments-v1";
let assessments: Record<string, Assessment> = {};
try { assessments = JSON.parse(localStorage.getItem(assessmentStorageKey) ?? "{}"); } catch { /* Assessments are optional browser-local records. */ }
function assessmentKey(): string { return `${site.mission}/${versionSelect.value}`; }
function loadAssessment(): void {
  const assessment = assessments[assessmentKey()];
  element<HTMLSelectElement>("verdict").value = typeof assessment?.verdict === "string" ? assessment.verdict : "unreviewed";
  element<HTMLTextAreaElement>("notes").value = typeof assessment?.notes === "string" ? assessment.notes : "";
}
function currentAssessment(): Assessment {
  const centre = map.getCenter();
  return {
    site: site.mission, version: selectedVersion().label, layer: selectedVersion().layer,
    source: selectedVersion().sourceUrl ?? "https://wms.im-ldi.com/", baseTemplate, baseMaximumZoom,
    centre: { latitude: centre.lat, longitude: centre.lng }, zoom: map.getZoom(),
    areaKilometres,
    comparison: { reference: referenceSelect.value, mode, opacity: numeric(opacityInput, 65) / 100 },
    display: { exponent: toneSelect.value === "viewer" ? LUNAR_DISPLAY_TONE_EXPONENT : 1, gain: numeric(gainInput, 1), contrast: numeric(contrastInput, 1), offset: numeric(brightnessOffsetInput, 0) },
    alignment: { eastMetres: numeric(eastInput, 0), northMetres: numeric(northInput, 0) },
    verdict: element<HTMLSelectElement>("verdict").value,
    notes: element<HTMLTextAreaElement>("notes").value,
    recordedAt: new Date().toISOString(),
  };
}

function updateLayers(): void {
  if (currentCandidate) map.removeLayer(currentCandidate);
  if (currentReference) map.removeLayer(currentReference);
  currentReference = undefined;
  const referenceVersion = versions.find((version) => version.id === referenceSelect.value);
  if (referenceVersion) currentReference = new StudyTileLayer({ pane: "study-reference", version: referenceVersion }).addTo(map);
  const version = selectedVersion();
  currentCandidate = new StudyTileLayer({ pane: "study-candidate", candidate: true, version }).addTo(map);
  element("version-description").textContent = version.description;
  element("source-layer").textContent = version.layer;
  element<HTMLAnchorElement>("source-link").href = version.sourceUrl ?? `https://www.lroc.im-ldi.com/featured_sites/apollo-${site.mission}/flip-book`;
  element("source-link").textContent = version.regional ? "LROC regional mosaic ↗" : "LROC site images ↗";
  if (version.pyramid) element("source-link").textContent = "Kaguya context source ↗";
  element("pyramid-controls").hidden = !version.pyramid;
  updateFootprints();
  element("regional-view").hidden = !version.regional;
  element("match-status").textContent = "Matches overlapping terrain at the base map’s scale. Pan to the join before matching; shadows remain part of the observation.";
  element("candidate-label").textContent = version.label;
  element("reference-label").textContent = referenceVersion?.label ?? "Our WAC base · 100 m";
  updateComposite();
  updateStatus();
  updateLink();
}

function populateVersions(candidateId = "high-resolution", referenceId = "base"): void {
  versions = apolloImageryVersions(site.mission);
  versionSelect.replaceChildren(...versions.map((version) => new Option(version.label, version.id)));
  referenceSelect.replaceChildren(new Option("Our WAC base · 100 m", "base"), ...versions.map((version) => new Option(version.label, version.id)));
  versionSelect.value = versions.some((version) => version.id === candidateId) ? candidateId : versions[0]!.id;
  referenceSelect.value = versions.some((version) => version.id === referenceId) ? referenceId : "base";
}

function showSite(): void {
  element("map-title").textContent = `Apollo ${site.mission} · ${site.name}`;
  element("site-coordinates").textContent = coordinates(site.latitude, site.longitude);
  marker?.remove();
  marker = L.circleMarker([site.latitude, site.longitude], {
    radius: 5, color: "#f0d6a5", weight: 1.5, fillColor: "#15191f", fillOpacity: 0.8,
  }).bindTooltip(`Apollo ${site.mission} · LM location`, { direction: "top", offset: [0, -6] }).addTo(map);
  updateAreaOutline();
}

function areaBounds(): L.LatLngBounds {
  const [west, south, east, north] = lunarStudyAreaBounds(site, areaKilometres);
  return L.latLngBounds([south, west], [north, east]);
}

function updateAreaOutline(): void {
  areaOutline?.remove(); areaOutline = undefined;
  if (areaKilometres) areaOutline = L.rectangle(areaBounds(), {
    color: "#ebc38a", weight: 1.5, dashArray: "5 6", fill: false, interactive: false,
  }).addTo(map);
  element("area-readout").textContent = areaKilometres ? `Outlined area · ${areaKilometres} × ${areaKilometres} km` : site.mission === 11 ? "Area views show the variable-resolution pyramid." : "Area views select the regional mosaic. The WAC base fills gaps.";
  document.querySelectorAll<HTMLButtonElement>("[data-area]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.area) === areaKilometres)));
}

function showArea(kilometres: number): void {
  areaKilometres = kilometres;
  const areaVersion = site.mission === 11 ? "pyramid" : "regional";
  if (versionSelect.value !== areaVersion) {
    versionSelect.value = areaVersion;
    gainInput.value = "1"; contrastInput.value = "1"; brightnessOffsetInput.value = "0"; eastInput.value = "0"; northInput.value = "0";
    updateLayers(); loadAssessment();
  }
  updateAreaOutline();
  map.fitBounds(areaBounds(), { padding: [30, 30], animate: false });
  updateLink();
}

function updateFootprints(): void {
  for (const layer of footprintLayers) layer.remove();
  footprintLayers.length = 0;
  if (!coverageInput.checked || !selectedVersion().pyramid || !previewProduct) return;
  for (const [index, detail] of previewProduct.details.entries()) {
    const [west, south, east, north] = detail.bounds;
    footprintLayers.push(L.rectangle([[south, west], [north, east]], { color: index ? "#eeb388" : "#acd5e0", weight: 1, dashArray: "3 5", fill: false, interactive: false }).addTo(map));
    // Clip actual masks to the chosen band; GeoJSON keeps holes and islands.
    const clipped = detail.region.coverage.map((polygon) => polygon.map((ring) => clipFootprintRing(ring, detail.bounds)).filter((ring) => ring.length >= 4)).filter((polygon) => polygon.length);
    const footprint: MultiPolygon = { type: "MultiPolygon", coordinates: clipped };
    footprintLayers.push(L.geoJSON(footprint, {
      style: { color: index ? "#eeb388" : "#acd5e0", weight: 1, fillOpacity: .06 }, interactive: false,
    }).addTo(map));
  }
}

/** Sutherland–Hodgman clipping for the rectangular preview bands. */
function clipFootprintRing(ring: number[][], bounds: readonly number[]): number[][] {
  let points = ring.slice(0, -1);
  for (const [axis, edge, greater] of [[0, bounds[0]!, true], [0, bounds[2]!, false], [1, bounds[1]!, true], [1, bounds[3]!, false]] as const) {
    const output: number[][] = [];
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!; const b = points[(index + 1) % points.length]!;
      const insideA = greater ? a[axis]! >= edge : a[axis]! <= edge;
      const insideB = greater ? b[axis]! >= edge : b[axis]! <= edge;
      if (insideA) output.push(a);
      if (insideA !== insideB) {
        const ratio = (edge - a[axis]!) / (b[axis]! - a[axis]!);
        output.push([a[0]! + ratio * (b[0]! - a[0]!), a[1]! + ratio * (b[1]! - a[1]!)]);
      }
    }
    points = output;
  }
  return points.length ? [...points, points[0]!] : [];
}

function setMode(nextMode: ComparisonMode): void {
  mode = nextMode;
  clearInterval(blinkTimer);
  blinkTimer = undefined;
  blinkCandidateVisible = true;
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mode === mode)));
  opacityInput.disabled = mode !== "blend";
  element("swipe-control").hidden = mode !== "swipe";
  element("swipe-divider").hidden = mode !== "swipe";
  element("comparison-labels").hidden = mode !== "swipe";
  if (mode === "blink") blinkTimer = setInterval(() => {
    if (document.hidden) return;
    blinkCandidateVisible = !blinkCandidateVisible;
    updateComposite();
  }, 800);
  updateComposite();
  updateLink();
}

function holdBase(held: boolean): void { showingBase = held; updateComposite(); }
function applyAdjustments(): void {
  currentCandidate?.refreshTone();
  updateComposite();
  updateLink();
}

function matchBrightness(): void {
  if (!currentCandidate) return;
  const size = map.getSize();
  const horizontalMetres = lunarStudyMetresPerPixel(map.getCenter().lat, map.getZoom());
  const verticalMetres = horizontalMetres / Math.cos(map.getCenter().lat * Math.PI / 180);
  const width = Math.max(1, Math.ceil(size.x / Math.max(1, 100 / horizontalMetres)));
  const height = Math.max(1, Math.ceil(size.y / Math.max(1, 100 / verticalMetres)));
  const result = lunarStudyBrightnessMatch(
    currentCandidate.sampleView(width, height).data, baseLayer.sampleView(width, height).data,
    toneSelect.value === "viewer" ? LUNAR_DISPLAY_TONE_EXPONENT : 1,
  );
  if (!result) {
    element("match-status").textContent = "No usable overlap in this view. Centre the imagery over the base and try the Join or Context view.";
    return;
  }
  gainInput.value = result.gain.toFixed(3);
  contrastInput.value = "1"; brightnessOffsetInput.value = "0";
  applyAdjustments();
  element("match-status").textContent = `Gain ${gainInput.value} from ${result.samples.toLocaleString()} overlapping terrain samples. Contrast preserved. This is a display match; refine it below if the lighting differs.`;
}

async function start(): Promise<void> {
  // Read the same runtime API configuration as this development server. A
  // static deployment uses the public template injected by Vite instead.
  try {
    const response = await fetch(new URL("../../api/config", location.href), { signal: AbortSignal.timeout(5000) });
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
      const configuration = await response.json() as Record<string, unknown>;
      if (typeof configuration.PAS_DE_GEANT_LUNAR_STUDY_IMAGERY_URL_TEMPLATE === "string" && configuration.PAS_DE_GEANT_LUNAR_STUDY_IMAGERY_URL_TEMPLATE) baseTemplate = configuration.PAS_DE_GEANT_LUNAR_STUDY_IMAGERY_URL_TEMPLATE;
    }
  } catch { /* A static build already carries its public source configuration. */ }
  try {
    const response = await fetch("/lunar-preview/product.json");
    if (!response.ok) throw new Error("Apollo 11 preview unavailable · build its context tiles first");
    previewProduct = geographicStudyPreview(await response.json() as LunarPreviewProduct);
    element("coverage-summary").textContent = previewProduct.resolutionCoverage?.filter((entry) => entry.coveragePercent > 0).map((entry) => `${entry.metresPerPixel.toFixed(entry.metresPerPixel < 1 ? 2 : 1)} m/px: ${entry.coveragePercent.toFixed(1)}%`).join(" · ") ?? "";
  } catch (error) { previewError = error instanceof Error ? error.message : String(error); }
  siteSelect.replaceChildren(...APOLLO_STUDY_SITES.map((entry) => new Option(`Apollo ${entry.mission} · ${entry.name}`, String(entry.mission))));
  siteSelect.value = String(site.mission);
  populateVersions(query.get("image") ?? (site.mission === 11 ? "pyramid" : "regional"), query.get("reference") ?? "base");
  if (!query.has("opacity")) opacityInput.value = "100";
  coverageInput.addEventListener("change", updateFootprints);
  const latitude = Number(query.get("lat"));
  const longitude = Number(query.get("lon"));
  const zoom = Number(query.get("zoom"));
  map.setView(
    query.has("lat") && query.has("lon") && Number.isFinite(latitude) && Number.isFinite(longitude) ? [latitude, longitude] : [site.latitude, site.longitude],
    query.has("zoom") && Number.isFinite(zoom) ? zoom : 12,
  );
  baseLayer = new StudyTileLayer({ base: true, pane: "wac-base" }).addTo(map);
  showSite();
  if (areaKilometres && !query.has("zoom")) map.fitBounds(areaBounds(), { padding: [30, 30], animate: false });
  updateLayers();
  loadAssessment();
  setMode(mode);
  updateReadout();

  siteSelect.addEventListener("change", () => {
    const previousVersion = versionSelect.value;
    const previousReference = referenceSelect.value;
    site = APOLLO_STUDY_SITES.find((entry) => String(entry.mission) === siteSelect.value)!;
    populateVersions(previousVersion, previousReference);
    eastInput.value = "0"; northInput.value = "0";
    gainInput.value = "1"; contrastInput.value = "1"; brightnessOffsetInput.value = "0";
    if (areaKilometres) map.fitBounds(areaBounds(), { padding: [30, 30], animate: false });
    else map.setView([site.latitude, site.longitude], 12, { animate: false });
    showSite();
    updateLayers();
    loadAssessment();
  });
  versionSelect.addEventListener("change", () => {
    gainInput.value = "1"; contrastInput.value = "1"; brightnessOffsetInput.value = "0"; eastInput.value = "0"; northInput.value = "0";
    updateLayers();
    loadAssessment();
  });
  referenceSelect.addEventListener("change", updateLayers);
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode as ComparisonMode)));
  opacityInput.addEventListener("input", () => { element("opacity-value").textContent = `${opacityInput.value}%`; updateComposite(); updateLink(); });
  swipeInput.addEventListener("input", () => { element("swipe-value").textContent = `${swipeInput.value}%`; updateComposite(); updateLink(); });
  element("opacity-value").textContent = `${opacityInput.value}%`;
  element("swipe-value").textContent = `${swipeInput.value}%`;
  toneSelect.addEventListener("change", () => {
    baseLayer.refreshTone(); currentReference?.refreshTone(); currentCandidate?.refreshTone(); updateLink();
  });
  [gainInput, contrastInput, brightnessOffsetInput, eastInput, northInput].forEach((input) => input.addEventListener("input", applyAdjustments));
  element("match-brightness").addEventListener("click", matchBrightness);
  element("regional-view").addEventListener("click", () => {
    areaKilometres = 0; updateAreaOutline();
    const [west, south, east, north] = APOLLO_REGIONAL_IMAGERY[site.mission]!.bounds;
    map.fitBounds([[south!, west!], [north!, east!]], { padding: [30, 30], animate: false });
  });
  element("reset-adjustments").addEventListener("click", () => {
    gainInput.value = "1"; contrastInput.value = "1"; brightnessOffsetInput.value = "0"; eastInput.value = "0"; northInput.value = "0"; applyAdjustments();
    element("match-status").textContent = "Candidate brightness and alignment reset.";
  });
  pixelatedInput.addEventListener("change", () => {
    mapElement.classList.toggle("show-base-pixels", pixelatedInput.checked);
    updateLink();
  });
  for (const [id, viewZoom] of [["context-view", 10], ["join-view", 12], ["detail-view", 15]] as const) {
    element(id).addEventListener("click", () => { areaKilometres = 0; updateAreaOutline(); map.setView([site.latitude, site.longitude], viewZoom, { animate: false }); });
  }
  document.querySelectorAll<HTMLButtonElement>("[data-area]").forEach((button) => button.addEventListener("click", () => showArea(Number(button.dataset.area))));
  const baseButton = element<HTMLButtonElement>("hold-base");
  baseButton.addEventListener("pointerdown", (event) => { baseButton.setPointerCapture(event.pointerId); holdBase(true); });
  baseButton.addEventListener("pointerup", () => holdBase(false));
  baseButton.addEventListener("pointercancel", () => holdBase(false));
  baseButton.addEventListener("keydown", (event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault(); holdBase(true); } });
  baseButton.addEventListener("keyup", () => holdBase(false));
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    if (event.key.toLowerCase() === "b") { event.preventDefault(); holdBase(true); }
  });
  document.addEventListener("keyup", (event) => { if (event.key.toLowerCase() === "b") holdBase(false); });
  window.addEventListener("blur", () => holdBase(false));

  const handle = element<HTMLButtonElement>("swipe-handle");
  let draggingDivider = false;
  handle.addEventListener("pointerdown", (event) => { event.preventDefault(); draggingDivider = true; handle.setPointerCapture(event.pointerId); });
  handle.addEventListener("pointermove", (event) => {
    if (!draggingDivider) return;
    const bounds = mapElement.getBoundingClientRect();
    swipeInput.value = String(Math.round(Math.max(0, Math.min(100, (event.clientX - bounds.left) / bounds.width * 100))));
    swipeInput.dispatchEvent(new Event("input"));
  });
  handle.addEventListener("pointerup", () => { draggingDivider = false; });
  handle.addEventListener("pointercancel", () => { draggingDivider = false; });
  handle.addEventListener("keydown", (event) => {
    const change = event.key === "ArrowRight" ? 5 : event.key === "ArrowLeft" ? -5 : 0;
    if (change) { event.preventDefault(); swipeInput.value = String(numeric(swipeInput, 50) + change); swipeInput.dispatchEvent(new Event("input")); }
  });

  element("retry").addEventListener("click", () => { baseLayer.redraw(); currentReference?.redraw(); currentCandidate?.redraw(); });
  element("copy-link").addEventListener("click", async () => {
    clearTimeout(urlTimer);
    writeComparisonUrl();
    try {
      await navigator.clipboard.writeText(location.href);
      element("copy-link").textContent = "Comparison link copied";
      setTimeout(() => { element("copy-link").textContent = "Copy this comparison link"; }, 2000);
    } catch { element("copy-link").textContent = "Copy the URL from your address bar"; }
  });
  element("save-notes").addEventListener("click", () => {
    assessments[assessmentKey()] = currentAssessment();
    try {
      localStorage.setItem(assessmentStorageKey, JSON.stringify(assessments));
      element("notes-status").textContent = `Saved Apollo ${site.mission} · ${selectedVersion().label}.`;
    } catch { element("notes-status").textContent = "Browser storage is unavailable. Export the study to keep these notes."; }
  });
  element("export-notes").addEventListener("click", () => {
    const entries = { ...assessments, [assessmentKey()]: currentAssessment() };
    const url = URL.createObjectURL(new Blob([JSON.stringify({ formatVersion: 1, purpose: "Visual source selection; not publication evidence", assessments: entries }, null, 2) + "\n"], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "apollo-imagery-study.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  map.on("move zoom resize", updateReadout);
  map.on("moveend zoomend", updateLink);
  new ResizeObserver(() => map.invalidateSize()).observe(mapElement);
}

void start().catch((error: unknown) => {
  const failure = element("startup-error");
  failure.hidden = false;
  failure.textContent = error instanceof Error ? error.message : "The imagery comparison could not start.";
});
