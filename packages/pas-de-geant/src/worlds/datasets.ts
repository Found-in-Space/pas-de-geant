import * as THREE from "three";
import { celestialBody, type SolarSystemBodyId } from "./solar-system.js";
import { displayTextureSource, elevationSource, requireCompatibleSurfaceSources } from "./surface-product.js";
import { createBodySurfaceModel } from "./surface-model.js";
import { surfaceSourceUrl, tileGridKey } from "./tile-grid.js";
import { XyzImageryProvider } from "./imagery-provider.js";
import { ElevationTileProvider } from "./elevation-tile-provider.js";
import { createXyzElevationTileProvider } from "./image-tile-provider.js";
import type { WorldSurfaceSource } from "./world-runtime.js";
import type { WorldWorkerFactory } from "./workers.js";
import type { TileAddressing } from "./tile-url.js";
export interface SurfaceDatasetBinding {
  readonly productUrl: string;
  readonly urlTemplate: string;
  readonly attribution: string;
  readonly addressing?: TileAddressing;
}
export interface BodySurfaceDatasets {
  readonly imagery?: SurfaceDatasetBinding;
  readonly elevation?: SurfaceDatasetBinding;
}
/** Resolves relative templates while preserving literal tile tokens. */
export function resolveSurfaceUrl(template: string, baseUrl: string): string {
  const tokens = ["{z}", "{x}", "{y}", "{source}"];
  let path = template; tokens.forEach((token, i) => { path = path.replaceAll(token, `__GEANT_TOKEN_${i}__`); });
  path = new URL(path, baseUrl).href; tokens.forEach((token, i) => { path = path.replaceAll(`__GEANT_TOKEN_${i}__`, token); }); return path;
}
/** Source admission precedes base or tile acquisition; display and numeric heights stay independent. */
export async function resolveBodySurfaceDatasets(options: {
  readonly body: SolarSystemBodyId;
  readonly datasets: BodySurfaceDatasets;
  readonly baseTexture: THREE.Texture;
  readonly disposeBaseTexture?: boolean;
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
  readonly workers?: WorldWorkerFactory;
}): Promise<WorldSurfaceSource> {
  const body = celestialBody(options.body), fetcher = options.fetcher ?? fetch;
  async function descriptor(binding: SurfaceDatasetBinding | undefined) {
    if (!binding) return undefined;
    const response = await fetcher(binding.productUrl, { signal: options.signal });
    if (!response.ok) throw new Error(`Surface descriptor unavailable (HTTP ${response.status}).`);
    return response.json();
  }
  const [imageValue, heightValue] = await Promise.all([descriptor(options.datasets.imagery), descriptor(options.datasets.elevation)]);
  const imagery = imageValue ? displayTextureSource(imageValue, body) : undefined;
  const elevation = heightValue ? elevationSource(heightValue, body) : undefined;
  requireCompatibleSurfaceSources(imagery, elevation);
  const grid = imagery?.grid ?? elevation?.grid;
  const imageBinding = options.datasets.imagery, heightBinding = options.datasets.elevation;
  const surfaceModel = createBodySurfaceModel(body, { projection: grid?.projection, heightEncoding: elevation?.heightEncoding,
    elevationMetadata: elevation?.metadata });
  return { baseTexture: options.baseTexture, disposeBaseTexture: options.disposeBaseTexture, workers: options.workers, surfaceModel,
    imageryProvider: imagery && imageBinding ? new XyzImageryProvider({ id: `${body.id}-${tileGridKey(imagery.grid)}-${imagery.identity}`,
      grid: imagery.grid, urlTemplate: surfaceSourceUrl(resolveSurfaceUrl(imageBinding.urlTemplate, imageBinding.productUrl), imagery.grid, imagery.identity),
      addressing: imageBinding.addressing ?? "xyz", attribution: imageBinding.attribution, tileSize: imagery.tileSize, minZoom: 0, maxZoom: imagery.maximumZoom }) : undefined,
    elevationProvider: elevation && heightBinding ? new ElevationTileProvider(createXyzElevationTileProvider(elevation.metadata, elevation.metadata.maxSourceZoom,
      { urlTemplate: surfaceSourceUrl(resolveSurfaceUrl(heightBinding.urlTemplate, heightBinding.productUrl), elevation.grid, elevation.identity),
        addressing: heightBinding.addressing ?? "xyz", availability: elevation.availability }), { missingTile: "failure" }) : undefined };
}
