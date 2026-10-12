import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export interface TileCacheProvider {
  readonly name: string;
  readonly id?: string;
  readonly attribution?: string;
  readonly tileSize?: number;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

const FORWARDED_HEADERS = ["accept", "origin", "referer", "user-agent"];
const RESPONSE_HEADERS = ["content-type", "content-length", "cache-control", "etag",
  "last-modified", "retry-after", "x-tile-cache", "x-tile-cache-provider", "x-tile-cache-fallback",
  "x-pas-de-geant-tile-cache", "x-pas-de-geant-tile-provider", "x-pas-de-geant-tile-fallback"];

function cacheEndpoint(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("The tile cache endpoint must be an HTTP(S) service URL without credentials.");
  }
  return url;
}

function unavailable(response: ServerResponse): void {
  response.statusCode = 503;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Retry-After", "5");
  response.end("The development tile cache is unavailable. Direct upstream fallback is disabled.");
}

export function createTileCacheForwarder(endpoint: string | undefined) {
  const base = endpoint ? cacheEndpoint(endpoint) : undefined;
  return async (request: IncomingMessage, response: ServerResponse, next: () => void): Promise<void> => {
    const path = new URL(request.url || "/", "http://local");
    if (!path.pathname.startsWith("/api/tiles/")) { next(); return; }
    if (!/^\/api\/tiles\/[a-z0-9][a-z0-9_-]*\/\d+\/\d+\/\d+$/.test(path.pathname)) {
      response.writeHead(400, { "Cache-Control": "no-store" }).end("Invalid tile path.");
      return;
    }
    if (request.method !== "GET" && request.method !== "DELETE") {
      response.writeHead(405, { Allow: "GET, DELETE", "Cache-Control": "no-store" }).end();
      return;
    }
    if (!base) { unavailable(response); return; }
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name];
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    try {
      const upstream = await fetch(new URL(`${path.pathname}${path.search}`, base), {
        method: request.method, headers, signal: AbortSignal.timeout(10_000),
      });
      if (response.destroyed) return;
      response.statusCode = upstream.status;
      for (const name of RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      if (!upstream.body) { response.end(); return; }
      const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
      stream.once("error", () => response.destroy());
      response.once("close", () => stream.destroy());
      stream.pipe(response);
    } catch {
      // Never include a private endpoint or upstream URL in a browser error.
      if (!response.headersSent && !response.destroyed) unavailable(response);
      else response.destroy();
    }
  };
}

export async function readTileCachePublicEnvironment(endpoint: string): Promise<Record<string, string | number | boolean>> {
  const response = await fetch(new URL("/api/providers", cacheEndpoint(endpoint)), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Tile cache metadata is unavailable; direct upstream fallback is disabled.");
  const manifest = await response.json() as { formatVersion: number; providers: TileCacheProvider[] };
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.providers)) throw new Error("Unsupported tile cache metadata.");
  const provider = manifest.providers.find(item => item.name === "textures-source") ??
    manifest.providers.find(item => item.name === "textures");
  if (!provider) return { PAS_DE_GEANT_IMAGERY_CONFIGURED: false };
  return {
    PAS_DE_GEANT_IMAGERY_CONFIGURED: true,
    VITE_IMAGERY_XYZ_TEMPLATE: `/api/tiles/${provider.name}/{z}/{x}/{y}`,
    VITE_IMAGERY_PROVIDER_ID: provider.id || provider.name,
    VITE_IMAGERY_ATTRIBUTION: provider.attribution || "Configured imagery",
    VITE_IMAGERY_TILE_SIZE: provider.tileSize ?? 256,
    VITE_IMAGERY_MIN_ZOOM: provider.minZoom ?? 0,
    VITE_IMAGERY_MAX_ZOOM: provider.maxZoom ?? 22,
  };
}
