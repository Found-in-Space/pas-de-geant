export const IMAGERY_PREFETCH_SCALE = 400;
export const IMAGERY_COMMIT_SCALE = 500;
export const IMAGERY_RELEASE_SCALE = 375;
export const IMAGERY_TARGET_TEXEL_PIXELS = 1.25;
export const IMAGERY_TEXEL_KEEP_MIN_PIXELS = 0.85;
export const IMAGERY_TEXEL_KEEP_MAX_PIXELS = 1.7;
export const IMAGERY_PAGE_TABLE_SIZE = 8;
export const IMAGERY_WINDOW_ANCHOR_STRIDE = 4;
export const IMAGERY_WINDOW_INNER_MARGIN = 2;
export const IMAGERY_MAX_ANCESTOR_DELTA = 8;
export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

export interface ImageryAddress {
  z: number;
  x: number;
  y: number;
}

export type ImageryActivation = "inactive" | "prefetching" | "active";

export interface ImageryView {
  displayRadiusM: number;
  latitudeDegrees: number;
  longitudeDegrees: number;
  eyeHeightWorldM: number;
  focalLengthPixels: number;
}

export interface ImageryZoomOptions extends ImageryView {
  tileSize: number;
  minZoom: number;
  maxZoom: number;
  previousZoom?: number;
}

export interface ImageryWindow {
  zoom: number;
  originX: number;
  originY: number;
  size: number;
}

export interface ImageryPlanCell {
  tableX: number;
  tableY: number;
  address: ImageryAddress;
}

export interface ImageryLoadTask {
  address: ImageryAddress;
  kind: "parent" | "exact";
  priority: number;
}

export interface ImageryPlan {
  window: ImageryWindow;
  cells: ImageryPlanCell[];
  tasks: ImageryLoadTask[];
  signature: string;
}

export interface EncodedPageEntry {
  layerByte: number;
  ancestorDelta: number;
  childOffsetX: number;
  childOffsetY: number;
}

export function imageryKey(address: ImageryAddress): string {
  return `${address.z}/${address.x}/${address.y}`;
}

export function wrapImageryX(x: number, zoom: number): number {
  const width = 2 ** zoom;
  return ((x % width) + width) % width;
}

export function isValidImageryAddress(address: ImageryAddress): boolean {
  const width = 2 ** address.z;
  return (
    Number.isInteger(address.z) &&
    Number.isInteger(address.x) &&
    Number.isInteger(address.y) &&
    address.z >= 0 &&
    address.x >= 0 &&
    address.x < width &&
    address.y >= 0 &&
    address.y < width
  );
}

export function imageryActivationForScale(
  displayRadiusM: number,
  previous: ImageryActivation,
): ImageryActivation {
  if (previous === "active") {
    return displayRadiusM < IMAGERY_RELEASE_SCALE ? "inactive" : "active";
  }
  if (displayRadiusM >= IMAGERY_COMMIT_SCALE) return "active";
  if (displayRadiusM >= IMAGERY_PREFETCH_SCALE) return "prefetching";
  return "inactive";
}

export function projectedImageryTexelPixels(
  view: ImageryView,
  zoom: number,
  tileSize: number,
): number {
  const latitude = Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, view.latitudeDegrees),
  );
  const renderedTileWidthM =
    (2 *
      Math.PI *
      Math.max(0.001, view.displayRadiusM) *
      Math.max(1e-6, Math.cos((latitude * Math.PI) / 180))) /
    2 ** zoom;
  const renderedTexelM = renderedTileWidthM / Math.max(1, tileSize);
  return (
    (renderedTexelM * Math.max(1, view.focalLengthPixels)) /
    Math.max(0.001, view.eyeHeightWorldM)
  );
}

export function selectImageryZoom(options: ImageryZoomOptions): number {
  const minZoom = Math.max(0, Math.floor(options.minZoom));
  const maxZoom = Math.max(minZoom, Math.floor(options.maxZoom));
  const previous =
    options.previousZoom === undefined
      ? undefined
      : Math.max(minZoom, Math.min(maxZoom, Math.floor(options.previousZoom)));
  if (previous !== undefined) {
    const previousPixels = projectedImageryTexelPixels(
      options,
      previous,
      options.tileSize,
    );
    if (
      previousPixels >= IMAGERY_TEXEL_KEEP_MIN_PIXELS &&
      previousPixels <= IMAGERY_TEXEL_KEEP_MAX_PIXELS
    ) {
      return previous;
    }
  }
  const equatorialPixelsAtZoomZero =
    projectedImageryTexelPixels(options, 0, options.tileSize);
  const calculated = Math.ceil(
    Math.log2(
      Math.max(1e-9, equatorialPixelsAtZoomZero) /
        IMAGERY_TARGET_TEXEL_PIXELS,
    ),
  );
  return Math.max(minZoom, Math.min(maxZoom, calculated));
}

export function mercatorPointForImagery(
  latitudeDegrees: number,
  longitudeDegrees: number,
  zoom: number,
): { x: number; y: number } {
  const latitude =
    (Math.max(
      -WEB_MERCATOR_MAX_LATITUDE,
      Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
    ) *
      Math.PI) /
    180;
  const width = 2 ** zoom;
  const wrappedLongitude =
    ((((longitudeDegrees + 180) % 360) + 360) % 360) - 180;
  return {
    x: ((wrappedLongitude + 180) / 360) * width,
    y:
      ((1 -
        Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) /
        2) *
      width,
  };
}

function unwrapNear(value: number, width: number, reference: number): number {
  return value + Math.round((reference - value) / width) * width;
}

export function imageryWindowForContact(
  latitudeDegrees: number,
  longitudeDegrees: number,
  zoom: number,
  previous?: ImageryWindow,
  size = IMAGERY_PAGE_TABLE_SIZE,
): ImageryWindow {
  const width = 2 ** zoom;
  const point = mercatorPointForImagery(
    latitudeDegrees,
    longitudeDegrees,
    zoom,
  );
  const resolvedSize = Math.max(
    1,
    Math.min(width, Math.floor(size)),
  );
  let unwrappedX = point.x;
  if (previous?.zoom === zoom) {
    unwrappedX = unwrapNear(
      point.x,
      width,
      previous.originX + previous.size * 0.5,
    );
    const margin = Math.min(
      IMAGERY_WINDOW_INNER_MARGIN,
      Math.max(0, previous.size * 0.5 - 0.5),
    );
    if (
      unwrappedX >= previous.originX + margin &&
      unwrappedX < previous.originX + previous.size - margin &&
      point.y >= previous.originY + margin &&
      point.y < previous.originY + previous.size - margin
    ) {
      return previous;
    }
  }
  const originX =
    Math.floor(
      (unwrappedX - resolvedSize * 0.5) / IMAGERY_WINDOW_ANCHOR_STRIDE,
    ) * IMAGERY_WINDOW_ANCHOR_STRIDE;
  const maximumY = Math.max(0, width - resolvedSize);
  const originY = Math.max(
    0,
    Math.min(
      maximumY,
      Math.floor(
        (point.y - resolvedSize * 0.5) / IMAGERY_WINDOW_ANCHOR_STRIDE,
      ) * IMAGERY_WINDOW_ANCHOR_STRIDE,
    ),
  );
  return { zoom, originX, originY, size: resolvedSize };
}

export function ancestorAtZoom(
  address: ImageryAddress,
  zoom: number,
): ImageryAddress {
  if (zoom > address.z || zoom < 0) {
    throw new Error("Imagery ancestor zoom must contain the requested tile.");
  }
  const divisor = 2 ** (address.z - zoom);
  return {
    z: zoom,
    x: Math.floor(address.x / divisor),
    y: Math.floor(address.y / divisor),
  };
}

export function siblingGroup(address: ImageryAddress): ImageryAddress[] {
  if (address.z === 0) return [address];
  const parent = ancestorAtZoom(address, address.z - 1);
  return [
    { z: address.z, x: parent.x * 2, y: parent.y * 2 },
    { z: address.z, x: parent.x * 2 + 1, y: parent.y * 2 },
    { z: address.z, x: parent.x * 2, y: parent.y * 2 + 1 },
    { z: address.z, x: parent.x * 2 + 1, y: parent.y * 2 + 1 },
  ];
}

export function siblingGroupKey(address: ImageryAddress): string {
  return imageryKey(
    address.z === 0 ? address : ancestorAtZoom(address, address.z - 1),
  );
}

export function imageryPlanForWindow(window: ImageryWindow): ImageryPlan {
  const cells: ImageryPlanCell[] = [];
  const parents = new Map<string, ImageryLoadTask>();
  const exact: ImageryLoadTask[] = [];
  const width = 2 ** window.zoom;
  const centre = (window.size - 1) * 0.5;
  for (let tableY = 0; tableY < window.size; tableY += 1) {
    const y = window.originY + tableY;
    if (y < 0 || y >= width) continue;
    for (let tableX = 0; tableX < window.size; tableX += 1) {
      const address = {
        z: window.zoom,
        x: wrapImageryX(window.originX + tableX, window.zoom),
        y,
      };
      const priority = Math.hypot(tableX - centre, tableY - centre);
      cells.push({ tableX, tableY, address });
      exact.push({ address, kind: "exact", priority: 1_000 + priority });
      if (window.zoom > 0) {
        const parent = ancestorAtZoom(address, window.zoom - 1);
        const key = imageryKey(parent);
        const existing = parents.get(key);
        if (!existing || priority < existing.priority) {
          parents.set(key, {
            address: parent,
            kind: "parent",
            priority,
          });
        }
      }
    }
  }
  const tasks = [
    ...[...parents.values()].sort(
      (first, second) =>
        first.priority - second.priority ||
        imageryKey(first.address).localeCompare(imageryKey(second.address)),
    ),
    ...exact.sort(
      (first, second) =>
        first.priority - second.priority ||
        imageryKey(first.address).localeCompare(imageryKey(second.address)),
    ),
  ];
  return {
    window,
    cells,
    tasks,
    signature: `${window.zoom}:${window.originX}:${window.originY}:${window.size}`,
  };
}

export function resolvedImagerySource(
  address: ImageryAddress,
  resident: ReadonlySet<string>,
  minimumZoom = 0,
): ImageryAddress | undefined {
  const exactReady = siblingGroup(address).every((sibling) =>
    resident.has(imageryKey(sibling)),
  );
  if (exactReady) return address;
  const lowestZoom = Math.max(
    minimumZoom,
    address.z - IMAGERY_MAX_ANCESTOR_DELTA,
  );
  for (let zoom = address.z - 1; zoom >= lowestZoom; zoom -= 1) {
    const ancestor = ancestorAtZoom(address, zoom);
    if (resident.has(imageryKey(ancestor))) return ancestor;
  }
  return undefined;
}

export function encodePageEntry(
  target: ImageryAddress,
  source: ImageryAddress,
  layer: number,
): EncodedPageEntry {
  if (source.z > target.z) {
    throw new Error("A visible imagery source must contain its target.");
  }
  const delta = target.z - source.z;
  if (delta > IMAGERY_MAX_ANCESTOR_DELTA) {
    throw new Error("The imagery ancestor is too coarse for one page entry.");
  }
  const divisor = 2 ** delta;
  if (
    Math.floor(target.x / divisor) !== source.x ||
    Math.floor(target.y / divisor) !== source.y
  ) {
    throw new Error("The imagery source does not contain its target.");
  }
  if (layer < 0 || layer > 253) {
    throw new Error("The imagery layer must fit in one non-zero byte.");
  }
  return {
    layerByte: layer + 1,
    ancestorDelta: delta,
    childOffsetX: target.x - source.x * divisor,
    childOffsetY: target.y - source.y * divisor,
  };
}

export function decodePageEntry(
  entry: EncodedPageEntry,
): { layer: number; scale: number; offsetX: number; offsetY: number } {
  return {
    layer: entry.layerByte - 1,
    scale: 2 ** entry.ancestorDelta,
    offsetX: entry.childOffsetX,
    offsetY: entry.childOffsetY,
  };
}
