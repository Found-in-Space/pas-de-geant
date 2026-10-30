import { describeGeantControlScheme, GEANT_ACTIONS } from "@found-in-space/pas-de-geant";
import { createDefaultSurfaceFactory } from "@found-in-space/pas-de-geant/browser";
import type { BitmapAllocation } from "@found-in-space/touch-os";
import { button, element, mountViewer, reportError, runCase } from "./case.js";
import { detectLocation } from "./location.js";
import { installStandardPanel } from "./standard-panel.js";

runCase(async () => {
  const abort = new AbortController();
  window.addEventListener("pagehide", () => abort.abort(), { once: true });
  // Request location immediately, while the surface starts loading.
  const initialLocation = detectLocation({ signal: abort.signal });
  // Attach a rejection handler while startup is pending; disposal can abort location first.
  void initialLocation.catch(() => {});
  let map: BitmapAllocation | undefined;
  const surface = createDefaultSurfaceFactory();
  const browser = await mountViewer("world", { bodies: ["earth"], xr: true, surfaces: { earth: async context => {
    const source = await surface(context), image = source.baseTexture.image;
    if (image instanceof ImageBitmap || image instanceof HTMLImageElement) map = { image, width: image.width, height: image.height };
    return source;
  } } });
  browser.addDisposable(() => abort.abort());
  await installStandardPanel(browser, element("touch-panel"), map);
  async function invoke(action: { id: string; payload?: unknown }) {
    const results = await browser.actions.invoke(action.id, action.payload);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  const mode = element<HTMLSelectElement>("mode");
  const show = (snapshot: ReturnType<typeof browser.getSnapshot>) => { mode.value = snapshot.mode; };
  browser.addDisposable(browser.navigation.subscribe(show)); show(browser.getSnapshot());
  mode.addEventListener("change", () => { void invoke({ id: GEANT_ACTIONS.setMode, payload: { mode: mode.value } }).catch(reportError); }, { signal: abort.signal });
  element("control-help").replaceChildren(...describeGeantControlScheme(browser.controls!.getSnapshot().scheme).map(text => {
    const item = document.createElement("li"); item.textContent = text; return item;
  }));
  async function locate(pending = detectLocation({ signal: abort.signal })) {
    const status = element("location-status");
    status.textContent = "Detecting your location…";
    const location = await pending;
    if (abort.signal.aborted) return;
    if (!location) { status.textContent = "Location unavailable. Select a place on the map; you can retry location detection."; return; }
    await invoke({ id: GEANT_ACTIONS.setLocation, payload: { body: "earth", ...location, altitudeM: 0 } });
    status.textContent = `${location.source === "device" ? "Device location" : "Approximate location from your IP address"}: ` +
      `${location.latitudeDegrees.toFixed(3)}°, ${location.longitudeDegrees.toFixed(3)}°.`;
  }
  button("locate", () => locate());
  void locate(initialLocation).catch(error => { if (!abort.signal.aborted) reportError(error); });
});
