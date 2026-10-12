import type { TileIdentity } from "./tile-transition-planner.js";
import { retryAfterMilliseconds } from "./tile-request-circuit.js";
import { tileProxyUrlTemplate } from "./tile-proxy.js";

function elevationUrlForTile(address: TileIdentity, template = tileProxyUrlTemplate("elevation")): string {
  return template.replaceAll("{z}", String(address.z)).replaceAll("{x}", String(address.x)).replaceAll("{y}", String(address.y));
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
  urlTemplate?: string;
  cacheStorage?: ElevationCacheStorage | null;
  fetcher?: typeof fetch;
  /** @deprecated Proxy routing and browser persistence are both always enabled. */
  useProxy?: boolean;
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
  _useProxy = true,
  urlTemplate?: string,
): Promise<ElevationPayload | undefined> {
  ensureNotAborted(signal);
  if (!cacheStorage) return undefined;
  const url = elevationUrlForTile(address, urlTemplate);
  try {
    const cache = await cacheStorage.open(MAPTERHORN_ELEVATION_CACHE_NAME);
    ensureNotAborted(signal);
    const cached = await cache.match(url);
    ensureNotAborted(signal);
    if (!cached) return undefined;
    if (!cached.ok || cached.headers.has("x-pas-de-geant-tile-fallback") ||
      cached.headers.get("x-pas-de-geant-tile-cache") === "FALLBACK") {
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
  const fetcher = options.fetcher ?? fetch;
  const url = elevationUrlForTile(address, options.urlTemplate);
  const cacheStorage = options.cacheStorage === undefined
    ? browserCacheStorage()
    : options.cacheStorage;
  ensureNotAborted(signal);

  let response = await fetcher(url, {
    cache: "default",
    mode: "cors",
    signal,
  });
  ensureNotAborted(signal);
  const isFallback = (value: Response) =>
    value.headers.has("x-pas-de-geant-tile-fallback") ||
    value.headers.get("x-pas-de-geant-tile-cache") === "FALLBACK";
  if (response.ok && isFallback(response)) {
    response = await fetcher(url, { cache: "reload", mode: "cors", signal });
    ensureNotAborted(signal);
  }
  const status = isFallback(response) ? 503 : response.status;
  if (!response.ok || isFallback(response)) {
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
  const proxyCacheStatus = response.headers.get(
    "x-pas-de-geant-tile-cache",
  );
  let cacheStatus: ElevationCacheStatus = proxyCacheStatus === "HIT"
    ? "hit"
    : proxyCacheStatus === "MISS"
    ? "stored"
    : "unavailable";
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
  const cacheStorage = options.cacheStorage === undefined
    ? browserCacheStorage()
    : options.cacheStorage;
  const cached = await lookupCachedElevation(
    address,
    signal,
    cacheStorage,
    true,
    options.urlTemplate,
  );
  if (cached) return cached;
  return loadElevationFromNetwork(address, signal, {
    ...options,
    cacheStorage,
  });
}

export async function deleteCachedElevation(
  address: TileIdentity,
  options: ElevationCacheOptions = {},
): Promise<"deleted" | "missing" | "unavailable" | "error"> {
  const url = elevationUrlForTile(address, options.urlTemplate);
  let browserDeleted = false;
  try {
    const storage = browserCacheStorage();
    if (storage) {
      const cache = await storage.open(MAPTERHORN_ELEVATION_CACHE_NAME);
      browserDeleted = await cache.delete(url);
    }
  } catch {
    // Browser storage failure must not prevent invalidating the proxy entry.
  }
  if (!url.startsWith("/api/tiles/")) return browserDeleted ? "deleted" : "missing";
  try {
    const response = await fetch(url, {
      method: "DELETE",
    });
    return response.status === 204 || (response.status === 404 && browserDeleted)
      ? "deleted"
      : response.status === 404
      ? "missing"
      : "error";
  } catch {
    return "error";
  }
}
