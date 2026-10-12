import { APOLLO_REGIONAL_IMAGERY, type LunarRegionalImagery } from "./lunar-regional-imagery-metadata.js";
import type { GeographicBounds } from "./lunar-imagery-study.js";

export const LUNAR_REGIONAL_TILE_PATH = "/lunar-study-tiles";

export function lunarRegionalTiers(region: LunarRegionalImagery = APOLLO_REGIONAL_IMAGERY[11]!): { width: number; height: number; columns: number; rows: number }[] {
  let width = region.width;
  let height = region.height;
  const tiers = [];
  while (true) {
    tiers.unshift({ width, height, columns: Math.ceil(width / region.tileSize), rows: Math.ceil(height / region.tileSize) });
    if (width <= region.tileSize && height <= region.tileSize) return tiers;
    width = Math.floor(width / 2);
    height = Math.floor(height / 2);
  }
}

/** Zoomify's group is determined by the tile's index across all earlier tiers. */
export function lunarRegionalUpstreamUrl(level: number, x: number, y: number, region: LunarRegionalImagery = APOLLO_REGIONAL_IMAGERY[11]!): string | undefined {
  const tiers = lunarRegionalTiers(region);
  const tier = tiers[level];
  if (!Number.isInteger(level) || !tier || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= tier.columns || y >= tier.rows) return undefined;
  const earlier = tiers.slice(0, level).reduce((total, entry) => total + entry.columns * entry.rows, 0);
  const group = Math.floor((earlier + y * tier.columns + x) / 256);
  return `${region.zoomifyUrl}/TileGroup${group}/${level}-${x}-${y}.jpg`;
}

export function lunarRegionalTileUrl(level: number, x: number, y: number, region: LunarRegionalImagery): string {
  return `${LUNAR_REGIONAL_TILE_PATH}/${region.id}/${level}/${x}/${y}.jpg`;
}

/** Draw only the archive tiles intersecting one geographic study-map tile. */
export async function paintLunarRegionalTile(
  canvas: HTMLCanvasElement, bounds: GeographicBounds, signal: AbortSignal, region: LunarRegionalImagery,
): Promise<void> {
  const [west, south, east, north] = bounds;
  const [sourceWest, sourceSouth, sourceEast, sourceNorth] = region.bounds as unknown as GeographicBounds;
  if (east <= sourceWest || west >= sourceEast || north <= sourceSouth || south >= sourceNorth) return;
  const longitudeStep = (sourceEast - sourceWest) / region.width;
  const latitudeStep = (sourceNorth - sourceSouth) / region.height;
  const nativePixelsPerOutput = (east - west) / canvas.width / longitudeStep;
  const tiers = lunarRegionalTiers(region);
  const level = Math.max(0, Math.min(tiers.length - 1, Math.ceil(tiers.length - 1 - Math.log2(nativePixelsPerOutput))));
  const tier = tiers[level]!;
  const factor = 2 ** (tiers.length - 1 - level);
  const tileLongitude = longitudeStep * factor * region.tileSize;
  const tileLatitude = latitudeStep * factor * region.tileSize;
  const minimumX = Math.max(0, Math.floor((west - sourceWest) / tileLongitude));
  const maximumX = Math.min(tier.columns - 1, Math.ceil((east - sourceWest) / tileLongitude) - 1);
  const minimumY = Math.max(0, Math.floor((sourceNorth - north) / tileLatitude));
  const maximumY = Math.min(tier.rows - 1, Math.ceil((sourceNorth - south) / tileLatitude) - 1);
  const context = canvas.getContext("2d")!;
  const outputX = (longitude: number): number => (longitude - west) / (east - west) * canvas.width;
  const outputY = (latitude: number): number => (north - latitude) / (north - south) * canvas.height;
  // A published no-data mask supplies the footprint; dark JPEG terrain is valid.
  context.save();
  context.beginPath();
  for (const polygon of region.coverage) for (const ring of polygon) {
    ring.forEach(([longitude, latitude], index) => {
      const x = outputX(longitude!); const y = outputY(latitude!);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.closePath();
  }
  context.clip("evenodd");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  try {
    const requests: Promise<void>[] = [];
    for (let y = minimumY; y <= maximumY; y++) for (let x = minimumX; x <= maximumX; x++) {
      requests.push((async () => {
        const response = await fetch(lunarRegionalTileUrl(level, x, y, region), { signal });
        if (!response.ok) throw new Error(`Regional imagery request failed (${response.status}).`);
        const bitmap = await createImageBitmap(await response.blob());
        try {
          if (signal.aborted) return;
          context.drawImage(bitmap,
            outputX(sourceWest + x * tileLongitude), outputY(sourceNorth - y * tileLatitude),
            bitmap.width * longitudeStep * factor / (east - west) * canvas.width,
            bitmap.height * latitudeStep * factor / (north - south) * canvas.height);
        } finally { bitmap.close(); }
      })());
    }
    const results = await Promise.allSettled(requests);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } finally { context.restore(); }
}
