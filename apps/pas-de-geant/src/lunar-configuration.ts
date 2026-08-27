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

export function lunarImageryProvider(): ImageryProvider | undefined {
  if (!import.meta.env.PAS_DE_GEANT_LUNAR_IMAGERY_CONFIGURED) return undefined;
  const configuration: XyzImageryConfiguration = {
    id: "lro-lunar-imagery",
    urlTemplate: tileProxyUrlTemplate("lunar-imagery"),
    attribution: "NASA LRO / LROC",
    tileSize: 512,
    minZoom: 0,
    maxZoom: MOON_SURFACE_MODEL.elevationMetadata.maxSourceZoom,
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
