import {
  mapterhornUrlForTile,
  type MercatorTileAddress,
} from "./local-terrain-core.js";

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
    throw new Error("The elevation tile is empty.");
  }
  return {
    bytes,
    contentType: response.headers.get("content-type") ?? "image/webp",
  };
}

export async function loadCachedElevation(
  address: MercatorTileAddress,
  signal: AbortSignal,
  options: ElevationCacheOptions = {},
): Promise<CachedElevationPayload & { status: number }> {
  const url = mapterhornUrlForTile(address);
  const fetcher = options.fetcher ?? fetch;
  const cacheStorage =
    options.cacheStorage === undefined
      ? browserCacheStorage()
      : options.cacheStorage;
  let cache: ElevationResponseCache | undefined;
  let cacheFailed = false;
  if (cacheStorage) {
    try {
      cache = await cacheStorage.open(MAPTERHORN_ELEVATION_CACHE_NAME);
      ensureNotAborted(signal);
      const cached = await cache.match(url);
      ensureNotAborted(signal);
      if (cached?.ok) {
        try {
          return {
            ...(await responsePayload(cached, signal)),
            cacheStatus: "hit",
            status: cached.status,
          };
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          await cache.delete(url);
        }
      } else if (cached) {
        await cache.delete(url);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      cacheFailed = true;
      cache = undefined;
    }
  }

  const response = await fetcher(url, {
    cache: "default",
    mode: "cors",
    signal,
  });
  ensureNotAborted(signal);
  const status = response.status;
  if (!response.ok) {
    return {
      bytes: new ArrayBuffer(0),
      contentType: response.headers.get("content-type") ?? "",
      cacheStatus: cacheFailed ? "error" : "unavailable",
      status,
    };
  }
  const responseForCache = cache ? response.clone() : undefined;
  const payload = await responsePayload(response, signal);
  let cacheStatus: ElevationCacheStatus = cacheFailed
    ? "error"
    : "unavailable";
  if (cache && responseForCache) {
    try {
      await cache.put(url, responseForCache);
      cacheStatus = "stored";
    } catch {
      cacheStatus = "error";
    }
  }
  return { ...payload, cacheStatus, status };
}

export async function deleteCachedElevation(
  address: MercatorTileAddress,
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
