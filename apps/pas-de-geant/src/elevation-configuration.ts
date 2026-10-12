import { tileProxyUrlTemplate } from "@found-in-space/worlds/tile-proxy";
import type { ElevationCacheOptions } from "@found-in-space/worlds/elevation-cache";
import { assertDevelopmentTileSource } from "./development-tile-policy.js";

export function elevationSourceOptions(): ElevationCacheOptions {
  const urlTemplate = import.meta.env.VITE_ELEVATION_XYZ_TEMPLATE || tileProxyUrlTemplate("elevation");
  assertDevelopmentTileSource(urlTemplate, {
    development: import.meta.env.DEV,
    allowDirectMapTiler: import.meta.env.PAS_DE_GEANT_DIRECT_MAPTILER_ALLOWED === true,
  });
  return { urlTemplate };
}
