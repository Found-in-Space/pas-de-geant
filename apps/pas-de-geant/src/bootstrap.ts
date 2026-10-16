import "./style.css";

import { installRequestedXrEmulation } from "./xr-emulation.js";
export type { PasDeGeantXrEmulatorApi } from "./xr-emulation.js";

await installRequestedXrEmulation();
try {
  const [{ createWalkingApplication }, { loadSessionConfiguration }, { worldLaunchFromQuery }, { resolveInitialWorldLocation }] = await Promise.all([
    import("./main.js"), import("./session-config.js"), import("./world-launch.js"), import("./initial-location.js"),
  ]);
  const parameters = new URLSearchParams(window.location.search);
  const launch = worldLaunchFromQuery(parameters);
  if (launch.body === "moon") {
    document.title = `${launch.label ?? "Walk on the Moon"} — Pas de Géant`;
    const title = document.getElementById("preflight-title");
    if (title) title.textContent = launch.label ? `${launch.label} · 1:${launch.scaleDenominator}` : "Walk on the Moon";
    const check = document.querySelector("#world-check strong");
    if (check) check.textContent = "Lunar surface";
  }
  const browser = await createWalkingApplication({
    host: document.getElementById("scene-root")!, layout: document.body,
    configuration: await loadSessionConfiguration(), parameters, launch,
    initialLocation: launch.location ? Promise.resolve(launch.location) : resolveInitialWorldLocation(launch.body),
  });
  window.addEventListener("pagehide", () => { void browser.dispose(); }, { once: true });
} catch (error) {
  const check = document.getElementById("world-check");
  const status = document.getElementById("world-check-status");
  const errorState = document.getElementById("error-state");
  const message = document.getElementById("error-message");
  if (check) { check.dataset.state = "failed"; check.setAttribute("aria-busy", "false"); }
  if (status) status.textContent = "Could not load the world";
  if (errorState) errorState.hidden = false;
  if (message) message.textContent = error instanceof Error ? error.message : "Pas de Géant could not start.";
  throw error;
}
