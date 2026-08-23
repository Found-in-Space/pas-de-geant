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

function template(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function lunarImageryProvider(): ImageryProvider | undefined {
  const urlTemplate = template(import.meta.env.VITE_LUNAR_IMAGERY_XYZ_TEMPLATE);
  if (!urlTemplate) return undefined;
  const configuration: XyzImageryConfiguration = {
    id: "lro-lunar-imagery",
    urlTemplate,
    attribution: "NASA LRO / LROC",
    tileSize: 512,
    minZoom: 0,
    maxZoom: MOON_SURFACE_MODEL.elevationMetadata.maxSourceZoom,
  };
  return configuredXyzImageryProvider(configuration);
}

export function lunarElevationProvider(): TerrainElevationProvider {
  const urlTemplate = template(import.meta.env.VITE_LUNAR_ELEVATION_XYZ_TEMPLATE);
  if (!urlTemplate) return new FlatElevationTileProvider(512);
  const configuration: XyzElevationConfiguration = { urlTemplate };
  return new ElevationTileProvider(
    createXyzElevationTileProvider(
      MOON_SURFACE_MODEL.elevationMetadata,
      MOON_SURFACE_MODEL.elevationMetadata.maxSourceZoom,
      configuration,
    ),
  );
}
