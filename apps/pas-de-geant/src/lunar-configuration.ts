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
import { tileProxyUrlTemplate } from "@found-in-space/worlds/tile-proxy";
import { loadWorldBaseTexture, type WorldSurfaceSource } from "@found-in-space/worlds";
import { displayTextureSource, elevationSource, requireCompatibleSurfaceSources,
  type DisplayTextureSource, type ElevationSource } from "@found-in-space/worlds/surface-product";
import { surfaceSourceUrl, tileGridKey } from "@found-in-space/worlds/tile-grid";
import { celestialBody } from "@found-in-space/worlds/solar-system";
import type * as THREE from "three";
import { lunarBaseTextureUrl } from "./world-assets.js";
import { loadLunarImageryProviders } from "./lunar-imagery-providers.js";

/** Source-wide linear-light curve used to keep WAC morphology legible. */
export const LUNAR_DISPLAY_TONE_EXPONENT = 0.55;

/** Public CDN configuration also works when deployed without the Vite proxy. */
export function lunarImageryUrlTemplate(): string {
  return import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_URL_TEMPLATE ||
    tileProxyUrlTemplate("lunar-imagery");
}

function imageryProductUrl(): string {
  const explicit = import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_PRODUCT_URL;
  if (explicit) return explicit;
  const template = lunarImageryUrlTemplate();
  return template.endsWith("/imagery/{z}/{x}/{y}.png")
    ? template.replace("/imagery/{z}/{x}/{y}.png", "/product.json")
    : "/api/tiles/lunar-imagery/product.json";
}

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
export async function lunarSurfaceSource(renderer: THREE.WebGLRenderer, options: { readonly preview?: boolean } = {}): Promise<WorldSurfaceSource> {
  const body = celestialBody("moon");
  const imageryUrl = imageryProductUrl();
  const [imagery, elevation] = await Promise.all([
    import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_CONFIGURED
      ? admittedProduct(imageryUrl, (value) => displayTextureSource(value, body)) : undefined,
    import.meta.env.PAS_DE_GEANT_LUNAR_ELEVATION_CONFIGURED
      ? admittedProduct(import.meta.env.PAS_DE_GEANT_LUNAR_ELEVATION_PRODUCT_URL || "/api/tiles/lunar-elevation/product.json",
          (value) => elevationSource(value, body)) : undefined,
  ]);
  requireCompatibleSurfaceSources(imagery, elevation);
  const core = imagery ? lunarImageryProvider(imagery) : undefined;
  if (options.preview && !core) throw new Error("Apollo imagery requires an admitted global lunar source.");
  const imageryProvider = options.preview ? await loadLunarImageryProviders(core!) : core;
  const grid = imagery?.grid ?? elevation?.grid;
  const model = grid?.projection === "geographic" ? MOON_GEOGRAPHIC_SURFACE_MODEL : MOON_SURFACE_MODEL;
  const base = await loadWorldBaseTexture({
    sourceUrl: imagery ? surfaceSourceUrl(imagery.formatVersion === 1
      ? lunarImageryUrlTemplate().replaceAll("{z}", "0").replaceAll("{x}", "0").replaceAll("{y}", "0")
      : new URL(imagery.basePath, new URL(imageryUrl, window.location.href)).href, imagery.grid, imagery.identity) : undefined,
    fallbackUrl: lunarBaseTextureUrl,
  });
  base.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return {
    baseTexture: base.texture,
    baseFallback: base.baseFallback || Boolean(import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_CONFIGURED && !imagery),
    disposeBaseTexture: true,
    imageryProvider,
    elevationProvider: lunarElevationProvider(elevation),
    surfaceModel: Object.freeze({ ...model,
      heightEncoding: elevation?.heightEncoding ?? model.heightEncoding,
      elevationMetadata: elevation?.metadata ?? { tilePixels: 512, maxSourceZoom: 0,
        attribution: "Lunar reference surface", elevationBoundsMetres: { minimum: 0, maximum: 0 } },
    }),
    albedoToneExponent: LUNAR_DISPLAY_TONE_EXPONENT,
  };
}

export function lunarImageryProvider(source: DisplayTextureSource): ImageryProvider {
  const configuredMaximumZoom = Number(
    import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_MAX_ZOOM,
  );
  const configuration: XyzImageryConfiguration = {
    id: `lro-lunar-imagery-${tileGridKey(source.grid)}-${source.identity}`,
    grid: source.grid,
    urlTemplate: surfaceSourceUrl(lunarImageryUrlTemplate(), source.grid, source.identity),
    attribution: "NASA/GSFC/Arizona State University; USGS Astrogeology",
    tileSize: source.tileSize,
    minZoom: 0,
    maxZoom: Number.isSafeInteger(configuredMaximumZoom) &&
        configuredMaximumZoom >= 0
      ? Math.min(configuredMaximumZoom, source.maximumZoom)
      : source.maximumZoom,
  };
  assertDevelopmentTileSource(configuration.urlTemplate, { development: import.meta.env.DEV, allowDirectMapTiler: import.meta.env.PAS_DE_GEANT_DIRECT_MAPTILER_ALLOWED === true });
  return new XyzImageryProvider(configuration);
}

export function lunarElevationProvider(source?: ElevationSource): TerrainElevationProvider {
  if (!source) {
    return new FlatElevationTileProvider(512);
  }
  const configuration: XyzElevationConfiguration = {
    urlTemplate: surfaceSourceUrl(import.meta.env.PAS_DE_GEANT_LUNAR_ELEVATION_URL_TEMPLATE || tileProxyUrlTemplate("lunar-elevation"), source.grid, source.identity),
    availability: source.availability,
  };
  assertDevelopmentTileSource(configuration.urlTemplate, { development: import.meta.env.DEV, allowDirectMapTiler: import.meta.env.PAS_DE_GEANT_DIRECT_MAPTILER_ALLOWED === true });
  return new ElevationTileProvider(
    createXyzElevationTileProvider(
      source.metadata,
      source.metadata.maxSourceZoom,
      configuration,
    ),
    { missingTile: "failure" },
  );
}
