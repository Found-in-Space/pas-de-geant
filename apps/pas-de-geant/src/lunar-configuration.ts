import { assertDevelopmentTileSource } from "./development-tile-policy.js";
import {
  ElevationTileProvider,
  FlatElevationTileProvider,
  type TerrainElevationProvider,
} from "@found-in-space/worlds/elevation-tile-provider";
import {
  createXyzElevationTileProvider,
  type XyzElevationConfiguration,
} from "@found-in-space/worlds/image-tile-provider";
import {
  XyzImageryProvider,
  type ImageryProvider,
  type XyzImageryConfiguration,
} from "@found-in-space/worlds/imagery-provider";
import { MOON_SURFACE_MODEL, MOON_GEOGRAPHIC_SURFACE_MODEL } from "@found-in-space/worlds/surface-model";
import { tileUrl } from "@found-in-space/worlds/tile-url";
import { loadWorldBaseTexture, type WorldSurfaceSource } from "@found-in-space/worlds";
import { displayTextureSource, elevationSource, requireCompatibleSurfaceSources,
  type DisplayTextureSource, type ElevationSource } from "@found-in-space/worlds/surface-product";
import { surfaceSourceUrl, tileGridKey } from "@found-in-space/worlds/tile-grid";
import { celestialBody } from "@found-in-space/worlds/solar-system";
import type * as THREE from "three";
import { lunarBaseTextureUrl } from "./world-assets.js";
import { loadLunarImageryProviders } from "./lunar-imagery-providers.js";
import { boundProvider, type SessionConfiguration } from "./session-config.js";

/** Source-wide linear-light curve used to keep WAC morphology legible. */
export const LUNAR_DISPLAY_TONE_EXPONENT = 0.55;

async function admittedProduct<T>(url: string, admit: (value: unknown) => T): Promise<T | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Source descriptor: HTTP ${response.status}`);
    return admit(await response.json());
  } catch (error) {
    // A descriptor failure leaves a usable base; unidentified tile bytes are
    // never interpreted against a guessed grid.
    console.warn("Lunar source could not be admitted:", error);
    return undefined;
  }
}

/** The main experience and the Moon demo use the same admitted source grids. */
export async function lunarSurfaceSource(renderer: THREE.WebGLRenderer, session: SessionConfiguration, options: { readonly preview?: boolean } = {}): Promise<WorldSurfaceSource> {
  const body = celestialBody("moon");
  const imageryProviderConfig = boundProvider(session, "moonImagery");
  const elevationProviderConfig = boundProvider(session, "moonElevation");
  const apolloProviderConfig = boundProvider(session, "apolloImagery");
  const imageryUrl = imageryProviderConfig?.productUrl;
  const [imagery, elevation] = await Promise.all([
    imageryUrl
      ? admittedProduct(imageryUrl, (value) => displayTextureSource(value, body)) : undefined,
    elevationProviderConfig?.productUrl
      ? admittedProduct(elevationProviderConfig.productUrl,
          (value) => elevationSource(value, body)) : undefined,
  ]);
  requireCompatibleSurfaceSources(imagery, elevation);
  const core = imagery && imageryProviderConfig ? lunarImageryProvider(imagery, imageryProviderConfig) : undefined;
  if (options.preview && !core) throw new Error("Apollo imagery requires an admitted global lunar source.");
  if (options.preview && !apolloProviderConfig?.productUrl) throw new Error("The session has no prepared Apollo imagery provider.");
  const imageryProvider = options.preview
    ? await loadLunarImageryProviders(core!, apolloProviderConfig!.productUrl!, apolloProviderConfig!.addressing) : core;
  const grid = imagery?.grid ?? elevation?.grid;
  const model = grid?.projection === "geographic" ? MOON_GEOGRAPHIC_SURFACE_MODEL : MOON_SURFACE_MODEL;
  const base = await loadWorldBaseTexture({
    sourceUrl: imagery && imageryProviderConfig ? surfaceSourceUrl(imagery.formatVersion === 1
      ? tileUrl(imageryProviderConfig.urlTemplate, imageryProviderConfig.addressing, { z: 0, x: 0, y: 0 })
      : new URL(imagery.basePath, imageryUrl).href, imagery.grid, imagery.identity) : undefined,
    fallbackUrl: lunarBaseTextureUrl,
  });
  base.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return {
    baseTexture: base.texture,
    baseFallback: base.baseFallback || Boolean(imageryProviderConfig && !imagery),
    disposeBaseTexture: true,
    imageryProvider,
    elevationProvider: lunarElevationProvider(elevation, elevationProviderConfig),
    surfaceModel: Object.freeze({ ...model,
      heightEncoding: elevation?.heightEncoding ?? model.heightEncoding,
      elevationMetadata: elevation?.metadata ?? { tilePixels: 512, maxSourceZoom: 0,
        attribution: "Lunar reference surface", elevationBoundsMetres: { minimum: 0, maximum: 0 } },
    }),
    albedoToneExponent: LUNAR_DISPLAY_TONE_EXPONENT,
  };
}

export function lunarImageryProvider(source: DisplayTextureSource, provider: NonNullable<ReturnType<typeof boundProvider>>): ImageryProvider {
  const configuration: XyzImageryConfiguration = {
    id: `lro-lunar-imagery-${tileGridKey(source.grid)}-${source.identity}`,
    grid: source.grid,
    urlTemplate: surfaceSourceUrl(provider.urlTemplate, source.grid, source.identity),
    addressing: provider.addressing,
    attribution: provider.attribution,
    tileSize: source.tileSize,
    minZoom: Math.max(provider.minZoom, 0),
    maxZoom: Math.min(provider.maxZoom, source.maximumZoom),
  };
  assertDevelopmentTileSource(configuration.urlTemplate, { development: import.meta.env.DEV, allowDirectMapTiler: import.meta.env.PAS_DE_GEANT_DIRECT_MAPTILER_ALLOWED === true });
  return new XyzImageryProvider(configuration);
}

export function lunarElevationProvider(source?: ElevationSource, provider?: NonNullable<ReturnType<typeof boundProvider>>): TerrainElevationProvider {
  if (!source) {
    return new FlatElevationTileProvider(512);
  }
  if (!provider) throw new Error("The session has no lunar elevation provider.");
  const configuration: XyzElevationConfiguration = {
    urlTemplate: surfaceSourceUrl(provider.urlTemplate, source.grid, source.identity),
    addressing: provider.addressing,
    availability: source.availability,
  };
  assertDevelopmentTileSource(configuration.urlTemplate, { development: import.meta.env.DEV, allowDirectMapTiler: import.meta.env.PAS_DE_GEANT_DIRECT_MAPTILER_ALLOWED === true });
  return new ElevationTileProvider(
    createXyzElevationTileProvider(
      source.metadata,
      Math.min(source.metadata.maxSourceZoom, provider.maxZoom),
      configuration,
    ),
    { missingTile: "failure" },
  );
}
