import { describe, expect, it, vi } from "vitest";
import {
  loadCachedElevation,
  loadElevationFromNetwork,
  type ElevationCacheStorage,
  type ElevationResponseCache,
} from "@found-in-space/worlds/elevation-cache";

const tile = { z: 4, x: 8, y: 5 };

function cacheStorage(cache: ElevationResponseCache): ElevationCacheStorage {
  return { open: vi.fn(async () => cache) };
}

describe("Elevation cache", () => {
  it("supports explicitly configured production tile URLs with browser persistence", async () => {
    let retained: Response | undefined;
    const cache: ElevationResponseCache = {
      match: vi.fn(async () => retained?.clone()),
      put: vi.fn(async (_url, response) => { retained = response.clone(); }),
      delete: vi.fn(async () => false),
    };
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/webp" } }));
    const options = { cacheStorage: cacheStorage(cache), fetcher, urlTemplate: "https://tiles.example/elevation/{z}/{x}/{y}.webp" };
    await loadCachedElevation(tile, new AbortController().signal, options);
    expect((await loadCachedElevation(tile, new AbortController().signal, options)).cacheStatus).toBe("hit");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("https://tiles.example/elevation/4/8/5.webp", expect.anything());
  });

  it("reuses proxied elevation indefinitely without contacting the server", async () => {
    let retained: Response | undefined;
    const cache: ElevationResponseCache = {
      match: vi.fn(async () => retained?.clone()),
      put: vi.fn(async (_url, response) => { retained = response.clone(); }),
      delete: vi.fn(async () => false),
    };
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/webp", "cache-control": "public, max-age=0", "x-pas-de-geant-tile-cache": "MISS" },
    }));
    const options = { cacheStorage: cacheStorage(cache), fetcher };
    await loadCachedElevation(tile, new AbortController().signal, options);
    const hit = await loadCachedElevation(tile, new AbortController().signal, options);
    expect(hit.cacheStatus).toBe("hit");
    expect(new Uint8Array(hit.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects legacy fallback elevation without caching synthetic data", async () => {
    const cache: ElevationResponseCache = { match: vi.fn(async () => undefined), put: vi.fn(), delete: vi.fn(async () => false) };
    const fetcher = vi.fn(async () => new Response(new Uint8Array([0]), {
      headers: { "content-type": "image/png", "x-pas-de-geant-tile-fallback": "upstream-backoff", "retry-after": "10" },
    }));
    const payload = await loadCachedElevation(tile, new AbortController().signal, { cacheStorage: cacheStorage(cache), fetcher });
    expect(payload).toMatchObject({ status: 503, cacheStatus: "unavailable", retryAfterMs: 10_000 });
    expect(payload.bytes.byteLength).toBe(0);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("returns a persistent hit without admitting a network fetch", async () => {
    const fetcher = vi.fn();
    const cache: ElevationResponseCache = {
      match: vi.fn(async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/webp" },
        })
      ),
      put: vi.fn(),
      delete: vi.fn(async () => false),
    };

    const payload = await loadCachedElevation(
      tile,
      new AbortController().signal,
      {
        cacheStorage: cacheStorage(cache),
        fetcher: fetcher as unknown as typeof fetch,
        useProxy: false,
      },
    );

    expect(new Uint8Array(payload.bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(payload).toMatchObject({
      status: 200,
      contentType: "image/webp",
      cacheStatus: "hit",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("keeps a successful network tile when persistent storage is full", async () => {
    const cache: ElevationResponseCache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => {
        throw new Error("quota exceeded");
      }),
      delete: vi.fn(async () => false),
    };
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([4, 5, 6]), { status: 200 })
    );

    const payload = await loadElevationFromNetwork(
      tile,
      new AbortController().signal,
      {
        cacheStorage: cacheStorage(cache),
        fetcher: fetcher as unknown as typeof fetch,
        useProxy: false,
      },
    );

    expect(payload.status).toBe(200);
    expect(payload.cacheStatus).toBe("error");
    expect(new Uint8Array(payload.bytes)).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("preserves cancellation while a network response is being cached", async () => {
    const controller = new AbortController();
    const cache: ElevationResponseCache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => {
        controller.abort();
      }),
      delete: vi.fn(async () => false),
    };
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([7, 8, 9]), { status: 200 })
    );

    await expect(
      loadElevationFromNetwork(tile, controller.signal, {
        cacheStorage: cacheStorage(cache),
        fetcher: fetcher as unknown as typeof fetch,
        useProxy: false,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("persists proxied elevation in the browser as well as the proxy", async () => {
    const cache: ElevationResponseCache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(),
      delete: vi.fn(async () => false),
    };
    const fetcher = vi.fn(async () =>
      new Response(new Uint8Array([10, 11, 12]), {
        status: 200,
        headers: {
          "content-type": "image/webp",
          "x-pas-de-geant-tile-cache": "HIT",
        },
      })
    );

    const payload = await loadCachedElevation(
      tile,
      new AbortController().signal,
      {
        cacheStorage: cacheStorage(cache),
        fetcher: fetcher as unknown as typeof fetch,
        useProxy: true,
      },
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/tiles/elevation/4/8/5",
      expect.objectContaining({ cache: "default", mode: "cors" }),
    );
    expect(payload.cacheStatus).toBe("stored");
    expect(cache.match).toHaveBeenCalled();
    expect(cache.put).toHaveBeenCalled();
  });
});
