import "./style.css";

import { installRequestedXrEmulation } from "./xr-emulation.js";
export type { PasDeGeantXrEmulatorApi } from "./xr-emulation.js";

await installRequestedXrEmulation();
try {
  await import("./main.js");
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
