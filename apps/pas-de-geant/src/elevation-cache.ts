import type { TileIdentity } from "./tile-transition-planner.js";
import { retryAfterMilliseconds } from "./tile-request-circuit.js";

function mapterhornUrlForTile(address: TileIdentity): string {
  return `https://tiles.mapterhorn.com/${address.z}/${address.x}/${address.y}.webp`;
}

export const MAPTERHORN_ELEVATION_CACHE_NAME =
  "pas-de-geant-mapterhorn-elevation-v1";

export type ElevationCacheStatus =
  | "hit"
  | "stored"
  | "unavailable"
  | "error";

export interface CachedElevationPayload {
  bytes: ArrayBuffer;
  contentType: string;
  cacheStatus: ElevationCacheStatus;
  retryAfterMs?: number;
}

export interface ElevationResponseCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

export interface ElevationCacheStorage {
  open(cacheName: string): Promise<ElevationResponseCache>;
}

export interface ElevationCacheOptions {
  cacheStorage?: ElevationCacheStorage | null;
  fetcher?: typeof fetch;
}

export type ElevationPayload = CachedElevationPayload & {
  readonly status: number;
};

/** The provider responded, but its successful response had no tile payload. */
export class InvalidElevationPayloadError extends Error {}

function browserCacheStorage(): ElevationCacheStorage | null {
  return typeof caches === "undefined" ? null : caches;
}

function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The elevation request was aborted.", "AbortError");
  }
  const error = new Error("The elevation request was aborted.");
  error.name = "AbortError";
  return error;
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function responsePayload(
  response: Response,
  signal: AbortSignal,
): Promise<Omit<CachedElevationPayload, "cacheStatus">> {
  const bytes = await response.arrayBuffer();
  ensureNotAborted(signal);
  if (bytes.byteLength === 0) {
    throw new InvalidElevationPayloadError("The elevation tile is empty.");
  }
  return {
    bytes,
    contentType: response.headers.get("content-type") ?? "image/webp",
  };
}

/** Reads only persistent storage. A missing or unavailable cache is a miss. */
export async function lookupCachedElevation(
  address: TileIdentity,
  signal: AbortSignal,
  cacheStorage: ElevationCacheStorage | null = browserCacheStorage(),
): Promise<ElevationPayload | undefined> {
  const url = mapterhornUrlForTile(address);
  ensureNotAborted(signal);
  if (!cacheStorage) return undefined;
  try {
    const cache = await cacheStorage.open(MAPTERHORN_ELEVATION_CACHE_NAME);
    ensureNotAborted(signal);
    const cached = await cache.match(url);
    ensureNotAborted(signal);
    if (!cached) return undefined;
    if (!cached.ok) {
      await cache.delete(url);
      return undefined;
    }
    try {
      return {
        ...(await responsePayload(cached, signal)),
        cacheStatus: "hit",
        status: cached.status,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      await cache.delete(url);
      return undefined;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  }
}

/** Fetches only from the provider, then opportunistically persists success. */
export async function loadElevationFromNetwork(
  address: TileIdentity,
  signal: AbortSignal,
  options: ElevationCacheOptions = {},
): Promise<ElevationPayload> {
  const url = mapterhornUrlForTile(address);
  const fetcher = options.fetcher ?? fetch;
  const cacheStorage =
    options.cacheStorage === undefined
      ? browserCacheStorage()
      : options.cacheStorage;
  ensureNotAborted(signal);

  const response = await fetcher(url, {
    cache: "default",
    mode: "cors",
    signal,
  });
  ensureNotAborted(signal);
  const status = response.status;
  if (!response.ok) {
    const retryAfterMs = retryAfterMilliseconds(
      response.headers.get("retry-after"),
    );
    return {
      bytes: new ArrayBuffer(0),
      contentType: response.headers.get("content-type") ?? "",
      cacheStatus: "unavailable",
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  const responseForCache = cacheStorage ? response.clone() : undefined;
  const payload = await responsePayload(response, signal);
  let cacheStatus: ElevationCacheStatus = "unavailable";
  if (cacheStorage && responseForCache) {
    try {
      const cache = await cacheStorage.open(MAPTERHORN_ELEVATION_CACHE_NAME);
      ensureNotAborted(signal);
      await cache.put(url, responseForCache);
      ensureNotAborted(signal);
      cacheStatus = "stored";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      cacheStatus = "error";
    }
  }
  return { ...payload, cacheStatus, status };
}

/** Backwards-compatible cache-first composition for non-scheduled callers. */
export async function loadCachedElevation(
  address: TileIdentity,
  signal: AbortSignal,
  options: ElevationCacheOptions = {},
): Promise<ElevationPayload> {
  const cacheStorage =
    options.cacheStorage === undefined
      ? browserCacheStorage()
      : options.cacheStorage;
  const cached = await lookupCachedElevation(address, signal, cacheStorage);
  if (cached) return cached;
  return loadElevationFromNetwork(address, signal, {
    ...options,
    cacheStorage,
  });
}

export async function deleteCachedElevation(
  address: TileIdentity,
  cacheStorage: ElevationCacheStorage | null = browserCacheStorage(),
): Promise<"deleted" | "missing" | "unavailable" | "error"> {
  if (!cacheStorage) return "unavailable";
  try {
    const cache = await cacheStorage.open(MAPTERHORN_ELEVATION_CACHE_NAME);
    return (await cache.delete(mapterhornUrlForTile(address)))
      ? "deleted"
      : "missing";
  } catch {
    return "error";
  }
}
