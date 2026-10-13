import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiRequestHandler } from "../apps/pas-de-geant/src/api-server.js";
import { createLocalTileServer } from "../apps/pas-de-geant/src/local-tile-server.js";

const servers: Server[] = [];
const directories: string[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener.");
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

describe("development-only disk tile server", () => {
  it("serves descriptors and declared assets directly, never evidence or symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdg-tiles-"));
    directories.push(root);
    await mkdir(join(root, "imagery", "1", "0"), { recursive: true });
    await writeFile(join(root, "product.json"), JSON.stringify({ tiles: { path_template: "imagery/{z}/{x}/{y}.png" }, baseTexture: { path: "base.png" } }));
    await writeFile(join(root, "base.png"), "base image");
    await writeFile(join(root, "imagery", "1", "0", "1.png"), "tile image");
    await writeFile(join(root, "run.json"), "private evidence");
    await symlink(join(root, "run.json"), join(root, "imagery", "1", "0", "2.png"));
    const middleware = await createLocalTileServer({ moon: { root, tilePathTemplate: "imagery/{z}/{x}/{y}.png" } });
    const origin = await listen(createServer((request, response) => middleware(request, response, () => response.writeHead(404).end())));
    expect(await (await fetch(`${origin}/_local-tiles/moon/product.json`)).json()).toHaveProperty("tiles");
    expect(await (await fetch(`${origin}/_local-tiles/moon/base.png`)).text()).toBe("base image");
    expect(await (await fetch(`${origin}/_local-tiles/moon/imagery/1/0/1.png`)).text()).toBe("tile image");
    expect((await fetch(`${origin}/_local-tiles/moon/run.json`)).status).toBe(404);
    expect((await fetch(`${origin}/_local-tiles/moon/imagery/1/0/2.png`)).status).toBe(404);
    expect((await fetch(`${origin}/_local-tiles/moon/%2e%2e/run.json`)).status).toBe(404);
    expect((await fetch(`${origin}/_local-tiles/moon/product.json`, { method: "POST" })).status).toBe(405);
  });

  it("leaves application APIs free of session-config and tile routes", async () => {
    const origin = await listen(createServer(createApiRequestHandler({})));
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect((await fetch(`${origin}/api/config`)).status).toBe(404);
    expect((await fetch(`${origin}/api/tiles/textures/0/0/0`)).status).toBe(404);
    expect((await fetch(`${origin}/lunar-preview/runtime/product.json`)).status).toBe(404);
    expect((await fetch(`${origin}/api/realtime/token`, { method: "POST" })).status).toBe(503);
  });

  it("serves only tiles listed by a prepared sparse product", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdg-sparse-"));
    directories.push(root);
    await mkdir(join(root, "landing", "3", "4"), { recursive: true });
    await writeFile(join(root, "product.json"), JSON.stringify({
      kind: "sparse-opaque-xyz", sources: [{
        pathTemplate: "landing/{z}/{x}/{y}.png",
        levels: [{ zoom: 3, tiles: [[4, 3]] }],
      }],
    }));
    await writeFile(join(root, "landing", "3", "4", "3.png"), "declared");
    await writeFile(join(root, "landing", "3", "4", "4.png"), "undeclared");
    const middleware = await createLocalTileServer({ apollo: { root, tilePathTemplate: "{source}/{z}/{x}/{y}.png" } });
    const origin = await listen(createServer((request, response) => middleware(request, response, () => response.writeHead(404).end())));
    expect(await (await fetch(`${origin}/_local-tiles/apollo/landing/3/4/3.png`)).text()).toBe("declared");
    expect((await fetch(`${origin}/_local-tiles/apollo/landing/3/4/4.png`)).status).toBe(404);
  });
});
