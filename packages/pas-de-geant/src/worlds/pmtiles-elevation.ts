import { Compression, ResolvedValueCache, TileType, findTile, tileIdToZxy, zxyToTileId,
  type Entry, type Header, type RangeResponse, type Source } from "pmtiles";
import { ImageTileProvider, HttpTileError, decodeBlobImage, elevationSourceMapping,
  type ImageTileCacheStatus } from "./image-tile-provider.js";
import type { ElevationCacheStorage } from "./elevation-cache.js";
import type { ElevationSource } from "./surface-product.js";
import { tileCoverageRanges } from "./tile-refinement.js";

/** Explicit visualisation policy; this does not establish or convert a datum. */
export interface EarthPmtilesDatasetBinding {
  readonly transport: "pmtiles";
  readonly productUrl: string;
  readonly productSha256: string;
  readonly attribution: string;
  readonly verticalReference: "preserve-upstream";
}

interface EarthPmtilesSource extends ElevationSource {
  readonly archive: { readonly file: string; readonly bytes: number; readonly addressedTiles: number };
}

/** Admit the existing experimental producer contract without reinterpreting it as XYZ heights. */
export function earthPmtilesElevationSource(value: unknown, body: string,
  binding: EarthPmtilesDatasetBinding): EarthPmtilesSource {
  const product = value as any;
  if (body !== "earth" || binding.verticalReference !== "preserve-upstream" ||
    !/^[a-f0-9]{64}$/.test(binding.productSha256) ||
    product?.format !== "earth-elevation-pmtiles" || product.formatVersion !== 1 || product.body !== "earth" ||
    product.units !== "metres" || product.grid?.projection !== "EPSG:3857" || product.grid.scheme !== "xyz" ||
    product.grid.radiusMetres !== 6_378_137 || product.verticalReference?.kind !== "upstream-unresolved" ||
    product.verticalReference.transformation !== "none" || product.transport?.kind !== "pmtiles" ||
    product.transport.version !== 3 || product.transport.file !== "earth.pmtiles" || product.transport.httpRangeRequired !== true ||
    !Number.isSafeInteger(product.transport.bytes) || product.transport.bytes < 16_384 ||
    !/^[a-f0-9]{64}$/.test(product.transport.sha256) || product.encoding?.kind !== "terrarium" ||
    product.encoding.payload !== "png" || product.encoding.channels !== "RGB" || product.encoding.tileSize !== 256 ||
    product.encoding.quantumMetres !== 1 / 256 || product.zooms?.minimum !== 0 ||
    !Number.isSafeInteger(product.zooms.maximum) || product.zooms.maximum < 1 || product.zooms.maximum > 13 ||
    !Number.isSafeInteger(product.coverage?.addressedTiles) || product.coverage.addressedTiles < 1) {
    throw new Error("Unsupported Earth PMTiles source or missing preserve-upstream height policy.");
  }
  return {
    identity: product.transport.sha256,
    grid: { formatVersion: 1, projection: "web-mercator", radiusMetres: 6_378_137 },
    heightEncoding: { kind: "terrarium" },
    metadata: { tilePixels: 256, maxSourceZoom: product.zooms.maximum,
      attribution: `${binding.attribution} · unresolved upstream height reference; zero may include missing source data`,
      elevationBoundsMetres: { minimum: -32_768, maximum: 32_767 + 255 / 256 } },
    archive: { file: product.transport.file, bytes: product.transport.bytes, addressedTiles: product.coverage.addressedTiles },
  };
}

const CACHE_NAME = "pas-de-geant-pmtiles-elevation-v1";
interface RangePayload extends RangeResponse {
  readonly cacheStatus: Exclude<ImageTileCacheStatus, "memory" | "shared">;
}

/** Cache successful ranges indefinitely, under the descriptor's immutable archive identity. */
class ArchiveRanges implements Source {
  private etag: string | undefined;
  constructor(private readonly url: string, private readonly identity: string, private readonly bytes: number,
    private readonly fetcher: typeof fetch, private readonly storage: ElevationCacheStorage | null,
    private admissionSignal?: AbortSignal) {}
  getKey() { return `${this.url}#sha256=${this.identity}`; }
  admitted() { this.admissionSignal = undefined; }
  private cacheKey(offset: number, length: number) {
    const key = new URL(this.url);
    key.searchParams.set("geant-pmtiles-sha256", this.identity);
    key.searchParams.set("geant-pmtiles-range", `${offset}-${length}`);
    return key.href;
  }
  private admitResponse(response: Response, offset: number, length: number, cached: boolean): string {
    if (response.status !== (cached ? 200 : 206) ||
      response.headers.get("content-range") !== `bytes ${offset}-${offset + length - 1}/${this.bytes}` ||
      ![null, "identity"].includes(response.headers.get("content-encoding"))) {
      throw new HttpTileError(response.status, "PMTiles server or cache returned an invalid byte range.");
    }
    const etag = response.headers.get("etag");
    if (!etag || !/^".+"$/.test(etag) || (this.etag !== undefined && this.etag !== etag)) {
      throw new Error("PMTiles archive identity changed or its strong ETag is unavailable.");
    }
    return etag;
  }
  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangePayload> {
    return (await this.readBytes(offset, length, signal, false))!;
  }
  getCachedBytes(offset: number, length: number, signal: AbortSignal) {
    return this.readBytes(offset, length, signal, true);
  }
  private async readBytes(offset: number, length: number, requestedSignal: AbortSignal | undefined,
    cacheOnly: boolean): Promise<RangePayload | undefined> {
    const signals = [this.admissionSignal, requestedSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > this.bytes) {
      throw new Error("PMTiles range is outside the admitted archive.");
    }
    const key = this.cacheKey(offset, length);
    let cache: Awaited<ReturnType<ElevationCacheStorage["open"]>> | undefined;
    try {
      cache = await this.storage?.open(CACHE_NAME);
      signal?.throwIfAborted();
      const cached = await cache?.match(key);
      if (cached) {
        try {
          const etag = this.admitResponse(cached, offset, length, true);
          const data = await cached.arrayBuffer();
          signal?.throwIfAborted();
          if (data.byteLength !== length) throw new Error("Truncated cached PMTiles range.");
          this.etag = etag;
          return { data, etag, cacheStatus: "persistent-hit" };
        } catch (error) { signal?.throwIfAborted(); await cache?.delete(key); }
      }
    } catch (error) { signal?.throwIfAborted(); cache = undefined; }
    if (cacheOnly) return undefined;
    // Native Window.fetch must not receive this range reader as its receiver.
    const fetcher = this.fetcher;
    const response = await fetcher(this.url, { signal, mode: "cors", headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    signal?.throwIfAborted();
    let etag: string;
    try { etag = this.admitResponse(response, offset, length, false); }
    catch (error) {
      // A server ignoring Range can otherwise keep streaming the whole archive.
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    const data = await response.arrayBuffer();
    signal?.throwIfAborted();
    if (data.byteLength !== length) throw new Error("Truncated PMTiles range.");
    this.etag = etag;
    let cacheStatus: RangePayload["cacheStatus"] = "persistent-unavailable";
    if (cache) {
      try {
        // Cache Storage rejects HTTP 206. The private key and retained range
        // headers describe a complete cached range, stored as HTTP 200.
        await cache.put(key, new Response(data, { headers: { "content-range": response.headers.get("content-range")!, etag } }));
        cacheStatus = "persistent-write";
      } catch { cacheStatus = "persistent-error"; }
      signal?.throwIfAborted();
    }
    return { data, etag, cacheStatus };
  }
  async forget(offset: number, length: number) {
    try { await (await this.storage?.open(CACHE_NAME))?.delete(this.cacheKey(offset, length)); } catch { /* Optional storage. */ }
  }
}

function admitHeader(header: Header, source: EarthPmtilesSource) {
  if (header.specVersion !== 3 || header.tileType !== TileType.Png || header.tileCompression !== Compression.None ||
    header.internalCompression !== Compression.Gzip || header.minZoom !== 0 || header.maxZoom !== source.metadata.maxSourceZoom ||
    header.numAddressedTiles !== source.archive.addressedTiles) throw new Error("PMTiles header differs from its admitted descriptor.");
  const sections = [
    [header.rootDirectoryOffset, header.rootDirectoryLength], [header.jsonMetadataOffset, header.jsonMetadataLength],
    [header.leafDirectoryOffset, header.leafDirectoryLength ?? 0], [header.tileDataOffset, header.tileDataLength ?? 0],
  ].filter(([, length]) => length! > 0).sort(([a], [b]) => a! - b!);
  if (sections.some(([offset, length], i) => !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset! < 127 ||
    offset! + length! > source.archive.bytes || (i > 0 && sections[i - 1]![0]! + sections[i - 1]![1]! > offset!)) ||
    header.rootDirectoryOffset + header.rootDirectoryLength > 16_384) throw new Error("PMTiles sections are invalid.");
}

/** Read the directory once; intended for bounded journey archives, not a live global download.
 * The directory stays authoritative. Coarser fallback uses the same mapping and
 * source queue as XYZ terrain, including correct ancestor UVs and cancellation.
 */
export async function createEarthPmtilesElevationProvider(source: EarthPmtilesSource, options: {
  readonly productUrl: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
  readonly cacheStorage?: ElevationCacheStorage | null;
}) {
  const ranges = new ArchiveRanges(new URL(source.archive.file, options.productUrl).href, source.identity, source.archive.bytes,
    options.fetcher ?? fetch, options.cacheStorage === undefined ? (typeof caches === "undefined" ? null : caches) : options.cacheStorage, options.signal);
  const cache = new ResolvedValueCache(), header = await cache.getHeader(ranges);
  options.signal?.throwIfAborted();
  admitHeader(header, source);
  const entries: Entry[] = [], visited = new Set<number>();
  async function visit(offset: number, length: number) {
    if (visited.has(offset)) throw new Error("Cyclic or duplicate PMTiles directory.");
    visited.add(offset);
    for (const entry of await cache.getDirectory(ranges, offset, length, header, options.signal)) {
      options.signal?.throwIfAborted();
      if (entry.runLength > 0) entries.push(entry);
      else {
        const end = entry.offset + entry.length;
        if (entry.offset < 0 || entry.length < 1 || end > (header.leafDirectoryLength ?? 0)) throw new Error("PMTiles leaf is outside its section.");
        await visit(header.leafDirectoryOffset + entry.offset, entry.length);
      }
    }
  }
  await visit(header.rootDirectoryOffset, header.rootDirectoryLength);
  let count = 0, previousEnd = 0;
  const levels = new Map<number, [number, number][]>();
  for (const entry of entries) {
    if (![entry.tileId, entry.offset, entry.length, entry.runLength].every(Number.isSafeInteger) || entry.tileId < previousEnd ||
      entry.offset < 0 || entry.length < 1 || entry.offset + entry.length > (header.tileDataLength ?? 0) || entry.runLength < 1) {
      throw new Error("Invalid, overlapping or unsorted PMTiles entries.");
    }
    for (let id = entry.tileId; id < entry.tileId + entry.runLength; id++) {
      const [z, x, y] = tileIdToZxy(id);
      if (z > header.maxZoom) throw new Error("PMTiles tile is outside its declared zooms.");
      const tiles = levels.get(z) ?? []; tiles.push([x, y]); levels.set(z, tiles);
    }
    previousEnd = entry.tileId + entry.runLength; count += entry.runLength;
  }
  if (count !== header.numAddressedTiles || entries.length !== header.numTileEntries || !findTile(entries, 0)) {
    throw new Error("PMTiles availability differs from its header or lacks a root tile.");
  }
  const availability = { globalMaximumZoom: 0, ranges: tileCoverageRanges([...levels].filter(([z]) => z > 0)
    .map(([zoom, tiles]) => ({ zoom, tiles }))) };
  ranges.admitted();
  return new ImageTileProvider<RangePayload>({ mode: "terrain", tilePixels: source.metadata.tilePixels,
    attribution: source.metadata.attribution, coverage: availability, processingConcurrency: 4,
    resolveSource: tile => elevationSourceMapping(tile, source.metadata.maxSourceZoom, availability),
    async loadFromCache(tile, signal) {
      const entry = findTile(entries, zxyToTileId(tile.z, tile.x, tile.y));
      if (!entry) throw new Error("Declared PMTiles elevation tile is absent.");
      return ranges.getCachedBytes(header.tileDataOffset + entry.offset, entry.length, signal);
    },
    async loadSource(tile, signal) {
      const entry = findTile(entries, zxyToTileId(tile.z, tile.x, tile.y));
      if (!entry) throw new Error("Declared PMTiles elevation tile is absent.");
      return ranges.getBytes(header.tileDataOffset + entry.offset, entry.length, signal);
    },
    async processSource(tile, payload, signal) {
      try {
        return { image: await decodeBlobImage(new Blob([payload.data], { type: "image/png" }), source.metadata.tilePixels, signal),
          byteLength: payload.data.byteLength, cacheStatus: payload.cacheStatus };
      } catch (error) {
        if (!signal.aborted) {
          const entry = findTile(entries, zxyToTileId(tile.z, tile.x, tile.y))!;
          await ranges.forget(header.tileDataOffset + entry.offset, entry.length);
        }
        throw error;
      }
    },
  });
}
