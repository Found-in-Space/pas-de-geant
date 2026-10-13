import "./tile-source-status.css";

/** Keep current provider failures visible without treating one retry as fatal. */
export function monitorTileSourceFailures(failureCount: () => number): void {
  const status = document.createElement("p");
  status.className = "tile-source-status";
  status.setAttribute("role", "alert");
  status.hidden = true;
  document.body.append(status);
  let previous = 0;
  let lastFailureAt = 0;
  const timer = window.setInterval(() => {
    const count = failureCount();
    if (count > previous) {
      lastFailureAt = Date.now();
      status.textContent = "A selected tile provider is unavailable. Check the tile server and session configuration.";
      status.hidden = false;
      document.body.dataset.tileSourceStatus = "unavailable";
    } else if (!status.hidden && Date.now() - lastFailureAt > 15_000) {
      status.hidden = true;
      document.body.dataset.tileSourceStatus = "ready";
    }
    previous = count;
  }, 1_000);
  window.addEventListener("pagehide", () => {
    window.clearInterval(timer);
    status.remove();
  }, { once: true });
}
