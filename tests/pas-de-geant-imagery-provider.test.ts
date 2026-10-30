import { describe, expect, it, vi } from "vitest";
import {
  ImageryRequestError,
  MAPTILER_IMAGERY_CACHE_NAME,
  type ImageryCacheStorage,
  type ImageryResponseCache,
  XyzImageryProvider,
} from "../packages/pas-de-geant/src/worlds/imagery-provider.js";

class MemoryResponseCache implements ImageryResponseCache {
  readonly responses = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.responses.get(String(request))?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.responses.set(String(request), response.clone());
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.responses.delete(String(request));
  }
}

const configuration = {
  id: "maptiler-satellite-v4-256",
  urlTemplate:
    "https://api.maptiler.com/maps/satellite-v4/256/{z}/{x}/{y}.jpg?key=test-key",
  attribution: "MapTiler",
  tileSize: 256,
  minZoom: 0,
  maxZoom: 22,
};

function cacheStorage(cache: MemoryResponseCache): ImageryCacheStorage {
  return {
    open: vi.fn(async (name: string) => {
      expect(name).toBe(MAPTILER_IMAGERY_CACHE_NAME);
      return cache;
    }),
  };
}

describe("XYZ imagery provider cache", () => {
  it("retains proxied imagery beyond HTTP freshness across provider instances", async () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryResponseCache();
      const fetcher = vi.fn(async () => new Response(new Uint8Array([4, 5, 6]), {
        headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=1" },
      }));
      const options = { cacheStorage: cacheStorage(cache), fetcher };
      const proxied = { ...configuration, urlTemplate: "/api/tiles/textures/{z}/{x}/{y}" };
      const tile = { z: 6, x: 32, y: 20 };
      await new XyzImageryProvider(proxied, options).load(tile, new AbortController().signal);
      vi.setSystemTime(new Date("2040-01-01"));
      expect((await new XyzImageryProvider(proxied, options).load(tile, new AbortController().signal)).size).toBe(3);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("evicts persisted placeholders, displays HTTP fallbacks, and retains recovered imagery", async () => {
    const cache = new MemoryResponseCache();
    const fallback = () => new Response(new Uint8Array([0]), {
      headers: { "content-type": "image/png", "x-pas-de-geant-tile-fallback": "upstream-backoff", "cache-control": "max-age=60" },
    });
    const url = "/api/tiles/textures/6/32/20";
    cache.responses.set(url, fallback());
    const fetcher = vi.fn().mockResolvedValueOnce(fallback()).mockResolvedValueOnce(new Response(new Uint8Array([7, 8]), {
      headers: { "content-type": "image/jpeg" },
    }));
    const provider = new XyzImageryProvider({ ...configuration, urlTemplate: "/api/tiles/textures/{z}/{x}/{y}" }, { cacheStorage: cacheStorage(cache), fetcher });
    const tile = { z: 6, x: 32, y: 20 };
    const temporary = await provider.load(tile, new AbortController().signal);
    expect(temporary.size).toBe(1);
    expect(provider.isTemporaryFallback(temporary)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cache.responses.size).toBe(0);
    const recovered = await provider.load(tile, new AbortController().signal);
    expect(recovered.size).toBe(2);
    expect(provider.isTemporaryFallback(recovered)).toBe(false);
    expect((await cache.match(url))?.headers.get("content-type")).toBe("image/jpeg");
    expect((await provider.load(tile, new AbortController().signal)).size).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["x-tile-cache", "x-pas-de-geant-tile-cache"])("displays %s fallbacks without persisting or refetching them", async (header) => {
    const cache = new MemoryResponseCache();
    const fetcher = vi.fn(async () => new Response(new Uint8Array([0]), {
      headers: { "content-type": "image/png", [header]: "FALLBACK" },
    }));
    const provider = new XyzImageryProvider({ ...configuration, urlTemplate: "/api/tiles/textures/{z}/{x}/{y}" }, { cacheStorage: cacheStorage(cache), fetcher });
    expect((await provider.load({ z: 6, x: 32, y: 20 }, new AbortController().signal)).size).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cache.responses.size).toBe(0);
  });

  it("classifies 429 responses and parses both Retry-After forms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T10:00:00Z"));
    try {
      const retryAt = new Date(Date.now() + 45_000).toUTCString();
      for (const [header, expected] of [
        ["12", 12_000],
        [retryAt, 45_000],
      ] as const) {
        const provider = new XyzImageryProvider(configuration, {
          cacheStorage: null,
          fetcher: vi.fn(async () => new Response("limited", {
            status: 429,
            headers: { "retry-after": header },
          })),
        });
        const failure = await provider.load(
          { z: 6, x: 32, y: 20 },
          new AbortController().signal,
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ImageryRequestError);
        expect(failure).toMatchObject({
          kind: "transient",
          status: 429,
          retryAfterMs: expected,
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies access failures as fatal for the browser session", async () => {
    const provider = new XyzImageryProvider(configuration, {
      cacheStorage: null,
      fetcher: vi.fn(async () => new Response("forbidden", { status: 403 })),
    });
    const failure = await provider.load(
      { z: 6, x: 32, y: 20 },
      new AbortController().signal,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ kind: "fatal", status: 403 });
  });

  it("persists successful MapTiler tiles across provider instances", async () => {
    const cache = new MemoryResponseCache();
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    );
    const options = { cacheStorage: cacheStorage(cache), fetcher };

    const first = new XyzImageryProvider(configuration, options);
    const initial = await first.load(
      { z: 6, x: 32, y: 20 },
      new AbortController().signal,
    );
    const second = new XyzImageryProvider(configuration, options);
    const revisited = await second.load(
      { z: 6, x: 32, y: 20 },
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(initial.size).toBe(3);
    expect(revisited.size).toBe(3);
    expect(cache.responses).toHaveLength(1);
  });

  it("evicts malformed cached responses and replaces them from the network", async () => {
    const cache = new MemoryResponseCache();
    const url =
      "https://api.maptiler.com/maps/satellite-v4/256/6/32/20.jpg?key=test-key";
    cache.responses.set(
      url,
      new Response("not an image", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([4, 5]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    );
    const provider = new XyzImageryProvider(configuration, {
      cacheStorage: cacheStorage(cache),
      fetcher,
    });

    const result = await provider.load(
      { z: 6, x: 32, y: 20 },
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(2);
    expect((await cache.responses.get(url)!.blob()).type).toBe("image/jpeg");
  });

  it("persists configured imagery from other providers", async () => {
    const cache = new MemoryResponseCache();
    const storage = cacheStorage(cache);
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    );
    const provider = new XyzImageryProvider({
      ...configuration,
      urlTemplate: "https://imagery.example/{z}/{x}/{y}.jpg",
    }, { cacheStorage: storage, fetcher });

    await provider.load(
      { z: 1, x: 0, y: 0 },
      new AbortController().signal,
    );

    expect(storage.open).toHaveBeenCalled();
    expect(cache.responses.size).toBe(1);
  });
});
