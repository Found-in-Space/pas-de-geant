export const IMAGERY_GPU_PAGE_SIZE = 256;
export const IMAGERY_TARGET_METRES_PER_TEXEL = 0.01;
export const IMAGERY_TARGET_TILE_WIDTH_M =
  IMAGERY_GPU_PAGE_SIZE * IMAGERY_TARGET_METRES_PER_TEXEL;
export const IMAGERY_COARSEN_TILE_WIDTH_M = 1.75;
export const IMAGERY_REFINE_TILE_WIDTH_M = 3.75;
export const IMAGERY_PAGE_TABLE_SIZE = 16;
export const IMAGERY_ONION_OUTER_TILES = 4;
export const IMAGERY_ONION_HOLE_TILES = 2;
export const IMAGERY_ONION_LEVELS = 3;
export const IMAGERY_ONION_TARGET_RADIUS_M =
  IMAGERY_TARGET_TILE_WIDTH_M *
  IMAGERY_ONION_OUTER_TILES *
  2 ** (IMAGERY_ONION_LEVELS - 2);
export const IMAGERY_MAX_ANCESTOR_DELTA = 8;
export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;

export interface ImageryAddress {
  z: number;
  x: number;
  y: number;
}

export interface ImageryView {
  displayRadiusM: number;
  latitudeDegrees: number;
  longitudeDegrees: number;
}

export interface ImageryZoomOptions {
  displayRadiusM: number;
  latitudeDegrees: number;
  minZoom: number;
  maxZoom: number;
  previousZoom?: number;
}

export interface ImageryLoadTask {
  address: ImageryAddress;
  kind: "world" | "cap" | "middle" | "outer";
  group: number;
  priority: number;
}

export interface ImageryOnionCell {
  address: ImageryAddress;
  group: number;
  tableX: number;
  tableY: number;
  tableSpan: number;
}

export interface ImageryOnionPlan {
  mode: "world" | "onion";
  finestZoom: number;
  minimumZoom: number;
  tableOriginX: number;
  tableOriginY: number;
  tableSpan: number;
  groupCount: number;
  cells: ImageryOnionCell[];
  tasks: ImageryLoadTask[];
  signature: string;
}

export interface EncodedPageEntry {
  layerByte: number;
  ancestorDelta: number;
  childOffsetX: number;
  childOffsetY: number;
}

interface StandardTemplateCell {
  ring: number;
  row: number;
  column: number;
  tableX: number;
  tableY: number;
  tableSpan: number;
}

function createStandardTemplate(): readonly StandardTemplateCell[] {
  const cells: StandardTemplateCell[] = [];
  const holeOffset =
    (IMAGERY_ONION_OUTER_TILES - IMAGERY_ONION_HOLE_TILES) / 2;
  for (let ring = 0; ring < IMAGERY_ONION_LEVELS; ring += 1) {
    const tableSpan = 2 ** ring;
    const tableOffset =
      (IMAGERY_PAGE_TABLE_SIZE -
        IMAGERY_ONION_OUTER_TILES * tableSpan) /
      2;
    for (let row = 0; row < IMAGERY_ONION_OUTER_TILES; row += 1) {
      for (let column = 0; column < IMAGERY_ONION_OUTER_TILES; column += 1) {
        if (
          ring > 0 &&
          row >= holeOffset &&
          row < holeOffset + IMAGERY_ONION_HOLE_TILES &&
          column >= holeOffset &&
          column < holeOffset + IMAGERY_ONION_HOLE_TILES
        ) {
          continue;
        }
        cells.push({
          ring,
          row,
          column,
          tableX: tableOffset + column * tableSpan,
          tableY: tableOffset + row * tableSpan,
          tableSpan,
        });
      }
    }
  }
  return cells;
}

/**
 * The standard imagery geometry is fixed: a 4×4 cap and two 4×4-minus-2×2
 * rings. Runtime planning only translates these precomputed relative cells to
 * the current snapped Web Mercator anchor.
 */
export const STANDARD_IMAGERY_TEMPLATE = Object.freeze(
  createStandardTemplate(),
);

interface WorldTemplateCell {
  address: ImageryAddress;
  tableX: number;
  tableY: number;
  tableSpan: number;
}

function createWorldTemplates(): readonly (readonly WorldTemplateCell[])[] {
  const templates: WorldTemplateCell[][] = [];
  for (let finestZoom = 0; finestZoom <= 3; finestZoom += 1) {
    const cells: WorldTemplateCell[] = [];
    for (
      let zoom = 0;
      zoom <= Math.min(2, finestZoom);
      zoom += 1
    ) {
      const width = 2 ** zoom;
      const tableSpan = 2 ** (finestZoom - zoom);
      for (let y = 0; y < width; y += 1) {
        for (let x = 0; x < width; x += 1) {
          cells.push({
            address: { z: zoom, x, y },
            tableX: x * tableSpan,
            tableY: y * tableSpan,
            tableSpan,
          });
        }
      }
    }
    templates.push(cells);
  }
  return templates.map((template) => Object.freeze(template));
}

/**
 * Complete-world layouts are also built once. At runtime the selected layout
 * is filtered to the provider's minimum z; only the optional z3 cap moves.
 */
export const WORLD_IMAGERY_TEMPLATES = Object.freeze(
  createWorldTemplates(),
);

const LOCAL_CAP_OFFSETS = Object.freeze(
  STANDARD_IMAGERY_TEMPLATE
    .filter((cell) => cell.ring === 0)
    .map((cell) => Object.freeze({ x: cell.column, y: cell.row })),
);

export class ImageryRequestTokenIndex {
  private sequence = 0;
  private readonly active = new Map<string, number>();

  begin(key: string): number {
    const token = ++this.sequence;
    this.active.set(key, token);
    return token;
  }

  cancel(key: string): void {
    this.active.delete(key);
  }

  isCurrent(key: string, token: number): boolean {
    return this.active.get(key) === token;
  }

  complete(key: string, token: number): boolean {
    if (!this.isCurrent(key, token)) return false;
    this.active.delete(key);
    return true;
  }
}

export function selectUnpinnedLruKey(
  candidates: ReadonlyArray<{
    key: string;
    usedAt: number;
    pinned: boolean;
  }>,
): string | undefined {
  return candidates
    .filter((candidate) => !candidate.pinned)
    .sort(
      (first, second) =>
        first.usedAt - second.usedAt ||
        first.key.localeCompare(second.key),
    )[0]?.key;
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

export function renderedImageryTileWidthM(
  latitudeDegrees: number,
  displayRadiusM: number,
  zoom: number,
): number {
  const latitude =
    Math.max(
      -WEB_MERCATOR_MAX_LATITUDE,
      Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
    ) *
    Math.PI /
    180;
  return (
    2 *
    Math.PI *
    Math.max(0.001, displayRadiusM) *
    Math.max(1e-6, Math.cos(latitude)) /
    2 ** Math.max(0, Math.floor(zoom))
  );
}

function nearestImageryZoom(options: ImageryZoomOptions): number {
  let selected = options.minZoom;
  let selectedDistance = Infinity;
  for (let zoom = options.minZoom; zoom <= options.maxZoom; zoom += 1) {
    const width = renderedImageryTileWidthM(
      options.latitudeDegrees,
      options.displayRadiusM,
      zoom,
    );
    const distance = Math.abs(
      Math.log2(width / IMAGERY_TARGET_TILE_WIDTH_M),
    );
    if (distance < selectedDistance) {
      selected = zoom;
      selectedDistance = distance;
    }
  }
  return selected;
}

export function selectImageryZoom(options: ImageryZoomOptions): number {
  const minZoom = Math.max(0, Math.floor(options.minZoom));
  const maxZoom = Math.max(minZoom, Math.floor(options.maxZoom));
  let zoom =
    options.previousZoom === undefined
      ? nearestImageryZoom({ ...options, minZoom, maxZoom })
      : Math.max(minZoom, Math.min(maxZoom, Math.floor(options.previousZoom)));
  let width = renderedImageryTileWidthM(
    options.latitudeDegrees,
    options.displayRadiusM,
    zoom,
  );
  while (width > IMAGERY_REFINE_TILE_WIDTH_M && zoom < maxZoom) {
    zoom += 1;
    width *= 0.5;
  }
  while (width < IMAGERY_COARSEN_TILE_WIDTH_M && zoom > minZoom) {
    zoom -= 1;
    width *= 2;
  }
  return zoom;
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

function taskKindForGroup(group: number): ImageryLoadTask["kind"] {
  if (group === 0) return "cap";
  if (group === 1) return "middle";
  return "outer";
}

function standardImageryPlan(
  latitudeDegrees: number,
  longitudeDegrees: number,
  finestZoom: number,
  minimumZoom: number,
): ImageryOnionPlan {
  const point = mercatorPointForImagery(
    latitudeDegrees,
    longitudeDegrees,
    finestZoom,
  );
  const anchorStride = 2 ** (IMAGERY_ONION_LEVELS - 1);
  const anchorOffset = 2;
  let originX =
    Math.floor((Math.floor(point.x) - anchorOffset) / anchorStride) *
      anchorStride +
    anchorOffset;
  let originY =
    Math.floor((Math.floor(point.y) - anchorOffset) / anchorStride) *
      anchorStride +
    anchorOffset;
  const origins: Array<{ x: number; y: number }> = [];
  for (let ring = 0; ring < IMAGERY_ONION_LEVELS; ring += 1) {
    origins.push({ x: originX, y: originY });
    originX = Math.floor(originX / 2) - 1;
    originY = Math.floor(originY / 2) - 1;
  }
  const outermost = origins.at(-1)!;
  const outermostSpan = 2 ** (IMAGERY_ONION_LEVELS - 1);
  const tableOriginX = outermost.x * outermostSpan;
  const tableOriginY = outermost.y * outermostSpan;
  const cells: ImageryOnionCell[] = [];
  for (const template of STANDARD_IMAGERY_TEMPLATE) {
    const zoom = finestZoom - template.ring;
    if (zoom < minimumZoom) continue;
    const ringOrigin = origins[template.ring]!;
    const unwrappedX = ringOrigin.x + template.column;
    const y = ringOrigin.y + template.row;
    const width = 2 ** zoom;
    if (y < 0 || y >= width) continue;
    cells.push({
      address: {
        z: zoom,
        x: wrapImageryX(unwrappedX, zoom),
        y,
      },
      group: template.ring,
      tableX: template.tableX,
      tableY: template.tableY,
      tableSpan: template.tableSpan,
    });
  }
  const tasks = cells
    .map((cell) => ({
      address: cell.address,
      kind: taskKindForGroup(cell.group),
      group: cell.group,
      priority:
        cell.group * 1_000 +
        Math.hypot(
          cell.tableX + cell.tableSpan * 0.5 -
            IMAGERY_PAGE_TABLE_SIZE * 0.5,
          cell.tableY + cell.tableSpan * 0.5 -
            IMAGERY_PAGE_TABLE_SIZE * 0.5,
        ),
    }))
    .sort(
      (first, second) =>
        first.priority - second.priority ||
        imageryKey(first.address).localeCompare(imageryKey(second.address)),
    );
  return {
    mode: "onion",
    finestZoom,
    minimumZoom,
    tableOriginX,
    tableOriginY,
    tableSpan: IMAGERY_PAGE_TABLE_SIZE,
    groupCount: IMAGERY_ONION_LEVELS,
    cells,
    tasks,
    signature: [
      "onion",
      finestZoom,
      minimumZoom,
      ...origins.flatMap((origin) => [origin.x, origin.y]),
    ].join(":"),
  };
}

function worldImageryPlan(
  latitudeDegrees: number,
  longitudeDegrees: number,
  finestZoom: number,
  minimumZoom: number,
): ImageryOnionPlan {
  const cells: ImageryOnionCell[] = [];
  for (const template of WORLD_IMAGERY_TEMPLATES[finestZoom] ?? []) {
    if (template.address.z < minimumZoom) continue;
    cells.push({
      address: template.address,
      group: template.address.z - minimumZoom,
      tableX: template.tableX,
      tableY: template.tableY,
      tableSpan: template.tableSpan,
    });
  }
  let localCapSignature = "global";
  if (finestZoom === 3 && minimumZoom <= finestZoom) {
    const point = mercatorPointForImagery(
      latitudeDegrees,
      longitudeDegrees,
      finestZoom,
    );
    const width = 2 ** finestZoom;
    const originX = Math.floor(point.x) - 1;
    const originY = Math.max(
      0,
      Math.min(width - IMAGERY_ONION_OUTER_TILES, Math.floor(point.y) - 1),
    );
    const group = Math.max(0, 3 - minimumZoom);
    for (const offset of LOCAL_CAP_OFFSETS) {
      const unwrappedX = originX + offset.x;
      cells.push({
        address: {
          z: finestZoom,
          x: wrapImageryX(unwrappedX, finestZoom),
          y: originY + offset.y,
        },
        group,
        tableX: wrapImageryX(unwrappedX, finestZoom),
        tableY: originY + offset.y,
        tableSpan: 1,
      });
    }
    localCapSignature = `${wrapImageryX(
      originX,
      finestZoom,
    )}:${originY}`;
  }
  const tasksByKey = new Map<string, ImageryLoadTask>();
  for (const cell of cells) {
    const key = imageryKey(cell.address);
    const existing = tasksByKey.get(key);
    const task: ImageryLoadTask = {
      address: cell.address,
      kind: "world",
      group: cell.group,
      priority:
        cell.group * 1_000 +
        Math.hypot(cell.tableX, cell.tableY),
    };
    if (!existing || task.priority < existing.priority) {
      tasksByKey.set(key, task);
    }
  }
  const tasks = [...tasksByKey.values()].sort(
    (first, second) =>
      first.priority - second.priority ||
      imageryKey(first.address).localeCompare(imageryKey(second.address)),
  );
  const highestGroup = tasks.reduce(
    (maximum, task) => Math.max(maximum, task.group),
    0,
  );
  return {
    mode: "world",
    finestZoom,
    minimumZoom,
    tableOriginX: 0,
    tableOriginY: 0,
    tableSpan: 2 ** finestZoom,
    groupCount: highestGroup + 1,
    cells,
    tasks,
    signature: [
      "world",
      finestZoom,
      minimumZoom,
      localCapSignature,
    ].join(":"),
  };
}

export function imageryOnionPlanForContact(
  latitudeDegrees: number,
  longitudeDegrees: number,
  finestZoom: number,
  minimumZoom = 0,
): ImageryOnionPlan {
  const resolvedFinestZoom = Math.max(0, Math.floor(finestZoom));
  const resolvedMinimumZoom = Math.max(
    0,
    Math.min(resolvedFinestZoom, Math.floor(minimumZoom)),
  );
  return resolvedFinestZoom <= 3
    ? worldImageryPlan(
        latitudeDegrees,
        longitudeDegrees,
        resolvedFinestZoom,
        resolvedMinimumZoom,
      )
    : standardImageryPlan(
        latitudeDegrees,
        longitudeDegrees,
        resolvedFinestZoom,
        resolvedMinimumZoom,
      );
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
