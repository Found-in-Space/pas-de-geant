import "./case.css";
import { createGeantBrowser, type GeantBrowser, type GeantBrowserOptions } from "@found-in-space/pas-de-geant/browser";

const instances = new Map<string, { browser: GeantBrowser; dispose: () => Promise<void> }>();

export function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`Missing case element: ${id}`);
  return target as T;
}

export function reportError(error: unknown): void {
  element("status").textContent = error instanceof Error ? error.message : String(error);
  element("status").setAttribute("role", "alert");
  console.error(error);
}

function snapshot() {
  return Object.fromEntries([...instances].map(([id, { browser }]) => [id, browser.getSnapshot()]));
}

function showState() {
  element("state").textContent = JSON.stringify(snapshot(), null, 2);
}

export function observeBrowser(id: string, browser: GeantBrowser, unmount = () => browser.dispose()): GeantBrowser {
  const unsubscribe = browser.navigation.subscribe(showState);
  instances.set(id, { browser, async dispose() {
    unsubscribe();
    await unmount();
    instances.delete(id);
    showState();
  } });
  showState();
  return browser;
}

const lifetime = new AbortController();

export async function mountViewer(id: string, options: Omit<GeantBrowserOptions, "host" | "signal"> = {}) {
  return observeBrowser(id, await createGeantBrowser({ ...options, host: element(id), signal: lifetime.signal }));
}

export async function disposeViewer(id: string) {
  await instances.get(id)?.dispose();
}

async function invoke(id: string, action: string, payload: unknown) {
  const instance = instances.get(id);
  if (!instance) throw new Error(`Viewer ${id} is not mounted.`);
  const results = await instance.browser.actions.invoke(action, payload);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return instance.browser.getSnapshot();
}

export function button(id: string, action: () => unknown | Promise<unknown>) {
  const target = element<HTMLButtonElement>(id);
  target.addEventListener("click", () => {
    target.disabled = true;
    void Promise.resolve().then(action).catch(reportError).finally(() => { target.disabled = false; });
  });
}

export function runCase(start: () => Promise<void>) {
  void start().then(() => { element("status").textContent = "Ready for manual checks."; }).catch(reportError);
}

// Development inspection uses public snapshots and actions; Geant imports no case code.
declare global {
  interface Window { geantIntegration: { snapshot: typeof snapshot; invoke: typeof invoke } }
}
window.geantIntegration = { snapshot, invoke };
window.addEventListener("pagehide", () => {
  lifetime.abort();
  for (const id of instances.keys()) void disposeViewer(id).catch(console.error);
}, { once: true });
