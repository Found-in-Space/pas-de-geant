import type { XyzImageryConfiguration } from "@found-in-space/worlds/imagery-provider";
import { tileProxyUrlTemplate } from "@found-in-space/worlds/tile-proxy";
import { assertDevelopmentTileSource } from "./development-tile-policy.js";

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function imageryConfiguration(): XyzImageryConfiguration | undefined {
  if (window.__PAS_DE_GEANT_IMAGERY_CONFIG__) {
    return validateConfiguration(window.__PAS_DE_GEANT_IMAGERY_CONFIG__);
  }
  if (!import.meta.env.PAS_DE_GEANT_IMAGERY_CONFIGURED && !import.meta.env.VITE_IMAGERY_XYZ_TEMPLATE) return undefined;
  const attribution = import.meta.env.VITE_IMAGERY_ATTRIBUTION;
  if (!attribution) {
    console.warn(
      "VITE_IMAGERY_ATTRIBUTION is required when photographic imagery is configured.",
    );
    return undefined;
  }
  return validateConfiguration({
    id: import.meta.env.VITE_IMAGERY_PROVIDER_ID,
    urlTemplate: import.meta.env.VITE_IMAGERY_XYZ_TEMPLATE || tileProxyUrlTemplate("textures-source"),
    attribution,
    tileSize: optionalNumber(import.meta.env.VITE_IMAGERY_TILE_SIZE),
    minZoom: optionalNumber(import.meta.env.VITE_IMAGERY_MIN_ZOOM),
    maxZoom: optionalNumber(import.meta.env.VITE_IMAGERY_MAX_ZOOM),
  });
}

function validateConfiguration(configuration: XyzImageryConfiguration): XyzImageryConfiguration {
  assertDevelopmentTileSource(configuration.urlTemplate, {
    development: import.meta.env.DEV,
    allowDirectMapTiler: import.meta.env.PAS_DE_GEANT_DIRECT_MAPTILER_ALLOWED === true,
  });
  return configuration;
}
