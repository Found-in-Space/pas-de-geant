import type { TileIdentity } from "./tile-transition-planner.js";

function isValidImageryAddress(address: TileIdentity): boolean {
  const width = 2 ** address.z;
  return (
    Number.isSafeInteger(address.z) &&
    Number.isSafeInteger(address.x) &&
    Number.isSafeInteger(address.y) &&
    address.z >= 0 &&
    address.x >= 0 &&
    address.x < width &&
    address.y >= 0 &&
    address.y < width
  );
}

export interface ImageryProvider {
  readonly id: string;
  readonly attribution: string;
  readonly tileSize: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  load(address: TileIdentity, signal: AbortSignal): Promise<Blob>;
}

export interface XyzImageryConfiguration {
  id?: string;
  urlTemplate: string;
  attribution: string;
  tileSize?: number;
  minZoom?: number;
  maxZoom?: number;
}

export const MAPTILER_IMAGERY_CACHE_NAME =
  "pas-de-geant-maptiler-imagery-v1";

export interface ImageryResponseCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

export interface ImageryCacheStorage {
  open(cacheName: string): Promise<ImageryResponseCache>;
}

export interface XyzImageryProviderOptions {
  cacheStorage?: ImageryCacheStorage | null;
  fetcher?: typeof fetch;
}

declare global {
  interface Window {
    __PAS_DE_GEANT_IMAGERY_CONFIG__?: XyzImageryConfiguration;
    __PAS_DE_GEANT_IMAGERY_PROVIDER__?: ImageryProvider;
  }
}

export class ImageryRequestError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "transient" | "malformed",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ImageryRequestError";
  }
}

function browserCacheStorage(): ImageryCacheStorage | null {
  return typeof caches === "undefined" ? null : caches;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The imagery request was aborted.", "AbortError");
  }
  const error = new Error("The imagery request was aborted.");
  error.name = "AbortError";
  return error;
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isMapTilerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "api.maptiler.com";
  } catch {
    return false;
  }
}

async function imageBlob(response: Response): Promise<Blob> {
  const blob = await response.blob();
  if (blob.size === 0 || !blob.type.toLowerCase().startsWith("image/")) {
    throw new ImageryRequestError(
      "The imagery response is not an image.",
      "malformed",
    );
  }
  return blob;
}

export class XyzImageryProvider implements ImageryProvider {
  readonly id: string;
  readonly attribution: string;
  readonly tileSize: number;
  readonly minZoom: number;
  readonly maxZoom: number;

  constructor(
    private readonly configuration: XyzImageryConfiguration,
    private readonly options: XyzImageryProviderOptions = {},
  ) {
    if (
      !configuration.urlTemplate.includes("{z}") ||
      !configuration.urlTemplate.includes("{x}") ||
      !configuration.urlTemplate.includes("{y}")
    ) {
      throw new Error(
        "The imagery URL template must contain {z}, {x}, and {y}.",
      );
    }
    if (!configuration.attribution.trim()) {
      throw new Error("Photographic imagery requires provider attribution.");
    }
    this.id = configuration.id?.trim() || "configured-xyz";
    this.attribution = configuration.attribution.trim();
    this.tileSize = Math.floor(configuration.tileSize ?? 256);
    if (!Number.isSafeInteger(this.tileSize) || this.tileSize <= 0) {
      throw new Error("The imagery tile size must be a positive integer.");
    }
    this.minZoom = Math.max(0, Math.floor(configuration.minZoom ?? 0));
    this.maxZoom = Math.max(
      this.minZoom,
      Math.floor(configuration.maxZoom ?? 20),
    );
  }

  async load(address: TileIdentity, signal: AbortSignal): Promise<Blob> {
    if (
      !isValidImageryAddress(address) ||
      address.z < this.minZoom ||
      address.z > this.maxZoom
    ) {
      throw new ImageryRequestError(
        "The imagery address is outside provider coverage.",
        "not-found",
      );
    }
    const url = this.configuration.urlTemplate
      .replaceAll("{z}", String(address.z))
      .replaceAll("{x}", String(address.x))
      .replaceAll("{y}", String(address.y));
    const cacheStorage = this.options.cacheStorage === undefined
      ? browserCacheStorage()
      : this.options.cacheStorage;
    let cache: ImageryResponseCache | undefined;
    if (cacheStorage && isMapTilerUrl(url)) {
      try {
        cache = await cacheStorage.open(MAPTILER_IMAGERY_CACHE_NAME);
        ensureNotAborted(signal);
        const cached = await cache.match(url);
        ensureNotAborted(signal);
        if (cached?.ok) {
          try {
            const blob = await imageBlob(cached);
            ensureNotAborted(signal);
            return blob;
          } catch (error) {
            if (isAbortError(error)) throw error;
            await cache.delete(url);
          }
        } else if (cached) {
          await cache.delete(url);
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        cache = undefined;
      }
    }

    const response = await (this.options.fetcher ?? fetch)(url, {
      cache: "default",
      mode: "cors",
      signal,
    });
    if (!response.ok) {
      throw new ImageryRequestError(
        `Imagery tile request failed with ${response.status}.`,
        response.status === 404 ? "not-found" : "transient",
        response.status,
      );
    }
    const responseForCache = cache ? response.clone() : undefined;
    const blob = await imageBlob(response);
    ensureNotAborted(signal);
    if (cache && responseForCache) {
      try {
        await cache.put(url, responseForCache);
        ensureNotAborted(signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
    }
    return blob;
  }
}

export function configuredXyzImageryProvider(
  configuration: XyzImageryConfiguration | undefined,
): ImageryProvider | undefined {
  return configuration ? new XyzImageryProvider(configuration) : undefined;
}
