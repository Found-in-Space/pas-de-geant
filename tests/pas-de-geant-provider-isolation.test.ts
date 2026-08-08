import { describe, expect, it, vi } from "vitest";
import { ElevationTileProvider } from "../apps/pas-de-geant/src/elevation-tile-provider.js";
import {
  HttpTileError,
  ImageTileProvider,
} from "../apps/pas-de-geant/src/image-tile-provider.js";
import {
  ScheduledImageryProvider,
} from "../apps/pas-de-geant/src/imagery.js";
import type { ImageryProvider } from "../apps/pas-de-geant/src/imagery-provider.js";
import type {
  TileProvider,
  TileProviderResult,
} from "../apps/pas-de-geant/src/tile-provider.js";
import { TileTransitionScheduler } from "../apps/pas-de-geant/src/tile-transition-scheduler.js";
import type { TileIdentity } from "../apps/pas-de-geant/src/tile-transition-planner.js";

const tile = { z: 0, x: 0, y: 0 };

function terminal<Resource>(
  provider: TileProvider<Resource>,
): Promise<Exclude<TileProviderResult<Resource>, { phase: "in-flight" }>> {
  return new Promise((resolve) => {
    provider.request(tile, (result) => {
      if (result.phase !== "in-flight") resolve(result);
    });
  });
}

function imageryProvider(
  load: ImageryProvider["load"],
): ScheduledImageryProvider {
  return new ScheduledImageryProvider({
    id: "imagery-fixture",
    attribution: "fixture",
    tileSize: 1,
    minZoom: 0,
    maxZoom: 0,
    load,
  }, async () => new Uint8Array([1, 2, 3, 4]));
}

function elevationProvider(
  loadSource: ConstructorParameters<typeof ImageTileProvider>[0]["loadSource"],
): ImageTileProvider {
  return new ImageTileProvider({
    mode: "terrain",
    tilePixels: 1,
    concurrency: 1,
    resolveSource: (sourceTile) => ({
      sourceTile,
      sourceScale: 1,
      sourceOffsetX: 0,
      sourceOffsetY: 0,
    }),
    loadSource,
  });
}

describe("payload provider isolation", () => {
  it("keeps off-plan horizon input out of both concrete provider paths", () => {
    const base: TileIdentity[] = [
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ];
    const parent = base[0]!;
    const desired = [
      ...base.slice(1),
      { z: 2, x: 0, y: 0 },
      { z: 2, x: 1, y: 0 },
      { z: 2, x: 0, y: 1 },
      { z: 2, x: 1, y: 1 },
    ];
    const layout = {
      calculate(target: "base" | "desired") {
        return target === "base" ? base : desired;
      },
    };
    const terrainLoad = vi.fn(async () => ({
      image: {} as HTMLImageElement,
      byteLength: 1,
      cacheStatus: "provider" as const,
    }));
    const terrainImages = elevationProvider(terrainLoad);
    const terrain = new ElevationTileProvider(terrainImages);
    const imageryLoad = vi.fn(async () => new Blob(["image"]));
    const imagery = imageryProvider(imageryLoad);
    const terrainScheduler = new TileTransitionScheduler(
      "base" as "base" | "desired",
      layout,
      terrain,
    );
    const imageryScheduler = new TileTransitionScheduler(
      "base" as "base" | "desired",
      layout,
      imagery,
    );
    terrainScheduler.updateTarget("desired");
    imageryScheduler.updateTarget("desired");
    expect(terrainScheduler.snapshot.graph.groups[0]!.before).toContainEqual(
      parent,
    );
    const outsidePlan = { z: 8, x: 100, y: 100 };

    terrainScheduler.updateHorizonCulling([outsidePlan]);
    imageryScheduler.updateHorizonCulling([outsidePlan]);

    expect(terrainLoad).not.toHaveBeenCalled();
    expect(imageryLoad).not.toHaveBeenCalled();
    expect(terrain.metrics).toMatchObject({
      requestTotal: 0,
      cacheLookupTotal: 0,
      sourceLoadTotal: 0,
    });
    expect(imagery.metrics).toMatchObject({
      requestTotal: 0,
      cacheLookupTotal: 0,
      sourceLoadTotal: 0,
    });
    expect(terrainScheduler.snapshot.requirements).toEqual([]);
    expect(imageryScheduler.snapshot.requirements).toEqual([]);
    terrainScheduler.dispose();
    imageryScheduler.dispose();
    terrain.dispose();
    imagery.dispose();
  });

  it("keeps either payload queue healthy when the other provider is limited", async () => {
    const failedImagery = imageryProvider(async () => {
      // This is how a CORS-hidden 429 is exposed to application fetch.
      throw new TypeError("Failed to fetch");
    });
    const healthyTerrain = elevationProvider(async () => ({
      image: {} as HTMLImageElement,
      byteLength: 1,
      cacheStatus: "provider",
    }));

    await expect(terminal(failedImagery)).resolves.toMatchObject({
      phase: "failure",
    });
    await expect(terminal(healthyTerrain)).resolves.toMatchObject({
      phase: "response",
    });
    expect(failedImagery.retryDiagnostics.state).toBe("open");
    expect(healthyTerrain.retryDiagnostics.state).toBe("closed");
    failedImagery.dispose();
    healthyTerrain.dispose();

    const healthyImagery = imageryProvider(async () => new Blob(["image"]));
    const failedTerrain = elevationProvider(async () => {
      throw new HttpTileError(429, "limited", 60_000);
    });

    await expect(terminal(failedTerrain)).resolves.toMatchObject({
      phase: "failure",
      status: 429,
    });
    await expect(terminal(healthyImagery)).resolves.toMatchObject({
      phase: "response",
    });
    expect(failedTerrain.retryDiagnostics.state).toBe("open");
    expect(healthyImagery.retryDiagnostics.state).toBe("closed");
    failedTerrain.dispose();
    healthyImagery.dispose();
  });
});
