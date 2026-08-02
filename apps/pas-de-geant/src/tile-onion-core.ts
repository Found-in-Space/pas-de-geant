export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
export const EARTH_MEAN_RADIUS_KM = 6_371.0088;
export const WGS84_A_KM = 6_378.137;
export const WGS84_B_KM = 6_356.752314245;

export const TILE_ONION_FINE_SIZE = 8;
export const TILE_ONION_ANCHOR_STRIDE = 4;
export const TILE_ONION_FINE_MARGIN = 2;

export interface TileAddress {
  z: number;
  x: number;
  y: number;
}

export interface TileOnionLeaf extends TileAddress {
  role: "finest" | "outer";
}

export type TileOnionMode =
  | "normal"
  | "north-boundary"
  | "south-boundary";

export interface TileOnionAnchor {
  z: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TileOnionState {
  mode: TileOnionMode;
  requestedMaxZoom: number;
  effectiveZoom: number;
  boundaryLongitudeDegrees: number;
  poleLocked: boolean;
}

export interface TileOnionPlanOptions {
  latitudeDegrees: number;
  longitudeDegrees: number;
  maxZoom: number;
  previousState?: TileOnionState;
}

export interface TileOnionBoundaryDetails {
  latitudeDegrees: number;
  longitudeDegrees: number;
  distanceKm: number;
}

export interface TileOnionPlan {
  mode: TileOnionMode;
  requestedMaxZoom: number;
  effectiveZoom: number;
  coordinates: {
    latitudeDegrees: number;
    longitudeDegrees: number;
  };
  underfoot: TileAddress | undefined;
  anchor: TileOnionAnchor;
  finestTiles: TileAddress[];
  leaves: TileOnionLeaf[];
  boundary: TileOnionBoundaryDetails | undefined;
  state: TileOnionState;
  signature: string;
}

export interface TileBounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

export function tileKey(address: TileAddress): string {
  return `${address.z}/${address.x}/${address.y}`;
}

export function wrapLongitude(longitudeDegrees: number): number {
  return ((((longitudeDegrees + 180) % 360) + 360) % 360) - 180;
}

export function wrapTileX(x: number, zoom: number): number {
  const width = 2 ** zoom;
  return ((x % width) + width) % width;
}

export function clampMercatorLatitude(latitudeDegrees: number): number {
  return Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
  );
}

export function mercatorPoint(
  latitudeDegrees: number,
  longitudeDegrees: number,
  zoom: number,
): { x: number; y: number } {
  const latitude = clampMercatorLatitude(latitudeDegrees) * Math.PI / 180;
  const width = 2 ** zoom;
  return {
    x: (wrapLongitude(longitudeDegrees) + 180) / 360 * width,
    y:
      (1 -
        Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) /
      2 *
      width,
  };
}

export function tileBounds(
  address: TileAddress,
): TileBounds {
  const width = 2 ** address.z;
  const latitudeForY = (y: number): number =>
    Math.atan(Math.sinh(Math.PI * (1 - 2 * y / width))) * 180 / Math.PI;
  return {
    west: address.x / width * 360 - 180,
    east: (address.x + 1) / width * 360 - 180,
    north: latitudeForY(address.y),
    south: latitudeForY(address.y + 1),
  };
}

function normalizedZoom(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function anchorOrigin(tile: number): number {
  return (
    Math.floor((tile - TILE_ONION_FINE_MARGIN) / TILE_ONION_ANCHOR_STRIDE) *
    TILE_ONION_ANCHOR_STRIDE
  );
}

function targetTiles(
  zoom: number,
  originX: number,
  originY: number,
  width: number,
  height: number,
): TileAddress[] {
  const worldWidth = 2 ** zoom;
  const byKey = new Map<string, TileAddress>();
  for (let row = 0; row < height; row += 1) {
    const y = originY + row;
    if (y < 0 || y >= worldWidth) continue;
    for (let column = 0; column < width; column += 1) {
      const address = {
        z: zoom,
        x: wrapTileX(originX + column, zoom),
        y,
      };
      byKey.set(tileKey(address), address);
    }
  }
  return [...byKey.values()].sort(compareAddresses);
}

function compareAddresses(
  first: TileAddress,
  second: TileAddress,
): number {
  return first.z - second.z || first.y - second.y || first.x - second.x;
}

function balancedQuadtreeLeaves(
  finestTiles: readonly TileAddress[],
): TileOnionLeaf[] {
  const finestKeys = new Set(finestTiles.map(tileKey));
  const root = { z: 0, x: 0, y: 0 };
  const materialized = new Map<string, TileAddress>([[tileKey(root), root]]);
  const opened = new Set<string>();
  const balanceQueue: TileAddress[] = [root];

  const open = (address: TileAddress): void => {
    const key = tileKey(address);
    if (opened.has(key)) return;
    opened.add(key);

    const childZoom = address.z + 1;
    for (let deltaY = 0; deltaY < 2; deltaY += 1) {
      for (let deltaX = 0; deltaX < 2; deltaX += 1) {
        const child = {
          z: childZoom,
          x: address.x * 2 + deltaX,
          y: address.y * 2 + deltaY,
        };
        const childKey = tileKey(child);
        if (!materialized.has(childKey)) {
          materialized.set(childKey, child);
          balanceQueue.push(child);
        }
      }
    }
  };

  const materialize = (address: TileAddress): void => {
    if (materialized.has(tileKey(address))) return;

    const missingPath: TileAddress[] = [];
    let cursor = address;
    while (!materialized.has(tileKey(cursor))) {
      missingPath.push(cursor);
      cursor = {
        z: cursor.z - 1,
        x: Math.floor(cursor.x / 2),
        y: Math.floor(cursor.y / 2),
      };
    }

    for (let index = missingPath.length - 1; index >= 0; index -= 1) {
      const required = missingPath[index]!;
      open({
        z: required.z - 1,
        x: Math.floor(required.x / 2),
        y: Math.floor(required.y / 2),
      });
    }
  };

  for (const target of finestTiles) materialize(target);

  for (let queueIndex = 0; queueIndex < balanceQueue.length; queueIndex += 1) {
    const address = balanceQueue[queueIndex]!;
    if (address.z === 0) continue;

    const coarseZoom = address.z - 1;
    const coarseWidth = 2 ** coarseZoom;
    const containingX = Math.floor(address.x / 2);
    const containingY = Math.floor(address.y / 2);
    const exteriorX = wrapTileX(
      containingX + (address.x % 2 === 0 ? -1 : 1),
      coarseZoom,
    );
    const exteriorY = containingY + (address.y % 2 === 0 ? -1 : 1);
    const coarseXs = new Set([containingX, exteriorX]);
    const coarseYs = new Set([containingY]);
    if (exteriorY >= 0 && exteriorY < coarseWidth) coarseYs.add(exteriorY);

    for (const y of coarseYs) {
      for (const x of coarseXs) {
        materialize({ z: coarseZoom, x, y });
      }
    }
  }

  return [...materialized.values()]
    .filter((address) => !opened.has(tileKey(address)))
    .map((address): TileOnionLeaf => ({
      ...address,
      role: finestKeys.has(tileKey(address)) ? "finest" : "outer",
    }))
    .sort(compareAddresses);
}

function boundaryTileWidthKm(zoom: number): number {
  const latitude = WEB_MERCATOR_MAX_LATITUDE * Math.PI / 180;
  return 2 * Math.PI * EARTH_MEAN_RADIUS_KM * Math.cos(latitude) / 2 ** zoom;
}

function boundaryDistanceKm(latitudeDegrees: number): number {
  return (
    Math.max(0, Math.abs(latitudeDegrees) - WEB_MERCATOR_MAX_LATITUDE) *
    Math.PI /
    180 *
    EARTH_MEAN_RADIUS_KM
  );
}

function boundaryZoom(
  requestedMaxZoom: number,
  distanceKm: number,
  mode: TileOnionMode,
  previousState: TileOnionState | undefined,
): number {
  const finestWidthKm = boundaryTileWidthKm(requestedMaxZoom);
  const distanceRatio = 1 + distanceKm / Math.max(Number.EPSILON, finestWidthKm);
  let drop = Math.floor(Math.log2(distanceRatio));
  if (
    previousState &&
    previousState.mode === mode &&
    previousState.requestedMaxZoom === requestedMaxZoom
  ) {
    const previousDrop = requestedMaxZoom - previousState.effectiveZoom;
    if (
      drop > previousDrop &&
      distanceRatio < 2 ** (previousDrop + 1) * 1.1
    ) {
      drop = previousDrop;
    } else if (
      drop < previousDrop &&
      distanceRatio > 2 ** previousDrop * 0.9
    ) {
      drop = previousDrop;
    }
  }
  return Math.max(0, requestedMaxZoom - drop);
}

function stableBoundaryLongitude(
  latitudeDegrees: number,
  longitudeDegrees: number,
  previousState: TileOnionState | undefined,
): { longitudeDegrees: number; poleLocked: boolean } {
  const horizontalMagnitude = Math.abs(
    Math.cos(latitudeDegrees * Math.PI / 180),
  );
  const boundaryHorizontalMagnitude = Math.cos(
    WEB_MERCATOR_MAX_LATITUDE * Math.PI / 180,
  );
  const enterLock = boundaryHorizontalMagnitude / TILE_ONION_ANCHOR_STRIDE;
  const exitLock = enterLock * 2;
  const wasLocked = previousState?.poleLocked ?? false;
  const poleLocked = wasLocked
    ? horizontalMagnitude < exitLock
    : horizontalMagnitude < enterLock;
  return {
    longitudeDegrees:
      poleLocked && previousState
        ? previousState.boundaryLongitudeDegrees
        : wrapLongitude(longitudeDegrees),
    poleLocked,
  };
}

function normalPlanTarget(
  latitudeDegrees: number,
  longitudeDegrees: number,
  zoom: number,
): {
  underfoot: TileAddress;
  anchor: TileOnionAnchor;
  finestTiles: TileAddress[];
} {
  const worldWidth = 2 ** zoom;
  const point = mercatorPoint(latitudeDegrees, longitudeDegrees, zoom);
  const underfoot = {
    z: zoom,
    x: wrapTileX(Math.floor(point.x), zoom),
    y: Math.max(0, Math.min(worldWidth - 1, Math.floor(point.y))),
  };
  if (worldWidth < TILE_ONION_FINE_SIZE) {
    const finestTiles = targetTiles(zoom, 0, 0, worldWidth, worldWidth);
    return {
      underfoot,
      anchor: { z: zoom, x: 0, y: 0, width: worldWidth, height: worldWidth },
      finestTiles,
    };
  }
  const originX = anchorOrigin(Math.floor(point.x));
  const originY = anchorOrigin(underfoot.y);
  return {
    underfoot,
    anchor: {
      z: zoom,
      x: originX,
      y: originY,
      width: TILE_ONION_FINE_SIZE,
      height: TILE_ONION_FINE_SIZE,
    },
    finestTiles: targetTiles(
      zoom,
      originX,
      originY,
      TILE_ONION_FINE_SIZE,
      TILE_ONION_FINE_SIZE,
    ),
  };
}

function boundaryPlanTarget(
  mode: "north-boundary" | "south-boundary",
  longitudeDegrees: number,
  zoom: number,
): { anchor: TileOnionAnchor; finestTiles: TileAddress[] } {
  const worldWidth = 2 ** zoom;
  const width = Math.min(TILE_ONION_FINE_SIZE, worldWidth);
  const height = Math.min(TILE_ONION_FINE_SIZE, worldWidth);
  const point = mercatorPoint(0, longitudeDegrees, zoom);
  const originX =
    worldWidth < TILE_ONION_FINE_SIZE ? 0 : anchorOrigin(Math.floor(point.x));
  const originY = mode === "north-boundary" ? 0 : worldWidth - height;
  return {
    anchor: { z: zoom, x: originX, y: originY, width, height },
    finestTiles: targetTiles(zoom, originX, originY, width, height),
  };
}

function modeForCoordinates(
  latitudeDegrees: number,
  longitudeDegrees: number,
  zoom: number,
): TileOnionMode {
  if (latitudeDegrees > WEB_MERCATOR_MAX_LATITUDE) return "north-boundary";
  if (latitudeDegrees < -WEB_MERCATOR_MAX_LATITUDE) return "south-boundary";
  const worldWidth = 2 ** zoom;
  if (worldWidth < TILE_ONION_FINE_SIZE) return "normal";
  const point = mercatorPoint(latitudeDegrees, longitudeDegrees, zoom);
  const row = Math.max(0, Math.min(worldWidth - 1, Math.floor(point.y)));
  if (row < TILE_ONION_FINE_MARGIN) return "north-boundary";
  if (row > worldWidth - TILE_ONION_FINE_MARGIN - 1) {
    return "south-boundary";
  }
  return "normal";
}

export function calculateTileOnionPlan(
  options: TileOnionPlanOptions,
): TileOnionPlan {
  const latitudeDegrees = Number.isFinite(options.latitudeDegrees)
    ? Math.max(-90, Math.min(90, options.latitudeDegrees))
    : 0;
  const longitudeDegrees = Number.isFinite(options.longitudeDegrees)
    ? wrapLongitude(options.longitudeDegrees)
    : 0;
  const requestedMaxZoom = normalizedZoom(options.maxZoom);
  const mode = modeForCoordinates(
    latitudeDegrees,
    longitudeDegrees,
    requestedMaxZoom,
  );

  let effectiveZoom = requestedMaxZoom;
  let boundary: TileOnionBoundaryDetails | undefined;
  let boundaryLongitudeDegrees = longitudeDegrees;
  let poleLocked = false;
  let underfoot: TileAddress | undefined;
  let anchor: TileOnionAnchor;
  let finestTiles: TileAddress[];

  if (mode === "normal") {
    const target = normalPlanTarget(
      latitudeDegrees,
      longitudeDegrees,
      effectiveZoom,
    );
    underfoot = target.underfoot;
    anchor = target.anchor;
    finestTiles = target.finestTiles;
  } else {
    const stableLongitude = stableBoundaryLongitude(
      latitudeDegrees,
      longitudeDegrees,
      options.previousState,
    );
    boundaryLongitudeDegrees = stableLongitude.longitudeDegrees;
    poleLocked = stableLongitude.poleLocked;
    const distanceKm = boundaryDistanceKm(latitudeDegrees);
    effectiveZoom = boundaryZoom(
      requestedMaxZoom,
      distanceKm,
      mode,
      options.previousState,
    );
    boundary = {
      latitudeDegrees:
        mode === "north-boundary"
          ? WEB_MERCATOR_MAX_LATITUDE
          : -WEB_MERCATOR_MAX_LATITUDE,
      longitudeDegrees: boundaryLongitudeDegrees,
      distanceKm,
    };
    const target = boundaryPlanTarget(
      mode,
      boundaryLongitudeDegrees,
      effectiveZoom,
    );
    anchor = target.anchor;
    finestTiles = target.finestTiles;
  }

  const leaves = balancedQuadtreeLeaves(finestTiles);
  const state: TileOnionState = {
    mode,
    requestedMaxZoom,
    effectiveZoom,
    boundaryLongitudeDegrees,
    poleLocked,
  };
  return {
    mode,
    requestedMaxZoom,
    effectiveZoom,
    coordinates: { latitudeDegrees, longitudeDegrees },
    underfoot,
    anchor,
    finestTiles,
    leaves,
    boundary,
    state,
    signature: [
      mode,
      requestedMaxZoom,
      effectiveZoom,
      anchor.x,
      anchor.y,
      boundaryLongitudeDegrees.toFixed(8),
      poleLocked ? "locked" : "tracking",
      ...leaves.map((tile) => `${tileKey(tile)}:${tile.role}`),
    ].join("|"),
  };
}
