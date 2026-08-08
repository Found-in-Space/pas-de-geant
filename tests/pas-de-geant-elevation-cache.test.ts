import { describe, expect, it, vi } from "vitest";
import {
  loadCachedElevation,
  loadElevationFromNetwork,
  type ElevationCacheStorage,
  type ElevationResponseCache,
} from "../apps/pas-de-geant/src/elevation-cache.js";

const tile = { z: 4, x: 8, y: 5 };

function cacheStorage(cache: ElevationResponseCache): ElevationCacheStorage {
  return { open: vi.fn(async () => cache) };
}

describe("Elevation cache", () => {
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

  it("uses the development proxy as the persistent cache boundary", async () => {
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
    expect(payload.cacheStatus).toBe("hit");
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });
});
