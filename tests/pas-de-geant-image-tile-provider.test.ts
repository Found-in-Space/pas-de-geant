import { describe, expect, it, vi } from "vitest";
import {
  HttpTileError,
  ImageTileProvider,
  type ImageTileResource,
} from "../apps/pas-de-geant/src/image-tile-provider.js";
import type { TileProviderResult } from "../apps/pas-de-geant/src/tile-provider.js";

describe("Image tile provider", () => {
  it("does not drain the terrain queue after a fast systemic failure", async () => {
    const pending: Array<{
      resolve(value: {
        image: HTMLImageElement;
        byteLength: number;
        cacheStatus: "provider";
      }): void;
      reject(error: unknown): void;
    }> = [];
    const failures: number[] = [];
    const provider = new ImageTileProvider({
      mode: "terrain",
      tilePixels: 512,
      concurrency: 4,
      resolveSource: (tile) => ({
        sourceTile: tile,
        sourceScale: 1,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
      }),
      loadSource: async () => await new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    });
    for (let index = 0; index < 8; index += 1) {
      provider.request({ z: 3, x: index, y: 0 }, (result) => {
        if (result.phase === "failure") failures.push(index);
      });
    }
    await vi.waitFor(() => expect(pending).toHaveLength(4));

    pending[0]!.reject(new HttpTileError(503, "unavailable"));
    await vi.waitFor(() => expect(provider.metrics.queued).toBe(0));

    expect(pending).toHaveLength(4);
    expect(provider.metrics.sourceLoadTotal).toBe(4);
    expect(failures).toEqual(expect.arrayContaining([0, 4, 5, 6, 7]));
    for (const load of pending.slice(1)) load.resolve({
      image: {} as HTMLImageElement,
      byteLength: 1,
      cacheStatus: "provider",
    });
    await vi.waitFor(() => expect(provider.metrics.inFlight).toBe(0));
    provider.dispose();
  });

  it("starts one half-open probe before restoring terrain concurrency", async () => {
    let attempts = 0;
    let rejectInitial!: (error: unknown) => void;
    let resolveProbe!: (value: {
      image: HTMLImageElement;
      byteLength: number;
      cacheStatus: "provider";
    }) => void;
    const success = {
      image: {} as HTMLImageElement,
      byteLength: 1,
      cacheStatus: "provider" as const,
    };
    const provider = new ImageTileProvider({
      mode: "terrain",
      tilePixels: 512,
      concurrency: 4,
      resolveSource: (tile) => ({
        sourceTile: tile,
        sourceScale: 1,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
      }),
      loadSource: async () => {
        attempts += 1;
        if (attempts === 1) {
          return await new Promise((_resolve, reject) => {
            rejectInitial = reject;
          });
        }
        if (attempts === 2) {
          return await new Promise((resolve) => {
            resolveProbe = resolve;
          });
        }
        return success;
      },
    });
    provider.request({ z: 3, x: 0, y: 0 }, () => {});
    await vi.waitFor(() => expect(attempts).toBe(1));
    rejectInitial(new HttpTileError(429, "limited", 0));
    await vi.waitFor(() =>
      expect(provider.retryDiagnostics.state).toBe("open"),
    );

    for (let x = 1; x <= 3; x += 1) {
      provider.request({ z: 3, x, y: 0 }, () => {});
    }
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(provider.retryDiagnostics).toMatchObject({
      state: "half-open",
      probe_in_flight: true,
    });

    resolveProbe(success);
    await vi.waitFor(() => expect(attempts).toBe(4));
    await vi.waitFor(() =>
      expect(provider.retryDiagnostics.state).toBe("closed"),
    );
    provider.dispose();
  });

  it("releases a cancelled half-open probe without recording a network failure", async () => {
    let attempts = 0;
    const provider = new ImageTileProvider({
      mode: "terrain",
      tilePixels: 512,
      concurrency: 4,
      resolveSource: (tile) => ({
        sourceTile: tile,
        sourceScale: 1,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
      }),
      loadSource: async (_tile, signal) => {
        attempts += 1;
        if (attempts === 1) throw new HttpTileError(429, "limited", 0);
        return await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    provider.request({ z: 3, x: 0, y: 0 }, () => {});
    await vi.waitFor(() =>
      expect(provider.retryDiagnostics.state).toBe("open"),
    );

    const cancelled = provider.request({ z: 3, x: 1, y: 0 }, () => {});
    await vi.waitFor(() => expect(attempts).toBe(2));
    cancelled.cancel();
    provider.request({ z: 3, x: 2, y: 0 }, () => {});
    await vi.waitFor(() => expect(attempts).toBe(3));

    expect(provider.retryDiagnostics).toMatchObject({
      state: "half-open",
      probe_in_flight: true,
      network_failure_count: 0,
    });
    provider.dispose();
  });

  it("releases decoded sources outside the retained geographic working set", async () => {
    const provider = new ImageTileProvider({
      mode: "terrain",
      tilePixels: 512,
      concurrency: 1,
      resolveSource: (tile) => ({
        sourceTile: tile,
        sourceScale: 1,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
      }),
      loadSource: async () => ({
        image: {} as HTMLImageElement,
        byteLength: 10,
        cacheStatus: "provider" as const,
      }),
    });
    provider.request({ z: 2, x: 1, y: 1 }, () => {});
    provider.request({ z: 2, x: 2, y: 1 }, () => {});
    await vi.waitFor(() =>
      expect(provider.metrics.decodedSourceCount).toBe(2),
    );

    provider.retainSourceTiles([{ z: 2, x: 1, y: 1 }]);
    expect(provider.metrics.decodedSourceCount).toBe(1);
    expect(provider.metrics.estimatedDecodedBytes).toBe(512 * 512 * 4);
  });

  it("starts the highest display zoom first", async () => {
    const startedZooms: number[] = [];
    const provider = new ImageTileProvider({
      mode: "imagery",
      tilePixels: 512,
      concurrency: 1,
      resolveSource: (tile) => ({
        sourceTile: tile,
        sourceScale: 1,
        sourceOffsetX: 0,
        sourceOffsetY: 0,
      }),
      loadSource: async (tile) => {
        startedZooms.push(tile.z);
        return {
          image: {} as HTMLImageElement,
          byteLength: 1,
          cacheStatus: "provider" as const,
        };
      },
    });

    provider.request({ z: 1, x: 0, y: 0 }, () => {});
    provider.request({ z: 5, x: 0, y: 0 }, () => {});
    provider.request({ z: 3, x: 0, y: 0 }, () => {});

    await vi.waitFor(() => expect(startedZooms).toHaveLength(3));
    expect(startedZooms).toEqual([5, 3, 1]);
  });

  it("coalesces overzoomed children and then serves revisits from decoded memory", async () => {
    const loadSource = vi.fn(async () => ({
      image: {} as HTMLImageElement,
      byteLength: 1_024,
      cacheStatus: "provider" as const,
    }));
    const provider = new ImageTileProvider({
      mode: "imagery",
      tilePixels: 512,
      concurrency: 1,
      resolveSource: (tile) => ({
        sourceTile: { z: 1, x: Math.floor(tile.x / 2), y: Math.floor(tile.y / 2) },
        sourceScale: 2,
        sourceOffsetX: tile.x % 2,
        sourceOffsetY: tile.y % 2,
      }),
      loadSource,
    });
    const resources: ImageTileResource[] = [];
    const observe = (
      result: TileProviderResult<ImageTileResource>,
    ): void => {
      if (result.phase === "response") resources.push(result.resource);
    };

    provider.request({ z: 2, x: 0, y: 0 }, observe);
    provider.request({ z: 2, x: 1, y: 0 }, observe);
    await vi.waitFor(() => expect(resources).toHaveLength(2));

    expect(loadSource).toHaveBeenCalledTimes(1);
    expect(resources.map(({ sourceOffsetX }) => sourceOffsetX).sort()).toEqual([0, 1]);
    expect(provider.metrics.sharedRequestTotal).toBe(1);

    provider.request({ z: 2, x: 0, y: 1 }, observe);
    await vi.waitFor(() => expect(resources).toHaveLength(3));
    expect(loadSource).toHaveBeenCalledTimes(1);
    expect(provider.metrics.memoryHitTotal).toBe(1);
    expect(resources[2]!.cacheStatus).toBe("memory");
  });

  it("cancels the shared source only after its final consumer leaves", async () => {
    const sourceSignals: AbortSignal[] = [];
    const provider = new ImageTileProvider({
      mode: "terrain",
      tilePixels: 512,
      concurrency: 1,
      resolveSource: (tile) => ({
        sourceTile: { z: 0, x: 0, y: 0 },
        sourceScale: 2 ** tile.z,
        sourceOffsetX: tile.x,
        sourceOffsetY: tile.y,
      }),
      loadSource: (_tile, signal) => {
        sourceSignals.push(signal);
        return new Promise(() => {});
      },
    });

    const first = provider.request({ z: 1, x: 0, y: 0 }, () => {});
    const second = provider.request({ z: 1, x: 1, y: 0 }, () => {});
    await vi.waitFor(() => expect(sourceSignals).toHaveLength(1));

    first.cancel();
    expect(sourceSignals[0]!.aborted).toBe(false);
    second.cancel();
    expect(sourceSignals[0]!.aborted).toBe(true);

    provider.request({ z: 1, x: 0, y: 1 }, () => {});
    await vi.waitFor(() => expect(sourceSignals).toHaveLength(2));
    expect(sourceSignals[1]!.aborted).toBe(false);
    provider.dispose();
    expect(sourceSignals[1]!.aborted).toBe(true);
  });
});
