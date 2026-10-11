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
  configuredXyzImageryProvider,
  type ImageryProvider,
  type XyzImageryConfiguration,
} from "@found-in-space/worlds/imagery-provider";
import { MOON_SURFACE_MODEL } from "@found-in-space/worlds/surface-model";
import { tileProxyUrlTemplate } from "@found-in-space/worlds/tile-proxy";
import { loadWorldBaseTexture, type WorldSurfaceSource } from "@found-in-space/worlds";
import type * as THREE from "three";
import { lunarBaseTextureUrl } from "./world-assets.js";

/** Source-wide linear-light curve used to keep WAC morphology legible. */
export const LUNAR_DISPLAY_TONE_EXPONENT = 0.55;

/** Public CDN configuration also works when deployed without the Vite proxy. */
export function lunarImageryUrlTemplate(): string {
  return import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_URL_TEMPLATE ||
    tileProxyUrlTemplate("lunar-imagery");
}

/** The main experience and the Moon demo use the same source and display choices. */
export async function lunarSurfaceSource(renderer: THREE.WebGLRenderer): Promise<WorldSurfaceSource> {
  const imageryProvider = lunarImageryProvider();
  const base = await loadWorldBaseTexture({
    sourceUrl: imageryProvider
      ? lunarImageryUrlTemplate().replaceAll("{z}", "0").replaceAll("{x}", "0").replaceAll("{y}", "0")
      : undefined,
    fallbackUrl: lunarBaseTextureUrl,
  });
  base.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return {
    baseTexture: base.texture,
    baseFallback: base.baseFallback,
    disposeBaseTexture: true,
    imageryProvider,
    elevationProvider: lunarElevationProvider(),
    surfaceModel: MOON_SURFACE_MODEL,
    albedoToneExponent: LUNAR_DISPLAY_TONE_EXPONENT,
  };
}

export function lunarImageryProvider(): ImageryProvider | undefined {
  if (!import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_CONFIGURED) return undefined;
  const configuredMaximumZoom = Number(
    import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_MAX_ZOOM,
  );
  const configuration: XyzImageryConfiguration = {
    id: "lro-lunar-imagery",
    urlTemplate: lunarImageryUrlTemplate(),
    attribution: "NASA/GSFC/Arizona State University; USGS Astrogeology",
    tileSize: 512,
    minZoom: 0,
    maxZoom: Number.isSafeInteger(configuredMaximumZoom) &&
        configuredMaximumZoom >= 0
      ? configuredMaximumZoom
      : 8,
  };
  return configuredXyzImageryProvider(configuration);
}

export function lunarElevationProvider(): TerrainElevationProvider {
  if (!import.meta.env.PAS_DE_GEANT_LUNAR_ELEVATION_CONFIGURED) {
    return new FlatElevationTileProvider(512);
  }
  const configuration: XyzElevationConfiguration = {
    urlTemplate: tileProxyUrlTemplate("lunar-elevation"),
  };
  return new ElevationTileProvider(
    createXyzElevationTileProvider(
      MOON_SURFACE_MODEL.elevationMetadata,
      MOON_SURFACE_MODEL.elevationMetadata.maxSourceZoom,
      configuration,
    ),
  );
}
