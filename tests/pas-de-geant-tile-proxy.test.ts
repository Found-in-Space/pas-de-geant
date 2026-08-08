import { mkdtemp, rm } from "node:fs/promises";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  proxiedTileConfiguration,
} from "../apps/pas-de-geant/src/tile-proxy.js";
import {
  createTileProxyMiddleware,
  TileProxyService,
} from "../apps/pas-de-geant/src/tile-proxy-server.js";

const temporaryDirectories: string[] = [];

async function cacheDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pas-de-geant-tiles-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

function request(
  url: string,
  method = "GET",
  headers: IncomingHttpHeaders = {},
): IncomingMessage {
  return {
    url,
    method,
    headers: {
      host: "local.test",
      origin: "http://local.test",
      ...headers,
    },
  } as IncomingMessage;
}

function responseRecorder() {
  const headers = new Map<string, string>();
  let status = 200;
  let body = Buffer.alloc(0);
  const response = {
    destroyed: false,
    get statusCode() {
      return status;
    },
    set statusCode(value: number) {
      status = value;
    },
    statusMessage: "",
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    end(value?: string | Uint8Array) {
      body = typeof value === "string"
        ? Buffer.from(value)
        : Buffer.from(value ?? []);
      return this;
    },
  } as unknown as ServerResponse;
  return { response, headers, status: () => status, body: () => body };
}

describe("development tile proxy", () => {
  it("rewrites configured imagery to a canonical provider route", () => {
    const configuration = {
      id: "generic-satellite",
      urlTemplate:
        "https://tiles.example.test/satellite/256/{z}/{x}/{y}.jpg?token=test",
      attribution: "Example imagery",
    };
    expect(
      proxiedTileConfiguration(configuration, true, "textures").urlTemplate,
    ).toBe(
      "/api/tiles/textures/{z}/{x}/{y}",
    );
    expect(proxiedTileConfiguration(configuration, false, "textures")).toBe(
      configuration,
    );
    expect(() =>
      proxiedTileConfiguration(configuration, true, "../other")
    ).toThrow("provider IDs");
  });

  it("coalesces duplicate misses and reuses the disk cache after restart", async () => {
    const directory = await cacheDirectory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImplementation = vi.fn<typeof fetch>(async () => {
      await gate;
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": "image/jpeg",
        },
      });
    });
    const service = new TileProxyService({
      cacheDirectory: directory,
      urlTemplate:
        "https://tiles.example.test/satellite/256/{z}/{x}/{y}.jpg?token=first",
      cacheKeyIgnoredSearchParameters: ["token"],
      fetchImplementation,
      minimumIntervalMs: 0,
    });
    const tile = { z: 6, x: 32, y: 20 };
    const first = service.load(tile);
    const duplicate = service.load(tile);
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
    release();

    expect((await first).cacheStatus).toBe("MISS");
    expect((await duplicate).cacheStatus).toBe("COALESCED");
    expect(fetchImplementation).toHaveBeenCalledOnce();

    const restarted = new TileProxyService({
      cacheDirectory: directory,
      urlTemplate:
        "https://tiles.example.test/satellite/256/{z}/{x}/{y}.jpg?token=second",
      cacheKeyIgnoredSearchParameters: ["token"],
      fetchImplementation: vi.fn(async () => {
        throw new Error("disk hit should not reach upstream");
      }),
      minimumIntervalMs: 0,
    });
    const cached = await restarted.load(tile);
    expect(cached.cacheStatus).toBe("HIT");
    expect([...cached.body]).toEqual([1, 2, 3]);
  });

  it("does not exceed the configured upstream concurrency", async () => {
    const directory = await cacheDirectory();
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const service = new TileProxyService({
      cacheDirectory: directory,
      urlTemplate:
        "https://tiles.example.test/satellite/{z}/{x}/{y}.jpg",
      maxConcurrency: 2,
      minimumIntervalMs: 0,
      fetchImplementation: vi.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return new Response(new Uint8Array([1]), {
          headers: {
            "cache-control": "no-store",
            "content-type": "image/jpeg",
          },
        });
      }),
    });
    const loads = [1, 2, 3].map((x) => service.load({ z: 2, x, y: 1 }));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(peak).toBe(2);
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const release of releases) release();
    await Promise.all(loads);
    expect(peak).toBe(2);
  });

  it("adapts canonical XYZ addresses to provider templates and TMS y", async () => {
    let requestedUrl = "";
    const service = new TileProxyService({
      cacheDirectory: await cacheDirectory(),
      urlTemplate:
        "https://terrain.example.test/layer/{x}/{z}/{y}.webp?format=terrarium",
      scheme: "tms",
      fetchImplementation: vi.fn(async (input) => {
        requestedUrl = String(input);
        return new Response(new Uint8Array([1]), {
          headers: {
            "cache-control": "no-store",
            "content-type": "image/webp",
          },
        });
      }),
    });

    await service.load({ z: 3, x: 4, y: 2 });
    expect(requestedUrl).toBe(
      "https://terrain.example.test/layer/4/3/5.webp?format=terrarium",
    );
  });

  it("forwards selected client headers and applies configured upstream headers", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("origin")).toBe("https://configured.example.test");
      expect(headers.get("referer")).toBe("http://local.test/globe");
      expect(headers.get("user-agent")).toBe("Example Headset/1.0");
      expect(headers.get("x-provider-token")).toBe("configured-token");
      expect(headers.has("cookie")).toBe(false);
      return new Response(new Uint8Array([1]), {
        headers: {
          "cache-control": "no-store",
          "content-type": "image/jpeg",
        },
      });
    });
    const middleware = createTileProxyMiddleware({
      cacheDirectory: await cacheDirectory(),
      minimumIntervalMs: 0,
      fetchImplementation,
      providers: {
        textures: {
          urlTemplate: "https://textures.example.test/{z}/{x}/{y}.jpg",
          upstreamHeaders: {
            origin: "https://configured.example.test",
            "x-provider-token": "configured-token",
          },
          forwardRequestHeaders: ["origin", "referer", "user-agent"],
        },
      },
    });
    const recorded = responseRecorder();

    await middleware(
      request("/api/tiles/textures/3/4/2", "GET", {
        referer: "http://local.test/globe",
        "user-agent": "Example Headset/1.0",
        cookie: "session=not-forwarded",
      }),
      recorded.response,
      () => undefined,
    );

    expect(recorded.status()).toBe(200);
    expect(recorded.headers.get("cache-control")).toBe("no-store");
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("uses the fallback lifetime for device caching when upstream omits one", async () => {
    const middleware = createTileProxyMiddleware({
      cacheDirectory: await cacheDirectory(),
      defaultCacheTtlMs: 120_000,
      minimumIntervalMs: 0,
      fetchImplementation: vi.fn(async () =>
        new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/jpeg" },
        })
      ),
      providers: {
        textures: {
          urlTemplate: "https://textures.example.test/{z}/{x}/{y}.jpg",
        },
      },
    });
    const recorded = responseRecorder();

    await middleware(
      request("/api/tiles/textures/3/4/2"),
      recorded.response,
      () => undefined,
    );

    expect(recorded.status()).toBe(200);
    expect(recorded.headers.get("cache-control")).toBe(
      "public, max-age=120",
    );
  });

  it("selects providers with independent persistent cache namespaces", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const elevation = String(input).startsWith(
        "https://elevation.example.test",
      );
      return new Response(new Uint8Array([elevation ? 2 : 1]), {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": elevation ? "image/webp" : "image/jpeg",
        },
      });
    });
    const middleware = createTileProxyMiddleware({
      cacheDirectory: await cacheDirectory(),
      minimumIntervalMs: 0,
      fetchImplementation,
      providers: {
        textures: {
          urlTemplate:
            "https://textures.example.test/{z}/{x}/{y}.jpg",
        },
        elevation: {
          urlTemplate:
            "https://elevation.example.test/{z}/{x}/{y}.webp",
        },
      },
    });

    for (const provider of ["textures", "elevation"] as const) {
      const first = responseRecorder();
      await middleware(
        request(`/api/tiles/${provider}/3/4/2`),
        first.response,
        () => undefined,
      );
      expect(first.status()).toBe(200);
      expect(first.headers.get("x-pas-de-geant-tile-provider")).toBe(provider);
      expect(first.headers.get("x-pas-de-geant-tile-cache")).toBe("MISS");
      expect(first.headers.get("cache-control")).toBe(
        "public, max-age=3600",
      );
      expect([...first.body()]).toEqual([provider === "elevation" ? 2 : 1]);

      const revisited = responseRecorder();
      await middleware(
        request(`/api/tiles/${provider}/3/4/2`),
        revisited.response,
        () => undefined,
      );
      expect(revisited.headers.get("x-pas-de-geant-tile-cache")).toBe("HIT");
      expect(revisited.headers.get("cache-control")).toBe(
        "public, max-age=3600",
      );
    }
    expect(fetchImplementation).toHaveBeenCalledTimes(2);

    const deleted = responseRecorder();
    await middleware(
      request("/api/tiles/elevation/3/4/2", "DELETE"),
      deleted.response,
      () => undefined,
    );
    expect(deleted.status()).toBe(204);
    const afterDeletion = responseRecorder();
    await middleware(
      request("/api/tiles/elevation/3/4/2"),
      afterDeletion.response,
      () => undefined,
    );
    expect(afterDeletion.headers.get("x-pas-de-geant-tile-cache")).toBe(
      "MISS",
    );
    expect(fetchImplementation).toHaveBeenCalledTimes(3);

    const unknown = responseRecorder();
    await middleware(
      request("/api/tiles/unknown/3/4/2"),
      unknown.response,
      () => undefined,
    );
    expect(unknown.status()).toBe(404);
  });
});
