import { ancestorAtZoom } from "./imagery-core.js";
import type { ImageryProvider } from "./imagery-provider.js";
import type { TileIdentity } from "./tile-transition-planner.js";
import { sameTileGrid, type TileGrid } from "./tile-grid.js";

export interface SparseImagerySource {
  readonly provider: ImageryProvider;
  /** Exact, complete tiles declared by the producer; no speculative requests. */
  readonly hasTile: (address: TileIdentity) => boolean;
  /** Higher priority wins when sources offer the same resolution. */
  readonly priority: number;
}

/** Select one opaque tile on a shared XYZ grid. Acquisition, source sharing,
 * parent sampling and rendering remain in the ordinary imagery pipeline.
 */
export class SparseImageryProvider implements ImageryProvider {
  readonly id: string;
  readonly attribution: string;
  readonly tileSize: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly grid?: TileGrid;
  private readonly sources: readonly SparseImagerySource[];

  constructor(
    private readonly fallback: ImageryProvider,
    sources: readonly SparseImagerySource[],
  ) {
    this.sources = [...sources].sort((a, b) => b.priority - a.priority);
    const providers = [fallback, ...this.sources.map((source) => source.provider)];
    if (providers.some((provider) => provider.tileSize !== fallback.tileSize)) {
      throw new Error("Imagery sources on a shared grid must have the same tile size.");
    }
    if (providers.some((provider) => !sameTileGrid(provider.grid, fallback.grid))) {
      throw new Error("Imagery sources must declare the same body and tile grid.");
    }
    this.grid = fallback.grid;
    this.id = providers.map((provider) => provider.id).join("+");
    this.attribution = [...new Set(providers.map((provider) => provider.attribution))].join("; ");
    this.tileSize = fallback.tileSize;
    this.minZoom = fallback.minZoom;
    this.maxZoom = Math.max(...providers.map((provider) => provider.maxZoom));
  }

  private select(address: TileIdentity): { provider: ImageryProvider; tile: TileIdentity } {
    let selected = {
      provider: this.fallback,
      tile: ancestorAtZoom(address, this.fallback.maxZoom),
    };
    // Priority order plus a strict zoom comparison makes equal-resolution
    // choices deterministic, including when the resolved tile is loaded later.
    let selectedPriority = -Infinity;
    for (const source of this.sources) {
      for (let z = Math.min(address.z, source.provider.maxZoom);
        z >= source.provider.minZoom && z >= selected.tile.z; z -= 1) {
        const tile = ancestorAtZoom(address, z);
        if (!source.hasTile(tile)) continue;
        if (z > selected.tile.z || source.priority > selectedPriority) {
          selected = { provider: source.provider, tile };
          selectedPriority = source.priority;
        }
        break;
      }
    }
    return selected;
  }

  resolveSource(address: TileIdentity): TileIdentity {
    return this.select(address).tile;
  }

  async loadFromCache(address: TileIdentity, signal: AbortSignal): Promise<Blob | undefined> {
    const { provider, tile } = this.select(address);
    return await provider.loadFromCache?.(tile, signal);
  }

  async loadFromNetwork(address: TileIdentity, signal: AbortSignal): Promise<Blob> {
    const { provider, tile } = this.select(address);
    return await (provider.loadFromNetwork ?? provider.load).call(provider, tile, signal);
  }

  async load(address: TileIdentity, signal: AbortSignal): Promise<Blob> {
    return await this.loadFromCache(address, signal) ??
      await this.loadFromNetwork(address, signal);
  }
}
