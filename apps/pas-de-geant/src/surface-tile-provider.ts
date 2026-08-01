import type {
  ImageTileProvider,
  ImageTileResource,
} from "./image-tile-provider.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "./tile-provider.js";
import type { TileIdentity } from "./tile-transition-planner.js";

export interface SurfaceTileResource {
  readonly kind: "surface";
  readonly tile: TileIdentity;
  readonly elevation: ImageTileResource;
  readonly imagery?: ImageTileResource;
}

interface ActiveRequest {
  readonly requestId: number;
  readonly observer: (result: TileProviderResult<SurfaceTileResource>) => void;
  elevationHandle?: TileRequestHandle;
  imageryHandle?: TileRequestHandle;
  elevation?: ImageTileResource;
  imagery?: ImageTileResource;
  imagerySettled: boolean;
  inFlight: boolean;
  active: boolean;
}

/**
 * Joins independent elevation and imagery loaders into one scheduler resource.
 * Elevation defines readiness; optional photographic imagery may fall back to
 * the renderer's complete base map without leaving a visible coverage gap.
 */
export class SurfaceTileProvider implements TileProvider<SurfaceTileResource> {
  readonly tilePixels: number;
  private nextRequestId = 1;
  private readonly active = new Map<number, ActiveRequest>();

  constructor(
    private readonly elevationProvider: ImageTileProvider,
    private readonly imageryProvider?: ImageTileProvider,
    private readonly imageryMinimumZoom = 0,
  ) {
    this.tilePixels = Math.min(
      elevationProvider.tilePixels,
      imageryProvider?.tilePixels ?? elevationProvider.tilePixels,
    );
  }

  request(
    tile: TileIdentity,
    observer: (result: TileProviderResult<SurfaceTileResource>) => void,
  ): TileRequestHandle {
    const requestId = this.nextRequestId++;
    const request: ActiveRequest = {
      requestId,
      observer,
      imagerySettled:
        this.imageryProvider === undefined || tile.z < this.imageryMinimumZoom,
      inFlight: false,
      active: true,
    };
    this.active.set(requestId, request);

    request.elevationHandle = this.elevationProvider.request(tile, (result) => {
      if (!request.active) return;
      if (result.phase === "in-flight") {
        this.markInFlight(request);
      } else if (result.phase === "failure") {
        request.active = false;
        this.active.delete(requestId);
        request.imageryHandle?.cancel();
        observer(result);
      } else {
        request.elevation = result.resource;
        this.completeIfReady(tile, request);
      }
    });

    if (!request.imagerySettled) {
      request.imageryHandle = this.imageryProvider!.request(tile, (result) => {
        if (!request.active) return;
        if (result.phase === "in-flight") {
          this.markInFlight(request);
        } else {
          request.imagerySettled = true;
          if (result.phase === "response") request.imagery = result.resource;
          this.completeIfReady(tile, request);
        }
      });
    }

    return Object.freeze({
      requestId,
      cancel: (): void => {
        if (!request.active) return;
        request.active = false;
        this.active.delete(requestId);
        request.elevationHandle?.cancel();
        request.imageryHandle?.cancel();
      },
    });
  }

  dispose(): void {
    for (const request of this.active.values()) {
      request.active = false;
      request.elevationHandle?.cancel();
      request.imageryHandle?.cancel();
    }
    this.active.clear();
    this.elevationProvider.dispose();
    this.imageryProvider?.dispose();
  }

  private markInFlight(request: ActiveRequest): void {
    if (request.inFlight) return;
    request.inFlight = true;
    request.observer({ phase: "in-flight" });
  }

  private completeIfReady(
    tile: TileIdentity,
    request: ActiveRequest,
  ): void {
    if (!request.active || !request.elevation || !request.imagerySettled) return;
    request.active = false;
    this.active.delete(request.requestId);
    request.observer({
      phase: "response",
      resource: Object.freeze({
        kind: "surface",
        tile: Object.freeze({ z: tile.z, x: tile.x, y: tile.y }),
        elevation: request.elevation,
        ...(request.imagery ? { imagery: request.imagery } : {}),
      }),
    });
  }
}
