import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiRequestHandler } from "../apps/pas-de-geant/src/api-server.js";

const servers: Server[] = [];
const directories: string[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener.");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

describe("standalone application APIs", () => {
  it("serves the sparse preview while keeping other files in its directory private", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdg-preview-"));
    directories.push(directory);
    await mkdir(join(directory, "imagery", "11", "1157"), { recursive: true });
    await writeFile(join(directory, "product.json"), JSON.stringify({ kind: "sparse-detail-preview" }));
    await writeFile(join(directory, "imagery", "11", "1157", "1016.png"), "preview image");
    await writeFile(join(directory, "private.txt"), "private build information");
    await mkdir(join(directory, "runtime", "landing", "15", "18520"), { recursive: true });
    await writeFile(join(directory, "runtime", "product.json"), JSON.stringify({ kind: "sparse-opaque-xyz" }));
    await writeFile(join(directory, "runtime", "landing", "15", "18520", "16261.png"), "prepared tile");
    await writeFile(join(directory, "runtime", "private.txt"), "private source evidence");
    const api = await listen(createServer(createApiRequestHandler({ PAS_DE_GEANT_LUNAR_PREVIEW_DIRECTORY: directory })));
    expect(await (await fetch(`${api}/lunar-preview/product.json`)).json()).toEqual({ kind: "sparse-detail-preview" });
    expect(await (await fetch(`${api}/lunar-preview/imagery/11/1157/1016.png`)).text()).toBe("preview image");
    expect((await fetch(`${api}/lunar-preview/private.txt`)).status).toBe(404);
    expect(await (await fetch(`${api}/lunar-preview/runtime/product.json`)).json()).toEqual({ kind: "sparse-opaque-xyz" });
    const prepared = await fetch(`${api}/lunar-preview/runtime/landing/15/18520/16261.png`);
    expect(prepared.headers.get("Content-Type")).toBe("image/png");
    expect(await prepared.text()).toBe("prepared tile");
    expect((await fetch(`${api}/lunar-preview/runtime/private.txt`)).status).toBe(404);
    expect((await fetch(`${api}/lunar-preview/product.json`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${api}/lunar-preview/product.json`, { method: "HEAD" })).headers.get("Content-Type")).toBe("application/json");
  });

  it("forwards tiles to the independent cache and exposes public provider metadata", async () => {
    let tileRequests = 0;
    const cache = await listen(createServer((request, response) => {
      if (request.url === "/api/providers") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ formatVersion: 1, providers: [{ name: "textures", id: "example", attribution: "Provider attribution", tileSize: 256 }] }));
      } else {
        tileRequests++;
        response.writeHead(200, { "Content-Type": "image/png", "X-Tile-Cache": "HIT", "Cache-Control": "public, max-age=31536000, immutable" });
        response.end(Buffer.from("cached image"));
      }
    }));
    const api = await listen(createServer(createApiRequestHandler({
      OPENAI_API_KEY: "private-ai-key", PAS_DE_GEANT_TILE_CACHE_URL: cache,
      PAS_DE_GEANT_TILE_PROXY_TEXTURES_UPSTREAM_TEMPLATE: "https://api.maptiler.com/{z}/{x}/{y}?key=private-tile-key",
    })));
    const config = await (await fetch(`${api}/api/config`)).text();
    expect(config).toContain("Provider attribution");
    expect(JSON.parse(config).PAS_DE_GEANT_IMAGERY_CONFIGURED).toBe(true);
    expect(config).not.toContain("private-ai-key");
    expect(config).not.toContain("private-tile-key");
    expect(config).not.toContain(cache);
    const tile = `${api}/api/tiles/textures/0/0/0`;
    const response = await fetch(tile);
    expect(response.headers.get("X-Tile-Cache")).toBe("HIT");
    expect(await response.text()).toBe("cached image");
    await fetch(tile);
    expect(tileRequests).toBe(2);
    expect((await fetch(tile, { headers: { Origin: "https://untrusted.example" } })).status).toBe(403);
    expect((await fetch(`${api}/src/main.ts`)).status).toBe(404);
    expect((await fetch(`${api}/`)).status).toBe(404);
  });

  it("fails without bypassing an unavailable cache for the legacy upstream", async () => {
    let directRequests = 0;
    const upstream = await listen(createServer((_request, response) => { directRequests++; response.end("unexpected direct access"); }));
    const offlineCacheServer = createServer();
    const offlineCacheUrl = await listen(offlineCacheServer);
    await new Promise<void>(resolve => offlineCacheServer.close(() => resolve()));
    for (const cacheUrl of [undefined, offlineCacheUrl]) {
      const api = await listen(createServer(createApiRequestHandler({
        PAS_DE_GEANT_TILE_CACHE_URL: cacheUrl,
        PAS_DE_GEANT_TILE_PROXY_TEXTURES_UPSTREAM_TEMPLATE: `${upstream}/{z}/{x}/{y}.png`,
      })));
      const response = await fetch(`${api}/api/tiles/textures/0/0/0`);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toContain("Direct upstream fallback is disabled");
      expect(directRequests).toBe(0);
    }
  });

  it("keeps an explicit production source and its metadata independent of cache availability", async () => {
    const api = await listen(createServer(createApiRequestHandler({
      PAS_DE_GEANT_TILE_CACHE_URL: "http://127.0.0.1:1",
      VITE_IMAGERY_XYZ_TEMPLATE: "https://imagery.example/{z}/{x}/{y}.jpg",
      VITE_IMAGERY_PROVIDER_ID: "production-source",
      VITE_IMAGERY_ATTRIBUTION: "Production attribution",
      VITE_IMAGERY_TILE_SIZE: "512",
    })));
    const response = await fetch(`${api}/api/config`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      PAS_DE_GEANT_IMAGERY_CONFIGURED: true,
      VITE_IMAGERY_XYZ_TEMPLATE: "https://imagery.example/{z}/{x}/{y}.jpg",
      VITE_IMAGERY_PROVIDER_ID: "production-source",
      VITE_IMAGERY_ATTRIBUTION: "Production attribution",
      VITE_IMAGERY_TILE_SIZE: "512",
    });
  });

  it("serves lunar pyramids independently of the development server and handles missing voice configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdg-lunar-"));
    directories.push(directory);
    await mkdir(join(directory, "0", "0"), { recursive: true });
    await writeFile(join(directory, "0", "0", "0.png"), Buffer.from("lunar image"));
    const api = await listen(createServer(createApiRequestHandler({
      PAS_DE_GEANT_LUNAR_IMAGERY_DIRECTORY: directory,
      PAS_DE_GEANT_TILE_PROXY_CACHE_DIRECTORY: join(directory, "cache"),
    })));
    const tile = await fetch(`${api}/api/tiles/lunar-imagery/0/0/0`);
    expect(tile.status).toBe(200);
    expect(await tile.text()).toBe("lunar image");
    expect((await fetch(`${api}/api/realtime/token`, { method: "POST" })).status).toBe(503);
    expect((await fetch(`${api}/api/realtime/token`, {
      method: "POST", headers: { Origin: "https://untrusted.example" },
    })).status).toBe(403);
  });

  it("serves admitted product metadata and independent runtime tiles without exposing build evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdg-grid-"));
    directories.push(root);
    const imagery = join(root, "global", "imagery"), runtime = join(root, "mercator-runtime"), study = join(root, "study");
    await mkdir(join(imagery, "0", "0"), { recursive: true });
    await mkdir(join(runtime, "context", "1", "0"), { recursive: true });
    await mkdir(study);
    await writeFile(join(root, "global", "product.json"), '{"grid":"global"}');
    await writeFile(join(root, "global", "base.png"), "polar base");
    await writeFile(join(root, "global", "run.json"), "private evidence");
    await writeFile(join(runtime, "product.json"), '{"grid":"mercator"}');
    await writeFile(join(runtime, "context", "1", "0", "0.png"), "runtime tile");
    await writeFile(join(study, "product.json"), '{"grid":"geographic"}');
    const api = await listen(createServer(createApiRequestHandler({
      PAS_DE_GEANT_LUNAR_IMAGERY_DIRECTORY: imagery,
      PAS_DE_GEANT_LUNAR_PREVIEW_DIRECTORY: study,
      PAS_DE_GEANT_LUNAR_RUNTIME_DIRECTORY: runtime,
    })));
    expect(await (await fetch(`${api}/api/tiles/lunar-imagery/product.json`)).json()).toEqual({ grid: "global" });
    expect(await (await fetch(`${api}/api/tiles/lunar-imagery/base.png`)).text()).toBe("polar base");
    expect((await fetch(`${api}/api/tiles/lunar-imagery/run.json`)).status).toBe(400);
    expect(await (await fetch(`${api}/lunar-preview/product.json`)).json()).toEqual({ grid: "geographic" });
    expect(await (await fetch(`${api}/lunar-preview/runtime/product.json`)).json()).toEqual({ grid: "mercator" });
    expect(await (await fetch(`${api}/lunar-preview/runtime/context/1/0/0.png`)).text()).toBe("runtime tile");
    expect((await fetch(`${api}/lunar-preview/runtime/../run.json`)).status).toBe(404);
  });
});
