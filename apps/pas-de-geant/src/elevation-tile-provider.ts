import type {
  ImageTileProvider,
  ImageTileProviderMetrics,
  ImageTileResource,
} from "./image-tile-provider.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "./tile-provider.js";
import type { TileIdentity } from "./tile-transition-planner.js";

export interface ElevationTileResource {
  readonly kind: "elevation";
  readonly tile: TileIdentity;
  /** Undefined means a confirmed no-data elevation tile: render it flat. */
  readonly elevation?: ImageTileResource;
}

interface ActiveRequest {
  readonly requestId: number;
  readonly observer: (
    result: TileProviderResult<ElevationTileResource>,
  ) => void;
  elevationHandle?: TileRequestHandle;
  elevation?: ImageTileResource;
  inFlight: boolean;
  active: boolean;
}

/**
 * Scheduler resource provider. Only elevation controls terrain topology;
 * imagery is intentionally requested and bound by TerrainSurface afterwards.
 */
export class ElevationTileProvider implements TileProvider<ElevationTileResource> {
  readonly tilePixels: number;
  private nextRequestId = 1;
  private readonly active = new Map<number, ActiveRequest>();

  constructor(private readonly elevationProvider: ImageTileProvider) {
    this.tilePixels = elevationProvider.tilePixels;
  }

  get metrics(): ImageTileProviderMetrics {
    return this.elevationProvider.metrics;
  }

  get retryDiagnostics() {
    return this.elevationProvider.retryDiagnostics;
  }

  get estimatedAssetReadyMs(): number {
    return this.elevationProvider.estimatedAssetReadyMs;
  }

  retainSourceTiles(tiles: Iterable<TileIdentity>): void {
    this.elevationProvider.retainSourceTiles(tiles);
  }

  updatePriority(tiles: Iterable<TileIdentity>): void {
    this.elevationProvider.updatePriority(tiles);
  }

  updateDemand(tiles: Iterable<TileIdentity>): void {
    this.elevationProvider.updateDemand(tiles);
  }

  resumeDeferred(): void {
    this.elevationProvider.resumeDeferred();
  }

  beginWarmRamp(): void {
    this.elevationProvider.beginWarmRamp();
  }

  request(
    tile: TileIdentity,
    observer: (result: TileProviderResult<ElevationTileResource>) => void,
  ): TileRequestHandle {
    const requestId = this.nextRequestId++;
    const request: ActiveRequest = {
      requestId,
      observer,
      inFlight: false,
      active: true,
    };
    this.active.set(requestId, request);

    request.elevationHandle = this.elevationProvider.request(tile, (result) => {
      if (!request.active) return;
      if (result.phase === "in-flight") {
        this.markInFlight(request);
      } else if (result.phase === "failure") {
        // Mapterhorn's 404 is an expected no-data result: topology can use a
        // flat tile while all other elevation failures remain retryable.
        if (result.status === 404) {
          this.complete(tile, request);
        } else {
          request.active = false;
          this.active.delete(requestId);
          observer(result);
        }
      } else {
        request.elevation = result.resource;
        this.complete(tile, request);
      }
    });

    return Object.freeze({
      requestId,
      cancel: (): void => {
        if (!request.active) return;
        request.active = false;
        this.active.delete(requestId);
        request.elevationHandle?.cancel();
      },
    });
  }

  dispose(): void {
    for (const request of this.active.values()) {
      request.active = false;
      request.elevationHandle?.cancel();
    }
    this.active.clear();
    this.elevationProvider.dispose();
  }

  private markInFlight(request: ActiveRequest): void {
    if (request.inFlight) return;
    request.inFlight = true;
    request.observer({ phase: "in-flight" });
  }

  private complete(tile: TileIdentity, request: ActiveRequest): void {
    if (!request.active) return;
    request.active = false;
    this.active.delete(request.requestId);
    request.observer({
      phase: "response",
      resource: Object.freeze({
        kind: "elevation",
        tile: Object.freeze({ z: tile.z, x: tile.x, y: tile.y }),
        ...(request.elevation ? { elevation: request.elevation } : {}),
      }),
    });
  }
}
