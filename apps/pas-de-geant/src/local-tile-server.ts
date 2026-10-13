import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";

export interface LocalTileProduct {
  readonly root: string;
  readonly tilePathTemplate: string;
}

interface ServedProduct {
  readonly root: string;
  readonly assets: readonly RegExp[];
  readonly exact: ReadonlySet<string>;
}

function safeRelativePath(path: string): boolean {
  return !isAbsolute(path) && !path.startsWith("/") &&
    path.split("/").every(part => part !== "" && part !== "." && part !== ".." && /^[a-zA-Z0-9_.{}-]+$/.test(part));
}

function tilePattern(path: string): RegExp {
  if (!safeRelativePath(path) || !["{z}", "{x}", "{y}"].every(token => path.includes(token))) {
    throw new Error("A local product has an invalid tile path template.");
  }
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("\\{z\\}", "\\d+")
    .replaceAll("\\{x\\}", "\\d+")
    .replaceAll("\\{y\\}", "\\d+");
  return new RegExp(`^${escaped}$`);
}

function descriptorPaths(descriptor: Record<string, unknown>, configured: string): { assets: RegExp[]; exact: Set<string> } {
  const exact = new Set(["product.json"]);
  const base = descriptor.baseTexture as { path?: unknown } | undefined;
  if (typeof base?.path === "string" && safeRelativePath(base.path) && /\.(?:png|jpe?g|webp)$/.test(base.path)) exact.add(base.path);
  const templates = new Set<string>();
  const tiles = descriptor.tiles as { path_template?: unknown } | undefined;
  if (typeof tiles?.path_template === "string") templates.add(tiles.path_template);
  const sources = descriptor.sources;
  if (Array.isArray(sources)) {
    for (const source of sources) {
      if (source && typeof source === "object" && typeof source.pathTemplate === "string") {
        if (Array.isArray(source.levels)) {
          for (const level of source.levels) {
            if (!level || !Number.isSafeInteger(level.zoom) || !Array.isArray(level.tiles)) continue;
            for (const tile of level.tiles) {
              if (!Array.isArray(tile) || tile.length !== 2 || !tile.every(Number.isSafeInteger)) continue;
              const path = source.pathTemplate.replaceAll("{z}", String(level.zoom))
                .replaceAll("{x}", String(tile[0])).replaceAll("{y}", String(tile[1]));
              if (safeRelativePath(path)) exact.add(path);
            }
          }
        } else {
          templates.add(source.pathTemplate);
        }
      }
    }
  }
  if (templates.size === 0 && !Array.isArray(sources)) templates.add(configured);
  return { exact, assets: [...templates].filter(path => !path.includes("{source}")).map(tilePattern) };
}

/** Disk-only tile service for Vite development. Product evidence is outside its allowlist. */
export async function createLocalTileServer(products: Readonly<Record<string, LocalTileProduct>>) {
  const served: Record<string, ServedProduct> = {};
  for (const [id, product] of Object.entries(products)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`Invalid local product ID: ${id}`);
    const root = await realpath(product.root);
    const descriptor = JSON.parse(await readFile(resolve(root, "product.json"), "utf8")) as Record<string, unknown>;
    if (!descriptor || typeof descriptor !== "object") throw new Error(`Invalid local product descriptor: ${id}`);
    served[id] = { root, ...descriptorPaths(descriptor, product.tilePathTemplate) };
  }
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const rawPath = (request.url ?? "").split("?", 1)[0]!;
    if (!rawPath.startsWith("/_local-tiles/")) { next(); return; }
    // Reject encoded separators and dot segments before URL path normalization.
    if (/%2f|%5c|%2e|%00/i.test(rawPath)) { response.writeHead(404).end(); return; }
    const match = /^\/_local-tiles\/([a-z0-9][a-z0-9_-]*)\/(.+)$/.exec(rawPath);
    const product = match ? served[match[1]!] : undefined;
    const asset = match?.[2];
    if (!product || !asset || !safeRelativePath(asset) ||
        (!product.exact.has(asset) && !product.assets.some(pattern => pattern.test(asset)))) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    void (async () => {
      try {
        const requestedPath = resolve(product.root, asset);
        const path = await realpath(requestedPath);
        if (path !== requestedPath) throw new Error("Symbolic links are not served");
        const within = relative(product.root, path);
        if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Outside product root");
        const info = await stat(path);
        if (!info.isFile()) throw new Error("Not a file");
        response.setHeader("Content-Type", asset.endsWith(".json") ? "application/json; charset=utf-8" :
          asset.endsWith(".webp") ? "image/webp" : asset.endsWith(".jpg") || asset.endsWith(".jpeg") ? "image/jpeg" : "image/png");
        response.setHeader("Content-Length", info.size);
        response.setHeader("Cache-Control", "no-cache");
        if (request.method === "HEAD") { response.end(); return; }
        const stream = createReadStream(path);
        response.once("close", () => stream.destroy());
        stream.once("error", () => response.destroy());
        stream.pipe(response);
      } catch {
        if (!response.headersSent) response.writeHead(404).end();
      }
    })();
  };
}
