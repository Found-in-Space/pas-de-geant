import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { tileUrl } from "@found-in-space/worlds/tile-url";
import { compileDevelopmentSession } from "../apps/pas-de-geant/src/development-session-config.js";
import { imageryConfiguration } from "../apps/pas-de-geant/src/imagery-configuration.js";
import { selectImageryVariant } from "../apps/pas-de-geant/src/imagery-variants.js";
import { descriptorTileTemplate, parseSessionConfiguration, resolveSessionUrls, sessionConfigurationUrl } from "../apps/pas-de-geant/src/session-config.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

describe("session tile providers", () => {
  it("packages the same versioned format used by development", async () => {
    const staticConfig = parseSessionConfiguration(JSON.parse(await readFile(
      new URL("../apps/pas-de-geant/public/session-config.json", import.meta.url), "utf8",
    )));
    expect(staticConfig.bindings.moonImagery).toBe("moon-global");
    expect(staticConfig.providers["moon-global"]?.productUrl).toContain("product.json");
    const development = compileDevelopmentSession({ PAS_DE_GEANT_TILE_CACHE_URL: "https://cache.example" }, "/workspace/app");
    expect(parseSessionConfiguration(development.config)).toEqual(development.config);
    expect(development.config.providers["earth-elevation"]?.urlTemplate)
      .toBe("https://cache.example/api/tiles/elevation/{z}/{x}/{y}");
  });

  it("loads from the application base for nested pages and preserves template queries", () => {
    expect(sessionConfigurationUrl("https://example.test/project/assets/main.js"))
      .toBe("https://example.test/project/session-config.json");
    expect(sessionConfigurationUrl("https://example.test/src/session-config.ts"))
      .toBe("https://example.test/session-config.json");
    const config = compileDevelopmentSession({ PAS_DE_GEANT_TILE_CACHE_URL: "https://cache.example" }, "/workspace/app", {
      providers: {
        "earth-elevation": {
          urlTemplate: "https://tiles.example/terrain/{z}/{x}/{y}.png?style=relief&token=public",
          addressing: "tms",
        },
      },
    }).config;
    const resolved = resolveSessionUrls(config, "https://example.test/project/session-config.json");
    expect(tileUrl(resolved.providers["earth-elevation"]!.urlTemplate, "tms", { z: 3, x: 4, y: 2 }))
      .toBe("https://tiles.example/terrain/3/4/5.png?style=relief&token=public");
    expect(tileUrl("/tiles/{z}/{x}/{y}.png?style=raw", "xyz", { z: 3, x: 4, y: 2 }))
      .toBe("/tiles/3/4/2.png?style=raw");
    expect(descriptorTileTemplate("context/{z}/{x}/{y}.png", "https://example.test/runtime/product.json"))
      .toBe("https://example.test/runtime/context/{z}/{x}/{y}.png");
  });

  it("keeps variants and provider overrides independent", () => {
    const { config } = compileDevelopmentSession({ PAS_DE_GEANT_TILE_CACHE_URL: "https://cache.example" }, "/workspace/app", {
      providers: {
        "earth-imagery-512": {
          urlTemplate: "https://cdn.example/raw/{z}/{x}/{y}.jpg?style=large",
          attribution: "Hosted imagery",
        },
      },
    });
    expect(selectImageryVariant(config, null)).toBe("earth-imagery-256");
    expect(selectImageryVariant(config, "maptiler-512")).toBe("earth-imagery-512");
    expect(imageryConfiguration(config, "maptiler-512")?.urlTemplate)
      .toBe("https://cdn.example/raw/{z}/{x}/{y}.jpg?style=large");
    expect(imageryConfiguration(config)?.urlTemplate)
      .toBe("https://cache.example/api/tiles/textures/{z}/{x}/{y}");
  });

  it("requests a selected cache directly and reports its failure without an upstream fallback", async () => {
    let hits = 0;
    const cache = createServer((_request, response) => { hits++; response.writeHead(503).end("cache unavailable"); });
    servers.push(cache);
    await new Promise<void>(resolve => cache.listen(0, "127.0.0.1", resolve));
    const address = cache.address();
    if (!address || typeof address === "string") throw new Error("Expected listener");
    const { config } = compileDevelopmentSession({ PAS_DE_GEANT_TILE_CACHE_URL: `http://127.0.0.1:${address.port}` }, "/workspace/app");
    const url = tileUrl(config.providers["earth-imagery-256"]!.urlTemplate, "xyz", { z: 0, x: 0, y: 0 });
    expect((await fetch(url)).status).toBe(503);
    expect(hits).toBe(1);
  });
});
