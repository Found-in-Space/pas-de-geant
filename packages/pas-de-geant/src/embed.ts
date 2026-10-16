import { createGeantBrowser, type GeantBrowser, type GeantBrowserOptions } from "./browser.js";
import { resolveGeantConfiguration } from "./config.js";
import type { SolarSystemBodyId } from "./worlds/solar-system.js";
import { createModuleWorldWorkerFactory } from "./worlds/workers.js";

/** Both JavaScript and declarative mounting resolve through the same configuration validator. */
export function parseGeantAttributes(host: HTMLElement): Omit<GeantBrowserOptions, "host"> {
  const attr = (key: string) => host.getAttribute(`data-geant-${key}`);
  const number = (key: string) => {
    const value = attr(key); if (value === null) return undefined;
    if (!value.trim() || !Number.isFinite(Number(value))) throw new Error(`data-geant-${key} requires a finite number.`);
    return Number(value);
  };
  const boolean = (key: string): boolean | undefined => {
    const value = attr(key); if (value === null) return undefined;
    if (value === "true" || value === "") return true; if (value === "false") return false;
    throw new Error(`data-geant-${key} must be true or false.`);
  };
  const bodies = attr("bodies")?.split(/[\s,]+/).filter(Boolean) as SolarSystemBodyId[] | undefined;
  const location = attr("location")?.split(",").map(part => part.trim());
  if (location && (location.length !== 2 || location.some(part => !part || !Number.isFinite(Number(part))))) throw new Error("data-geant-location requires latitude,longitude in degrees.");
  const controls = attr("controls");
  if (controls !== null && !["none", "look", "grab", "orbit"].includes(controls)) throw new Error("Unknown data-geant-controls value.");
  const configuration = resolveGeantConfiguration({ bodies, focusBody: attr("focus-body") as SolarSystemBodyId | null ?? undefined,
    mode: attr("mode") as GeantBrowserOptions["mode"] ?? undefined,
    ...(location ? { location: { latitudeDegrees: Number(location[0]), longitudeDegrees: Number(location[1]) } } : {}),
    scaleDenominator: number("scale"), terrainMultiplier: number("terrain-multiplier"), time: attr("time") ?? undefined, timeRate: number("time-rate") });
  const datasetsValue = attr("datasets");
  let datasets: GeantBrowserOptions["datasets"];
  if (datasetsValue !== null) {
    const value: unknown = JSON.parse(datasetsValue);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("data-geant-datasets requires a per-body object.");
    for (const [body, selection] of Object.entries(value)) {
      if (!configuration.bodies.includes(body as SolarSystemBodyId) || !selection || typeof selection !== "object") throw new Error("Dataset selections must name selected bodies.");
      for (const [kind, rawBinding] of Object.entries(selection)) {
        const binding = rawBinding as Record<string, any>;
        if (!["imagery", "elevation"].includes(kind) || !binding || typeof binding !== "object" ||
          typeof binding.productUrl !== "string" || typeof binding.urlTemplate !== "string" || typeof binding.attribution !== "string" ||
          !binding.productUrl.trim() || !binding.attribution.trim()) throw new Error("Each dataset requires productUrl, urlTemplate and attribution.");
        if (binding.addressing !== undefined && !["xyz", "tms"].includes(binding.addressing)) throw new Error("Dataset addressing must be xyz or tms.");
        if (!["{z}", "{x}", "{y}"].every(token => binding.urlTemplate.includes(token))) throw new Error("Dataset tile templates require z/x/y tokens.");
        binding.productUrl = new URL(binding.productUrl, host.ownerDocument.baseURI).href;
      }
    }
    datasets = value as GeantBrowserOptions["datasets"];
  }
  const endpoint = attr("ai-endpoint");
  return { ...configuration, location: undefined, locations: configuration.locations, datasets,
    xr: boolean("xr") ?? false,
    stars: boolean("stars") ?? false,
    controls: controls === "none" ? false : { pointer: (controls ?? "look") as "look" | "grab" | "orbit", keyboard: boolean("keyboard"), movement: boolean("movement") },
    ...(endpoint ? { ai: { sessionEndpoint: new URL(endpoint, host.ownerDocument.baseURI).href, profile: attr("ai-profile") ?? undefined } } : {}) };
}
interface Mount { readonly abort: AbortController; readonly ready: Promise<GeantBrowser> }
const mounts = new WeakMap<HTMLElement, Mount>();
const errors = new WeakMap<HTMLElement, () => void>();
function clearError(host: HTMLElement) { errors.get(host)?.(); errors.delete(host); }
function showError(host: HTMLElement, error: unknown) {
  clearError(host);
  host.dispatchEvent(new CustomEvent("geant:error", { detail: error, bubbles: true }));
  const status = host.ownerDocument.createElement("p"); status.setAttribute("role", "alert");
  status.textContent = error instanceof Error ? error.message : "Pas de Géant could not start.";
  host.append(status);
  const retry = () => { void mount(host).catch(error => showError(host, error)); };
  host.addEventListener("geant:retry", retry);
  errors.set(host, () => { status.remove(); host.removeEventListener("geant:retry", retry); });
}
export function mount(host: HTMLElement, overrides: Omit<GeantBrowserOptions, "host"> = {}): Promise<GeantBrowser> {
  const existing = mounts.get(host); if (existing) return existing.ready;
  clearError(host);
  const abort = new AbortController();
  // Defer setup so the record exists before parsing or any startup rejection.
  const ready = Promise.resolve().then(async () => {
    const options = { ...parseGeantAttributes(host), ...overrides, host, signal: overrides.signal ? AbortSignal.any([abort.signal, overrides.signal]) : abort.signal };
    const ownWorkers = options.workers ?? createModuleWorldWorkerFactory();
    const browser = await createGeantBrowser({ ...options, workers: ownWorkers });
    const dispose = browser.dispose;
    const handle: GeantBrowser = { ...browser, get running() { return browser.running; }, async dispose() {
      try { await dispose(); } finally { if (mounts.get(host)?.abort === abort) mounts.delete(host); }
    } };
    return handle;
  });
  mounts.set(host, { abort, ready });
  void ready.catch(() => { if (mounts.get(host)?.abort === abort) mounts.delete(host); });
  return ready;
}
export async function unmount(host: HTMLElement): Promise<void> {
  clearError(host);
  const mount = mounts.get(host); if (!mount) return;
  mount.abort.abort();
  let browser: GeantBrowser;
  try { browser = await mount.ready; }
  catch { if (mounts.get(host) === mount) mounts.delete(host); return; }
  try { await browser.dispose(); }
  finally { if (mounts.get(host) === mount) mounts.delete(host); }
}

export function whenReady(host: HTMLElement): Promise<GeantBrowser> { return mounts.get(host)?.ready ?? mount(host); }
export async function mountAll(root: ParentNode = document): Promise<PromiseSettledResult<GeantBrowser>[]> {
  return Promise.allSettled([...root.querySelectorAll<HTMLElement>("[data-geant-browser]")].map(host => mount(host)));
}
export const Geant = { mount, unmount, whenReady, mountAll };
function autoMount() {
  for (const host of document.querySelectorAll<HTMLElement>("[data-geant-browser]")) {
    void mount(host).catch(error => showError(host, error));
  }
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount, { once: true });
  else queueMicrotask(autoMount);
}
