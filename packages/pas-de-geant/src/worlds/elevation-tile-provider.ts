import type { TileSourceCoverage } from "./tile-refinement.js";
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

export interface TerrainElevationProvider extends TileProvider<ElevationTileResource> {
  readonly coverage?: TileSourceCoverage;
  readonly tilePixels: number;
  readonly metrics: ImageTileProviderMetrics;
  retainSourceTiles(tiles: Iterable<TileIdentity>): void;
  resumeDeferred(): void;
  dispose(): void;
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
export class ElevationTileProvider<TPayload = unknown>
  implements TerrainElevationProvider
{
  readonly tilePixels: number;
  private nextRequestId = 1;
  private readonly active = new Map<number, ActiveRequest>();

  constructor(private readonly elevationProvider: ImageTileProvider<TPayload>,
    private readonly options: { readonly missingTile?: "flat" | "failure" } = {}) {
    this.tilePixels = elevationProvider.tilePixels;
  }

  get coverage(): TileSourceCoverage | undefined { return this.elevationProvider.coverage; }

  get metrics(): ImageTileProviderMetrics {
    return this.elevationProvider.metrics;
  }

  get retryDiagnostics() {
    return this.elevationProvider.retryDiagnostics;
  }

  retainSourceTiles(tiles: Iterable<TileIdentity>): void {
    this.elevationProvider.retainSourceTiles(tiles);
  }

  resumeDeferred(): void {
    this.elevationProvider.resumeDeferred();
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
        if (result.status === 404 && this.options.missingTile !== "failure") {
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

const EMPTY_METRICS: ImageTileProviderMetrics = Object.freeze({
  requestTotal: 0,
  sourceLoadTotal: 0,
  cacheLookupTotal: 0,
  cacheHitTotal: 0,
  memoryHitTotal: 0,
  sharedRequestTotal: 0,
  persistentHitTotal: 0,
  persistentWriteTotal: 0,
  failureTotal: 0,
  byteTotal: 0,
  queued: 0,
  networkDeferred: 0,
  processingQueued: 0,
  inFlight: 0,
  acquisitionActive: 0,
  processingActive: 0,
  decodedSourceCount: 0,
  estimatedDecodedBytes: 0,
});

/** Supplies immediately-ready flat topology when a body has no height source. */
export class FlatElevationTileProvider implements TerrainElevationProvider {
  readonly metrics = EMPTY_METRICS;
  private nextRequestId = 1;

  constructor(readonly tilePixels = 512) {}

  request(
    tile: TileIdentity,
    observer: (result: TileProviderResult<ElevationTileResource>) => void,
  ): TileRequestHandle {
    const requestId = this.nextRequestId++;
    let active = true;
    queueMicrotask(() => active && observer({
      phase: "response",
      resource: Object.freeze({
        kind: "elevation",
        tile: Object.freeze({ ...tile }),
      }),
    }));
    return Object.freeze({ requestId, cancel() { active = false; } });
  }

  retainSourceTiles(_tiles: Iterable<TileIdentity>): void {}
  resumeDeferred(): void {}
  dispose(): void {}
}
