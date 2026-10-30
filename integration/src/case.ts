import "./case.css";
import { createGeantBrowser, type GeantBrowser, type GeantBrowserOptions } from "@found-in-space/pas-de-geant/browser";
import type { BufferGeometry, Mesh, ShaderMaterial, Vector4 } from "three";

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
  return Object.fromEntries([...instances].map(([id, { browser }]) => [id, {
    ...browser.getSnapshot(),
    worlds: Object.fromEntries([...browser.worlds].map(([body, world]) => [body, {
      view: world.getView(), readiness: world.getReadiness(), tiles: world.surface?.getTileDebugControls(),
    }])),
  }]));
}

/** On-demand mesh inspection; it does no work in the viewer's frame loop. */
function terrain(id: string) {
  const instance = instances.get(id);
  if (!instance) throw new Error(`Viewer ${id} is not mounted.`);
  const { browser } = instance;
  return {
    navigation: browser.getSnapshot(),
    worlds: Object.fromEntries([...browser.worlds].map(([body, world]) => {
      const surface = world.surface;
      const patches = surface?.group.children.filter(child => child.name.startsWith("surface-tile:")).map(child => {
        const mesh = child as Mesh<BufferGeometry, ShaderMaterial>;
        const uv = mesh.geometry.getAttribute("tileUv");
        // The regular grid precedes its seam skirts in the public geometry.
        let columns = 1;
        while (columns < uv.count && uv.getY(columns) === uv.getY(0)) columns++;
        const tile = mesh.name.slice("surface-tile:".length);
        const zoom = Number(tile.split("/")[0]);
        const uniforms = mesh.material.uniforms;
        const transform = uniforms.elevationUvTransform!.value as Vector4;
        return {
          tile, visible: mesh.visible, segmentsAcross: columns - 1,
          triangles: mesh.geometry.index!.count / 3,
          elevationSourceZoom: uniforms.elevationEnabled!.value > 0 ? zoom + Math.log2(transform.x) : null,
        };
      });
      return [body, {
        pose: { position: world.object3d.position.toArray(), orientation: world.object3d.quaternion.toArray(),
          scale: world.object3d.scale.toArray() },
        view: world.getView(), lod: surface?.getLodStatus(),
        planner: surface?.getTilePlannerState().terrain, patches,
      }];
    })),
  };
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
  interface Window { geantIntegration: { snapshot: typeof snapshot; terrain: typeof terrain; invoke: typeof invoke } }
}
window.geantIntegration = { snapshot, terrain, invoke };
window.addEventListener("pagehide", () => {
  lifetime.abort();
  for (const id of instances.keys()) void disposeViewer(id).catch(console.error);
}, { once: true });
