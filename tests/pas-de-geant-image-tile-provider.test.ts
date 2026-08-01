import { describe, expect, it, vi } from "vitest";
import {
  ImageTileProvider,
  type ImageTileResource,
} from "../apps/pas-de-geant/src/image-tile-provider.js";
import type { TileProviderResult } from "../apps/pas-de-geant/src/tile-provider.js";

describe("Image tile provider", () => {
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
