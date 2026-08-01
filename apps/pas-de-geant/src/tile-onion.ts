import "./tile-onion.css";

import {
  WEB_MERCATOR_MAX_LATITUDE,
  calculateTileOnionPlan,
  wrapLongitude,
  type TileAddress,
  type TileOnionPlan,
  type TileOnionState,
} from "./tile-onion-core.js";

const POLAR_GUTTER = 0.14;
const VIEW_PADDING = 42;

function requiredElement<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing tile-onion element #${id}`);
  return value as T;
}

const shell = requiredElement<HTMLDivElement>("map-shell");
const canvas = requiredElement<HTMLCanvasElement>("tile-map");

function requiredCanvasContext(
  target: HTMLCanvasElement,
): CanvasRenderingContext2D {
  const value = target.getContext("2d");
  if (!value) throw new Error("The tile-onion demo requires a 2D canvas.");
  return value;
}

const context = requiredCanvasContext(canvas);

const form = requiredElement<HTMLFormElement>("coordinate-form");
const latitudeInput = requiredElement<HTMLInputElement>("latitude");
const longitudeInput = requiredElement<HTMLInputElement>("longitude");
const maxZoomInput = requiredElement<HTMLInputElement>("max-zoom");
const maxZoomValue = requiredElement<HTMLElement>("max-zoom-value");
const fitWorldButton = requiredElement<HTMLButtonElement>("fit-world");
const validationMessage = requiredElement<HTMLElement>("validation-message");
const modeBadge = requiredElement<HTMLElement>("mode-badge");
const coordinateReadout = requiredElement<HTMLElement>("coordinate-readout");
const zoomReadout = requiredElement<HTMLElement>("zoom-readout");
const underfootReadout = requiredElement<HTMLElement>("underfoot-readout");
const anchorReadout = requiredElement<HTMLElement>("anchor-readout");
const fineCountReadout = requiredElement<HTMLElement>("fine-count-readout");
const leafCountReadout = requiredElement<HTMLElement>("leaf-count-readout");
const levelCountReadout = requiredElement<HTMLElement>("level-count-readout");
const edgeDistanceReadout = requiredElement<HTMLElement>(
  "edge-distance-readout",
);
const poleLockReadout = requiredElement<HTMLElement>("pole-lock-readout");
const zoomLegend = requiredElement<HTMLElement>("zoom-legend");
const tileList = requiredElement<HTMLElement>("tile-list");

let viewportWidth = 1;
let viewportHeight = 1;
let fitScale = 1;
let viewScale = 1;
let viewCentreX = 0.5;
let viewCentreY = 0.5;
let latitudeDegrees = Number(latitudeInput.value);
let longitudeDegrees = Number(longitudeInput.value);
let plannerState: TileOnionState | undefined;
let committedPlan: TileOnionPlan | undefined;

function normalizedMercatorY(latitude: number): number {
  const radians =
    Math.max(
      -WEB_MERCATOR_MAX_LATITUDE,
      Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude),
    ) *
    Math.PI /
    180;
  return (
    1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI
  ) / 2;
}

function latitudeForMercatorY(y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
}

function logicalXForLongitude(longitude: number): number {
  return (wrapLongitude(longitude) + 180) / 360;
}

function logicalYForLatitude(latitude: number): number {
  if (latitude > WEB_MERCATOR_MAX_LATITUDE) {
    return (
      -POLAR_GUTTER *
      (latitude - WEB_MERCATOR_MAX_LATITUDE) /
      (90 - WEB_MERCATOR_MAX_LATITUDE)
    );
  }
  if (latitude < -WEB_MERCATOR_MAX_LATITUDE) {
    return (
      1 +
      POLAR_GUTTER *
        (-WEB_MERCATOR_MAX_LATITUDE - latitude) /
        (90 - WEB_MERCATOR_MAX_LATITUDE)
    );
  }
  return normalizedMercatorY(latitude);
}

function latitudeForLogicalY(y: number): number {
  if (y < 0) {
    return Math.min(
      90,
      WEB_MERCATOR_MAX_LATITUDE +
        -y / POLAR_GUTTER * (90 - WEB_MERCATOR_MAX_LATITUDE),
    );
  }
  if (y > 1) {
    return Math.max(
      -90,
      -WEB_MERCATOR_MAX_LATITUDE -
        (y - 1) / POLAR_GUTTER * (90 - WEB_MERCATOR_MAX_LATITUDE),
    );
  }
  return latitudeForMercatorY(y);
}

function screenX(x: number): number {
  return (x - viewCentreX) * viewScale + viewportWidth * 0.5;
}

function screenY(y: number): number {
  return (y - viewCentreY) * viewScale + viewportHeight * 0.5;
}

function logicalPoint(clientX: number, clientY: number): { x: number; y: number } {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: (clientX - bounds.left - viewportWidth * 0.5) / viewScale + viewCentreX,
    y: (clientY - bounds.top - viewportHeight * 0.5) / viewScale + viewCentreY,
  };
}

function zoomHue(zoom: number, finestZoom: number): number {
  if (finestZoom === 0) return 198;
  return 205 - zoom / finestZoom * 145;
}

function leafFill(
  tile: TileOnionPlan["leaves"][number],
  finestZoom: number,
): string {
  if (tile.role === "finest") return "hsla(42, 96%, 66%, 0.82)";
  return `hsla(${zoomHue(tile.z, finestZoom)}, 72%, 52%, 0.42)`;
}

function leafStroke(
  tile: TileOnionPlan["leaves"][number],
  finestZoom: number,
): string {
  if (tile.role === "finest") return "hsla(44, 100%, 82%, 0.96)";
  return `hsla(${zoomHue(tile.z, finestZoom)}, 82%, 72%, 0.88)`;
}

function drawBackground(): void {
  context.fillStyle = "#01050a";
  context.fillRect(0, 0, viewportWidth, viewportHeight);

  const left = screenX(0);
  const right = screenX(1);
  const north = screenY(-POLAR_GUTTER);
  const mercatorNorth = screenY(0);
  const mercatorSouth = screenY(1);
  const south = screenY(1 + POLAR_GUTTER);

  context.fillStyle = "rgba(74, 58, 31, 0.32)";
  context.fillRect(left, north, right - left, mercatorNorth - north);
  context.fillRect(left, mercatorSouth, right - left, south - mercatorSouth);

  context.fillStyle = "rgba(9, 27, 41, 0.92)";
  context.fillRect(left, mercatorNorth, right - left, mercatorSouth - mercatorNorth);

  context.save();
  context.strokeStyle = "rgba(255, 211, 125, 0.9)";
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(left, mercatorNorth);
  context.lineTo(right, mercatorNorth);
  context.moveTo(left, mercatorSouth);
  context.lineTo(right, mercatorSouth);
  context.stroke();

  context.strokeStyle = "rgba(159, 233, 255, 0.24)";
  context.lineWidth = 1;
  context.strokeRect(left, north, right - left, south - north);
  context.restore();

  if (viewScale >= fitScale * 0.75) {
    context.save();
    context.fillStyle = "rgba(255, 220, 152, 0.72)";
    context.font = "11px Avenir Next, Segoe UI, sans-serif";
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText("NORTH POLAR SELECTION · 90°", left + 10, north + 8);
    context.textBaseline = "bottom";
    context.fillText("SOUTH POLAR SELECTION · −90°", left + 10, south - 8);
    context.restore();
  }
}

function drawLeaf(tile: TileOnionPlan["leaves"][number], finestZoom: number): void {
  const divisor = 2 ** tile.z;
  const left = screenX(tile.x / divisor);
  const right = screenX((tile.x + 1) / divisor);
  const top = screenY(tile.y / divisor);
  const bottom = screenY((tile.y + 1) / divisor);
  if (right < 0 || left > viewportWidth || bottom < 0 || top > viewportHeight) {
    return;
  }
  context.fillStyle = leafFill(tile, finestZoom);
  context.fillRect(left, top, right - left, bottom - top);
  context.strokeStyle = leafStroke(tile, finestZoom);
  context.lineWidth = tile.role === "finest" ? 1.5 : 1;
  context.strokeRect(left, top, right - left, bottom - top);

  if (right - left >= 48 && bottom - top >= 24) {
    context.fillStyle = "rgba(236, 248, 255, 0.82)";
    context.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textBaseline = "top";
    context.fillText(`${tile.z}/${tile.x}/${tile.y}`, left + 4, top + 3);
  }
}

function wrappedScreenX(longitude: number): number {
  return screenX(logicalXForLongitude(longitude));
}

function drawMarker(x: number, y: number, color: string, radius: number): void {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.strokeStyle = "rgba(255, 255, 255, 0.94)";
  context.lineWidth = 1.5;
  context.stroke();
}

function drawSelection(plan: TileOnionPlan): void {
  const selectedX = wrappedScreenX(plan.coordinates.longitudeDegrees);
  const selectedY = screenY(
    logicalYForLatitude(plan.coordinates.latitudeDegrees),
  );

  if (plan.boundary) {
    const boundaryX = wrappedScreenX(plan.boundary.longitudeDegrees);
    const boundaryY = screenY(plan.mode === "north-boundary" ? 0 : 1);
    context.save();
    context.setLineDash([6, 5]);
    context.strokeStyle = "rgba(255, 232, 184, 0.82)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(selectedX, selectedY);
    context.lineTo(boundaryX, boundaryY);
    context.stroke();
    context.restore();
    drawMarker(boundaryX, boundaryY, "#ffd37d", 5);
  }

  drawMarker(selectedX, selectedY, "#ffffff", 5.5);
}

function draw(): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  const ratio = window.devicePixelRatio || 1;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawBackground();
  if (!committedPlan) return;
  for (const tile of committedPlan.leaves) {
    drawLeaf(tile, committedPlan.effectiveZoom);
  }
  drawSelection(committedPlan);
}

function coordinateText(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(6)}° ${value < 0 ? negative : positive}`;
}

function renderDiagnostics(plan: TileOnionPlan): void {
  const counts = new Map<number, number>();
  for (const tile of plan.leaves) {
    counts.set(tile.z, (counts.get(tile.z) ?? 0) + 1);
  }
  const levels = [...counts].sort(([first], [second]) => first - second);
  modeBadge.textContent = plan.mode
    .replaceAll("-", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
  coordinateReadout.textContent =
    `${coordinateText(plan.coordinates.latitudeDegrees, "N", "S")} · ` +
    coordinateText(plan.coordinates.longitudeDegrees, "E", "W");
  zoomReadout.textContent =
    plan.effectiveZoom === plan.requestedMaxZoom
      ? `z${plan.effectiveZoom}`
      : `z${plan.effectiveZoom} (requested z${plan.requestedMaxZoom})`;
  underfootReadout.textContent = plan.underfoot
    ? `${plan.underfoot.z}/${plan.underfoot.x}/${plan.underfoot.y}`
    : "outside Mercator";
  anchorReadout.textContent =
    `z${plan.anchor.z} · ${plan.anchor.x}, ${plan.anchor.y} · ` +
    `${plan.anchor.width}×${plan.anchor.height}`;
  fineCountReadout.textContent = plan.finestTiles.length.toLocaleString();
  leafCountReadout.textContent = plan.leaves.length.toLocaleString();
  levelCountReadout.textContent = levels
    .map(([zoom, count]) => `z${zoom}: ${count}`)
    .join(" · ");
  edgeDistanceReadout.textContent = plan.boundary
    ? `${plan.boundary.distanceKm.toFixed(3)} km`
    : "inside Mercator";
  poleLockReadout.textContent = plan.state.poleLocked ? "locked" : "tracking";

  const fineLegend = document.createElement("span");
  fineLegend.className = "legend-item";
  const fineSwatch = document.createElement("span");
  fineSwatch.className = "legend-swatch";
  fineSwatch.style.backgroundColor = "hsl(42 96% 66%)";
  fineLegend.append(fineSwatch, "fine target");
  zoomLegend.replaceChildren(
    fineLegend,
    ...levels.map(([zoom]) => {
      const item = document.createElement("span");
      item.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.backgroundColor = `hsl(${zoomHue(zoom, plan.effectiveZoom)} 72% 52%)`;
      item.append(swatch, `z${zoom}`);
      return item;
    }),
  );
  tileList.textContent = plan.leaves
    .slice()
    .sort(
      (first, second) =>
        first.z - second.z || first.y - second.y || first.x - second.x,
    )
    .map((tile) => `${tile.z}/${tile.x}/${tile.y}  ${tile.role}`)
    .join("\n");
  document.body.dataset.tileOnionMode = plan.mode;
  document.body.dataset.tileOnionZoom = String(plan.effectiveZoom);
  document.body.dataset.tileOnionLeaves = String(plan.leaves.length);
}

function calculate(): void {
  const requestedLatitude = Number(latitudeInput.value);
  const requestedLongitude = Number(longitudeInput.value);
  const requestedMaxZoom = Number(maxZoomInput.value);
  if (
    !Number.isFinite(requestedLatitude) ||
    requestedLatitude < -90 ||
    requestedLatitude > 90
  ) {
    validationMessage.textContent = "Latitude must be between −90 and 90 degrees.";
    return;
  }
  if (!Number.isFinite(requestedLongitude)) {
    validationMessage.textContent = "Longitude must be a number.";
    return;
  }
  if (
    maxZoomInput.value.trim() === "" ||
    !Number.isInteger(requestedMaxZoom) ||
    requestedMaxZoom < 0
  ) {
    validationMessage.textContent =
      "Maximum zoom must be a non-negative whole number.";
    return;
  }

  validationMessage.textContent = "";
  const plan = calculateTileOnionPlan({
    latitudeDegrees: requestedLatitude,
    longitudeDegrees: requestedLongitude,
    maxZoom: requestedMaxZoom,
    previousState: plannerState,
  });
  committedPlan = plan;
  plannerState = plan.state;
  latitudeDegrees = plan.coordinates.latitudeDegrees;
  longitudeDegrees = plan.coordinates.longitudeDegrees;
  renderDiagnostics(plan);
  draw();
}

function fitWorld(): void {
  const availableWidth = Math.max(1, viewportWidth - VIEW_PADDING * 2);
  const availableHeight = Math.max(1, viewportHeight - VIEW_PADDING * 2);
  fitScale = Math.min(
    availableWidth,
    availableHeight / (1 + POLAR_GUTTER * 2),
  );
  viewScale = fitScale;
  viewCentreX = 0.5;
  viewCentreY = 0.5;
  draw();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  calculate();
});
latitudeInput.addEventListener("change", calculate);
longitudeInput.addEventListener("change", calculate);
maxZoomInput.addEventListener("input", () => {
  maxZoomValue.textContent = maxZoomInput.value === "" ? "—" : `z${maxZoomInput.value}`;
  calculate();
});
fitWorldButton.addEventListener("click", fitWorld);

let activePointer: number | undefined;
let pointerStartX = 0;
let pointerStartY = 0;
let previousPointerX = 0;
let previousPointerY = 0;
let pointerDistance = 0;

canvas.addEventListener("pointerdown", (event) => {
  activePointer = event.pointerId;
  pointerStartX = previousPointerX = event.clientX;
  pointerStartY = previousPointerY = event.clientY;
  pointerDistance = 0;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== activePointer) return;
  const deltaX = event.clientX - previousPointerX;
  const deltaY = event.clientY - previousPointerY;
  previousPointerX = event.clientX;
  previousPointerY = event.clientY;
  pointerDistance = Math.max(
    pointerDistance,
    Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY),
  );
  if (pointerDistance >= 4) {
    shell.classList.add("is-dragging");
    viewCentreX -= deltaX / viewScale;
    viewCentreY -= deltaY / viewScale;
    draw();
  }
});

canvas.addEventListener("pointerup", (event) => {
  if (event.pointerId !== activePointer) return;
  canvas.releasePointerCapture(event.pointerId);
  activePointer = undefined;
  shell.classList.remove("is-dragging");
  if (pointerDistance >= 4) return;
  const point = logicalPoint(event.clientX, event.clientY);
  if (
    point.x < 0 ||
    point.x > 1 ||
    point.y < -POLAR_GUTTER ||
    point.y > 1 + POLAR_GUTTER
  ) {
    return;
  }
  const longitude = point.x * 360 - 180;
  const latitude = latitudeForLogicalY(point.y);
  latitudeInput.value = latitude.toFixed(6);
  longitudeInput.value = longitude.toFixed(6);
  calculate();
});

canvas.addEventListener("pointercancel", () => {
  activePointer = undefined;
  shell.classList.remove("is-dragging");
});

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const before = logicalPoint(event.clientX, event.clientY);
    const nextScale = Math.max(
      fitScale * 0.5,
      viewScale * Math.exp(-event.deltaY * 0.0012),
    );
    const bounds = canvas.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    viewScale = nextScale;
    viewCentreX = before.x - (pointerX - viewportWidth * 0.5) / viewScale;
    viewCentreY = before.y - (pointerY - viewportHeight * 0.5) / viewScale;
    draw();
  },
  { passive: false },
);

const resizeObserver = new ResizeObserver(() => {
  viewportWidth = Math.max(1, shell.clientWidth);
  viewportHeight = Math.max(1, shell.clientHeight);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(viewportWidth * ratio);
  canvas.height = Math.round(viewportHeight * ratio);
  canvas.style.width = `${viewportWidth}px`;
  canvas.style.height = `${viewportHeight}px`;
  fitWorld();
});
resizeObserver.observe(shell);

calculate();
