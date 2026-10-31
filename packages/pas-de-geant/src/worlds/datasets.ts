import * as THREE from "three";
import { celestialBody, type SolarSystemBodyId } from "./solar-system.js";
import { displayTextureSource, elevationSource, requireCompatibleSurfaceSources } from "./surface-product.js";
import { createBodySurfaceModel } from "./surface-model.js";
import { surfaceSourceUrl, tileGridKey } from "./tile-grid.js";
import { XyzImageryProvider } from "./imagery-provider.js";
import { ElevationTileProvider, type TerrainElevationProvider } from "./elevation-tile-provider.js";
import { createXyzElevationTileProvider } from "./image-tile-provider.js";
import type { WorldSurfaceSource } from "./world-runtime.js";
import type { WorldWorkerFactory } from "./workers.js";
import type { TileAddressing } from "./tile-url.js";
import { createEarthPmtilesElevationProvider, earthPmtilesElevationSource, type EarthPmtilesDatasetBinding } from "./pmtiles-elevation.js";
export type { EarthPmtilesDatasetBinding } from "./pmtiles-elevation.js";
export interface SurfaceDatasetBinding {
  readonly transport?: "xyz";
  readonly productUrl: string;
  /** SHA-256 of the exact descriptor bytes, from the producer/delivery record. */
  readonly productSha256?: string;
  readonly urlTemplate: string;
  readonly attribution: string;
  readonly addressing?: TileAddressing;
}
async function authenticate(bytes: ArrayBuffer, expected: string | undefined): Promise<void> {
  if (expected === undefined) return;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== expected) throw new Error("Surface asset SHA-256 differs from its admitted identity.");
}
export interface BodySurfaceDatasets {
  readonly imagery?: SurfaceDatasetBinding;
  readonly elevation?: SurfaceDatasetBinding | EarthPmtilesDatasetBinding;
  readonly nightImagery?: SurfaceDatasetBinding;
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
  /** Custom loaders must authenticate the supplied hash before decoding. */
  readonly loadTexture?: (url: string, signal?: AbortSignal, sha256?: string) => Promise<THREE.Texture>;
}): Promise<WorldSurfaceSource> {
  const body = celestialBody(options.body), fetcher = options.fetcher ?? fetch;
  for (const binding of Object.values(options.datasets)) {
    if (binding?.productSha256 !== undefined && !/^[a-f0-9]{64}$/.test(binding.productSha256)) {
      throw new Error("Surface descriptor SHA-256 must be 64 lowercase hexadecimal characters.");
    }
  }
  async function descriptor(binding: Pick<SurfaceDatasetBinding, "productUrl" | "productSha256"> | undefined) {
    if (!binding) return undefined;
    options.signal?.throwIfAborted();
    const response = await fetcher(binding.productUrl, { signal: options.signal });
    if (!response.ok) throw new Error(`Surface descriptor unavailable (HTTP ${response.status}).`);
    const bytes = await response.arrayBuffer();
    await authenticate(bytes, binding.productSha256);
    options.signal?.throwIfAborted();
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const [imageValue, heightValue, nightValue] = await Promise.all([descriptor(options.datasets.imagery), descriptor(options.datasets.elevation), descriptor(options.datasets.nightImagery)]);
  const imagery = imageValue ? displayTextureSource(imageValue, body) : undefined;
  const night = nightValue ? displayTextureSource(nightValue, body) : undefined;
  const heightBinding = options.datasets.elevation;
  const pmtiles = heightBinding?.transport === "pmtiles"
    ? earthPmtilesElevationSource(heightValue, body.id, heightBinding) : undefined;
  const elevation = pmtiles ?? (heightValue ? elevationSource(heightValue, body) : undefined);
  requireCompatibleSurfaceSources(imagery, elevation);
  requireCompatibleSurfaceSources(night, elevation);
  if (night && !imagery) throw new Error("Night imagery requires a day imagery source.");
  if (night && imagery && tileGridKey(night.grid) !== tileGridKey(imagery.grid)) {
    throw new Error("Day and night imagery use different body grids.");
  }
  const grid = imagery?.grid ?? elevation?.grid;
  const imageBinding = options.datasets.imagery;
  const surfaceModel = createBodySurfaceModel(body, { projection: grid?.projection, heightEncoding: elevation?.heightEncoding,
    elevationMetadata: elevation?.metadata });
  const load = options.loadTexture ?? (async (url: string, signal?: AbortSignal, sha256?: string) => {
    const response = await fetcher(url, { signal });
    if (!response.ok) throw new Error(`Surface base unavailable (HTTP ${response.status}).`);
    const bytes = await response.arrayBuffer();
    await authenticate(bytes, sha256);
    signal?.throwIfAborted();
    const bitmap = await createImageBitmap(new Blob([bytes], { type: response.headers.get("content-type") ?? "" }), { colorSpaceConversion: "none" });
    const texture = new THREE.Texture(bitmap); texture.needsUpdate = true;
    texture.addEventListener("dispose", () => bitmap.close());
    return texture;
  });
  let baseTexture = options.baseTexture, nightTexture: THREE.Texture | undefined;
  let baseFallback = false;
  const owned: THREE.Texture[] = [];
  let elevationProvider: TerrainElevationProvider | undefined;
  try {
    if (elevation && heightBinding) {
      if (pmtiles) {
        elevationProvider = new ElevationTileProvider(await createEarthPmtilesElevationProvider(pmtiles,
          { productUrl: heightBinding.productUrl, signal: options.signal, fetcher }), { missingTile: "failure" });
      } else if (heightBinding.transport !== "pmtiles") {
        elevationProvider = new ElevationTileProvider(createXyzElevationTileProvider(elevation.metadata, elevation.metadata.maxSourceZoom,
          { urlTemplate: surfaceSourceUrl(resolveSurfaceUrl(heightBinding.urlTemplate, heightBinding.productUrl), elevation.grid, elevation.identity),
            addressing: heightBinding.addressing ?? "xyz", availability: elevation.availability }), { missingTile: "failure" });
      }
    }
    if (imagery && imageBinding) {
      try {
        baseTexture = await load(resolveSurfaceUrl(imagery.basePath, imageBinding.productUrl), options.signal, imagery.baseSha256);
        owned.push(baseTexture);
      } catch (error) { options.signal?.throwIfAborted(); baseFallback = true; }
    }
    if (night && options.datasets.nightImagery) {
      try {
        nightTexture = await load(resolveSurfaceUrl(night.basePath, options.datasets.nightImagery.productUrl), options.signal, night.baseSha256);
      } catch (error) {
        options.signal?.throwIfAborted(); baseFallback = true;
        // Missing night imagery stays dark; the day map is never emitted as lights.
        nightTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
        nightTexture.needsUpdate = true;
      }
      owned.push(nightTexture);
    }
    options.signal?.throwIfAborted();
    const provider = (source: typeof imagery, binding: SurfaceDatasetBinding | undefined) => source && binding
      ? new XyzImageryProvider({ id: `${body.id}-${tileGridKey(source.grid)}-${source.identity}`,
        grid: source.grid, urlTemplate: surfaceSourceUrl(resolveSurfaceUrl(binding.urlTemplate, binding.productUrl), source.grid, source.identity),
        addressing: binding.addressing ?? "xyz", attribution: binding.attribution, tileSize: source.tileSize, minZoom: 0, maxZoom: source.maximumZoom }) : undefined;
    const result: WorldSurfaceSource = { baseTexture, disposeBaseTexture: baseTexture !== options.baseTexture || options.disposeBaseTexture,
      nightTexture, disposeNightTexture: Boolean(nightTexture), baseFallback, workers: options.workers, surfaceModel,
      imageryProvider: provider(imagery, imageBinding), nightImageryProvider: provider(night, options.datasets.nightImagery),
      elevationProvider };
    if (baseTexture !== options.baseTexture && options.disposeBaseTexture) options.baseTexture.dispose();
    return result;
  } catch (error) { elevationProvider?.dispose(); for (const texture of owned) texture.dispose(); throw error; }
}
