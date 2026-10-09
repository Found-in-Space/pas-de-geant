import {
  ElevationTileProvider,
  FlatElevationTileProvider,
  type TerrainElevationProvider,
} from "./elevation-tile-provider.js";
import {
  createXyzElevationTileProvider,
  type XyzElevationConfiguration,
} from "./image-tile-provider.js";
import {
  configuredXyzImageryProvider,
  type ImageryProvider,
  type XyzImageryConfiguration,
} from "./imagery-provider.js";
import { MOON_SURFACE_MODEL } from "./surface-model.js";
import { tileProxyUrlTemplate } from "./tile-proxy.js";

/** Source-wide linear-light curve used to keep WAC morphology legible. */
export const LUNAR_DISPLAY_TONE_EXPONENT = 0.55;

export function lunarImageryProvider(): ImageryProvider | undefined {
  if (!import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_CONFIGURED) return undefined;
  const configuredMaximumZoom = Number(
    import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_MAX_ZOOM,
  );
  const configuration: XyzImageryConfiguration = {
    id: "lro-lunar-imagery",
    urlTemplate: tileProxyUrlTemplate("lunar-imagery"),
    attribution: "NASA LRO / LROC",
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
