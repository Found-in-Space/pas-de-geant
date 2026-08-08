import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { isAllowedRequestOrigin } from "./realtime-token-server.js";
import { TILE_PROXY_PATH } from "./tile-proxy.js";
import type { TileIdentity } from "./tile-transition-planner.js";

const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MINIMUM_INTERVAL_MS = 250;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_UPSTREAM_BACKOFF_MS = 5_000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/;

interface CachedTileMetadata {
  readonly version: 1;
  readonly contentType: string;
  readonly cacheControl?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly expiresAtMs: number;
}

interface CachedTile {
  readonly metadata: CachedTileMetadata;
  readonly body: Buffer;
}

interface UpstreamTile {
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string;
  readonly cacheControl?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly retryAfter?: string;
  readonly body: Buffer;
}

export type TileProxyCacheStatus = "HIT" | "MISS" | "COALESCED";
export type TileProxyScheme = "xyz" | "tms";

export interface TileProxyResult extends UpstreamTile {
  readonly cacheStatus: TileProxyCacheStatus;
}

export interface TileProxyProviderOptions {
  readonly urlTemplate: string;
  readonly scheme?: TileProxyScheme;
  readonly cacheKeyIgnoredSearchParameters?: readonly string[];
  readonly maxConcurrency?: number;
  readonly minimumIntervalMs?: number;
  readonly defaultCacheTtlMs?: number;
  readonly upstreamBackoffMs?: number;
}

export interface TileProxyOptions {
  readonly cacheDirectory: string;
  readonly providers: Readonly<Record<string, TileProxyProviderOptions>>;
  readonly cacheKeyIgnoredSearchParameters?: readonly string[];
  readonly maxConcurrency?: number;
  readonly minimumIntervalMs?: number;
  readonly defaultCacheTtlMs?: number;
  readonly upstreamBackoffMs?: number;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => number;
}

interface TileProxyServiceOptions extends TileProxyProviderOptions {
  readonly cacheDirectory: string;
  readonly fetchImplementation?: typeof fetch;
  readonly now?: () => number;
}

interface QueuedRequest<T> {
  readonly run: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

class UpstreamThrottle {
  private readonly queue: QueuedRequest<unknown>[] = [];
  private active = 0;
  private nextStartAtMs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly maxConcurrency: number,
    private readonly minimumIntervalMs: number,
    private readonly now: () => number,
  ) {}

  schedule<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  pauseFor(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    this.nextStartAtMs = Math.max(
      this.nextStartAtMs,
      this.now() + Math.floor(milliseconds),
    );
    this.armTimer();
  }

  private pump(): void {
    if (this.active >= this.maxConcurrency || this.queue.length === 0) return;
    const delayMs = Math.max(0, this.nextStartAtMs - this.now());
    if (delayMs > 0) {
      this.armTimer();
      return;
    }
    const queued = this.queue.shift()!;
    this.active += 1;
    this.nextStartAtMs = this.now() + this.minimumIntervalMs;
    void queued.run().then(queued.resolve, queued.reject).finally(() => {
      this.active -= 1;
      this.pump();
    });
    this.pump();
  }

  private armTimer(): void {
    if (this.timer || this.queue.length === 0) return;
    const delayMs = Math.max(0, this.nextStartAtMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, delayMs);
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : fallback;
}

function requestHost(request: IncomingMessage): string | undefined {
  const forwardedHost = request.headers["x-forwarded-host"];
  return (
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
      ?.split(",")[0]
      ?.trim() ?? request.headers.host
  );
}

function retryAfterMilliseconds(value: string | undefined, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function cacheLifetimeMilliseconds(
  headers: Headers,
  now: number,
  fallback: number,
): number {
  const cacheControl = headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*(?:no-store|private)(?:\s|,|$)/i.test(cacheControl)) {
    return 0;
  }
  const age = /(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*(\d+)/i.exec(
    cacheControl,
  );
  if (age) return Number(age[1]) * 1_000;
  const expiresAt = Date.parse(headers.get("expires") ?? "");
  return Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : fallback;
}

function cacheIdentity(
  url: URL,
  ignoredSearchParameters: readonly string[],
): string {
  const normalized = new URL(url);
  for (const parameter of ignoredSearchParameters) {
    normalized.searchParams.delete(parameter);
  }
  normalized.searchParams.sort();
  return createHash("sha256")
    .update(`${normalized.origin}${normalized.pathname}${normalized.search}`)
    .digest("hex");
}

function cachePaths(cacheDirectory: string, identity: string) {
  const directory = join(cacheDirectory, identity.slice(0, 2));
  const base = join(directory, identity.slice(2));
  return {
    directory,
    body: `${base}.tile`,
    metadata: `${base}.json`,
  };
}

function upstreamTile(response: Response, body: Buffer): UpstreamTile {
  return {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type") ??
      "application/octet-stream",
    ...(response.headers.get("cache-control")
      ? { cacheControl: response.headers.get("cache-control")! }
      : {}),
    ...(response.headers.get("etag")
      ? { etag: response.headers.get("etag")! }
      : {}),
    ...(response.headers.get("last-modified")
      ? { lastModified: response.headers.get("last-modified")! }
      : {}),
    ...(response.headers.get("retry-after")
      ? { retryAfter: response.headers.get("retry-after")! }
      : {}),
    body,
  };
}

function validateUrlTemplate(urlTemplate: string): void {
  if (
    !urlTemplate.includes("{z}") ||
    !urlTemplate.includes("{x}") ||
    !urlTemplate.includes("{y}")
  ) {
    throw new Error("Tile proxy URL templates require {z}, {x}, and {y}.");
  }
  const url = new URL(urlTemplate);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new Error("Tile proxy URL templates must use HTTP(S).");
  }
}

function upstreamUrl(
  template: string,
  scheme: TileProxyScheme,
  address: TileIdentity,
): URL {
  const width = 2 ** address.z;
  const y = scheme === "tms" ? width - 1 - address.y : address.y;
  return new URL(
    template
      .replaceAll("{z}", String(address.z))
      .replaceAll("{x}", String(address.x))
      .replaceAll("{y}", String(y)),
  );
}

function validAddress(address: TileIdentity): boolean {
  if (
    !Number.isSafeInteger(address.z) ||
    !Number.isSafeInteger(address.x) ||
    !Number.isSafeInteger(address.y) ||
    address.z < 0 ||
    address.x < 0 ||
    address.y < 0
  ) return false;
  const width = 2 ** address.z;
  return Number.isSafeInteger(width) && address.x < width && address.y < width;
}

export class TileProxyService {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly defaultCacheTtlMs: number;
  private readonly upstreamBackoffMs: number;
  private readonly cacheKeyIgnoredSearchParameters: readonly string[];
  private readonly scheme: TileProxyScheme;
  private readonly throttle: UpstreamThrottle;
  private readonly inFlight = new Map<string, Promise<UpstreamTile>>();

  constructor(private readonly options: TileProxyServiceOptions) {
    validateUrlTemplate(options.urlTemplate);
    this.scheme = options.scheme ?? "xyz";
    if (this.scheme !== "xyz" && this.scheme !== "tms") {
      throw new Error("Tile proxy schemes must be xyz or tms.");
    }
    this.cacheKeyIgnoredSearchParameters = [
      ...new Set(
        options.cacheKeyIgnoredSearchParameters
          ?.map((parameter) => parameter.trim())
          .filter(Boolean) ?? [],
      ),
    ];
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
    this.defaultCacheTtlMs = nonNegativeInteger(
      options.defaultCacheTtlMs,
      DEFAULT_CACHE_TTL_MS,
    );
    this.upstreamBackoffMs = nonNegativeInteger(
      options.upstreamBackoffMs,
      DEFAULT_UPSTREAM_BACKOFF_MS,
    );
    this.throttle = new UpstreamThrottle(
      positiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
      nonNegativeInteger(
        options.minimumIntervalMs,
        DEFAULT_MINIMUM_INTERVAL_MS,
      ),
      this.now,
    );
  }

  async load(address: TileIdentity): Promise<TileProxyResult> {
    if (!validAddress(address)) {
      throw new Error("The tile proxy received an invalid XYZ address.");
    }
    const url = upstreamUrl(this.options.urlTemplate, this.scheme, address);
    const identity = cacheIdentity(
      url,
      this.cacheKeyIgnoredSearchParameters,
    );
    const cached = await this.readCached(identity);
    if (cached) return this.cachedResult(cached, "HIT");

    const active = this.inFlight.get(identity);
    if (active) {
      return { ...(await active), cacheStatus: "COALESCED" };
    }
    const request = this.loadUpstream(url, identity);
    this.inFlight.set(identity, request);
    try {
      return { ...(await request), cacheStatus: "MISS" };
    } finally {
      if (this.inFlight.get(identity) === request) this.inFlight.delete(identity);
    }
  }

  async delete(address: TileIdentity): Promise<boolean> {
    if (!validAddress(address)) return false;
    const url = upstreamUrl(this.options.urlTemplate, this.scheme, address);
    const identity = cacheIdentity(
      url,
      this.cacheKeyIgnoredSearchParameters,
    );
    const paths = cachePaths(this.options.cacheDirectory, identity);
    const deleted = await Promise.all([
      this.deleteFile(paths.body),
      this.deleteFile(paths.metadata),
    ]);
    return deleted.some(Boolean);
  }

  private async deleteFile(path: string): Promise<boolean> {
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async readCached(identity: string): Promise<CachedTile | undefined> {
    const paths = cachePaths(this.options.cacheDirectory, identity);
    try {
      const [metadataJson, body] = await Promise.all([
        readFile(paths.metadata, "utf8"),
        readFile(paths.body),
      ]);
      const metadata = JSON.parse(metadataJson) as CachedTileMetadata;
      if (
        metadata.version !== 1 ||
        !metadata.contentType.toLowerCase().startsWith("image/") ||
        metadata.expiresAtMs <= this.now() ||
        body.byteLength === 0
      ) return undefined;
      return { metadata, body };
    } catch {
      return undefined;
    }
  }

  private cachedResult(
    cached: CachedTile,
    cacheStatus: TileProxyCacheStatus,
  ): TileProxyResult {
    return {
      status: 200,
      statusText: "OK",
      contentType: cached.metadata.contentType,
      ...(cached.metadata.cacheControl
        ? { cacheControl: cached.metadata.cacheControl }
        : {}),
      ...(cached.metadata.etag ? { etag: cached.metadata.etag } : {}),
      ...(cached.metadata.lastModified
        ? { lastModified: cached.metadata.lastModified }
        : {}),
      body: cached.body,
      cacheStatus,
    };
  }

  private async loadUpstream(url: URL, identity: string): Promise<UpstreamTile> {
    const response = await this.throttle.schedule(() =>
      this.fetchImplementation(url, {
        headers: { Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      })
    );
    const body = Buffer.from(await response.arrayBuffer());
    const result = upstreamTile(response, body);
    if (response.status === 429 || response.status === 503) {
      this.throttle.pauseFor(
        Math.max(
          this.upstreamBackoffMs,
          retryAfterMilliseconds(result.retryAfter, this.now()),
        ),
      );
    }
    const lifetimeMs = cacheLifetimeMilliseconds(
      response.headers,
      this.now(),
      this.defaultCacheTtlMs,
    );
    if (
      response.ok &&
      body.byteLength > 0 &&
      result.contentType.toLowerCase().startsWith("image/") &&
      lifetimeMs > 0
    ) {
      await this.writeCached(identity, result, this.now() + lifetimeMs);
    }
    return result;
  }

  private async writeCached(
    identity: string,
    tile: UpstreamTile,
    expiresAtMs: number,
  ): Promise<void> {
    const paths = cachePaths(this.options.cacheDirectory, identity);
    const metadata: CachedTileMetadata = {
      version: 1,
      contentType: tile.contentType,
      ...(tile.cacheControl ? { cacheControl: tile.cacheControl } : {}),
      ...(tile.etag ? { etag: tile.etag } : {}),
      ...(tile.lastModified ? { lastModified: tile.lastModified } : {}),
      expiresAtMs,
    };
    const suffix = randomUUID();
    const temporaryBody = `${paths.body}.${suffix}.tmp`;
    const temporaryMetadata = `${paths.metadata}.${suffix}.tmp`;
    try {
      await mkdir(paths.directory, { recursive: true });
      await Promise.all([
        writeFile(temporaryBody, tile.body),
        writeFile(temporaryMetadata, JSON.stringify(metadata)),
      ]);
      await rename(temporaryBody, paths.body);
      await rename(temporaryMetadata, paths.metadata);
    } catch (error) {
      console.warn("Tile proxy cache write failed:", error);
    }
  }
}

interface ParsedTileRequest {
  readonly provider: string;
  readonly address: TileIdentity;
}

function parseTileRequest(pathname: string): ParsedTileRequest | undefined {
  if (!pathname.startsWith(`${TILE_PROXY_PATH}/`)) return undefined;
  const parts = pathname.slice(TILE_PROXY_PATH.length + 1).split("/");
  if (
    parts.length !== 4 ||
    !PROVIDER_ID.test(parts[0]!) ||
    parts.slice(1).some((part) => !/^\d+$/.test(part))
  ) return undefined;
  const address = {
    z: Number(parts[1]),
    x: Number(parts[2]),
    y: Number(parts[3]),
  };
  return validAddress(address) ? { provider: parts[0]!, address } : undefined;
}

function mergedProviderOptions(
  provider: TileProxyProviderOptions,
  defaults: TileProxyOptions,
): TileProxyProviderOptions {
  return {
    ...provider,
    cacheKeyIgnoredSearchParameters:
      provider.cacheKeyIgnoredSearchParameters ??
      defaults.cacheKeyIgnoredSearchParameters,
    maxConcurrency: provider.maxConcurrency ?? defaults.maxConcurrency,
    minimumIntervalMs:
      provider.minimumIntervalMs ?? defaults.minimumIntervalMs,
    defaultCacheTtlMs:
      provider.defaultCacheTtlMs ?? defaults.defaultCacheTtlMs,
    upstreamBackoffMs:
      provider.upstreamBackoffMs ?? defaults.upstreamBackoffMs,
  };
}

export function createTileProxyMiddleware(options: TileProxyOptions) {
  const services = new Map<string, TileProxyService>();
  for (const [provider, configuration] of Object.entries(options.providers)) {
    if (!PROVIDER_ID.test(provider)) {
      throw new Error(`Invalid tile proxy provider ID: ${provider}`);
    }
    services.set(
      provider,
      new TileProxyService({
        ...mergedProviderOptions(configuration, options),
        cacheDirectory: join(options.cacheDirectory, provider),
        fetchImplementation: options.fetchImplementation,
        now: options.now,
      }),
    );
  }

  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", "http://local");
    if (!requestUrl.pathname.startsWith(`${TILE_PROXY_PATH}/`)) {
      next();
      return;
    }
    if (request.method !== "GET" && request.method !== "DELETE") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, DELETE");
      response.end("Method not allowed.");
      return;
    }
    if (!isAllowedRequestOrigin(request.headers.origin, requestHost(request))) {
      response.statusCode = 403;
      response.end("Cross-origin requests are denied.");
      return;
    }
    const parsed = parseTileRequest(requestUrl.pathname);
    if (!parsed) {
      response.statusCode = 400;
      response.end("Invalid tile proxy path.");
      return;
    }
    const service = services.get(parsed.provider);
    if (!service) {
      response.statusCode = 404;
      response.end("Unknown tile provider.");
      return;
    }
    if (request.method === "DELETE") {
      try {
        const deleted = await service.delete(parsed.address);
        response.statusCode = deleted ? 204 : 404;
        response.setHeader("Cache-Control", "no-store");
        response.end();
      } catch (error) {
        console.error(
          `Tile proxy cache deletion failed for ${parsed.provider}:`,
          error,
        );
        response.statusCode = 500;
        response.setHeader("Cache-Control", "no-store");
        response.end("Tile cache deletion failed.");
      }
      return;
    }
    try {
      const tile = await service.load(parsed.address);
      if (response.destroyed) return;
      response.statusCode = tile.status;
      response.statusMessage = tile.statusText;
      response.setHeader("Content-Type", tile.contentType);
      response.setHeader("Content-Length", tile.body.byteLength);
      response.setHeader("X-Pas-De-Geant-Tile-Cache", tile.cacheStatus);
      response.setHeader("X-Pas-De-Geant-Tile-Provider", parsed.provider);
      // The proxy owns persistence and invalidation. Browser caching would
      // hide provider switches behind the stable canonical client URL.
      response.setHeader("Cache-Control", "no-store");
      if (tile.etag) response.setHeader("ETag", tile.etag);
      if (tile.lastModified) {
        response.setHeader("Last-Modified", tile.lastModified);
      }
      if (tile.retryAfter) {
        response.setHeader("Retry-After", tile.retryAfter);
      }
      response.end(tile.body);
    } catch (error) {
      console.error(
        `Tile proxy request failed for ${parsed.provider}:`,
        error,
      );
      if (response.destroyed) return;
      response.statusCode = 502;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end("Tile imagery is unavailable.");
    }
  };
}
