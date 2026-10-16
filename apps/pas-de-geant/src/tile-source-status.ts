import "./tile-source-status.css";

/** Keep current provider failures visible without treating one retry as fatal. */
export function monitorTileSourceFailures(failureCount: () => number, host: HTMLElement = document.body): () => void {
  const status = document.createElement("p");
  status.className = "tile-source-status";
  status.setAttribute("role", "alert");
  status.hidden = true;
  host.append(status);
  let previous = 0;
  let lastFailureAt = 0;
  const timer = window.setInterval(() => {
    const count = failureCount();
    if (count > previous) {
      lastFailureAt = Date.now();
      status.textContent = "A selected tile provider is unavailable. Check the tile server and session configuration.";
      status.hidden = false;
      host.dataset.tileSourceStatus = "unavailable";
    } else if (!status.hidden && Date.now() - lastFailureAt > 15_000) {
      status.hidden = true;
      host.dataset.tileSourceStatus = "ready";
    }
    previous = count;
  }, 1_000);
  const dispose = () => {
    window.clearInterval(timer);
    status.remove();
    window.removeEventListener("pagehide", dispose);
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
