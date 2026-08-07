import { describe, expect, it, vi } from "vitest";
import {
  MAPTILER_IMAGERY_CACHE_NAME,
  type ImageryCacheStorage,
  type ImageryResponseCache,
  XyzImageryProvider,
} from "../apps/pas-de-geant/src/imagery-provider.js";

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

  it("does not persist imagery from unrelated providers", async () => {
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

    expect(storage.open).not.toHaveBeenCalled();
    expect(cache.responses.size).toBe(0);
  });
});
