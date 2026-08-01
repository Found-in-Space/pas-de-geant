import type { XyzImageryConfiguration } from "./imagery-provider.js";

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function imageryConfiguration(): XyzImageryConfiguration | undefined {
  if (window.__PAS_DE_GEANT_IMAGERY_CONFIG__) {
    return window.__PAS_DE_GEANT_IMAGERY_CONFIG__;
  }
  const urlTemplate = import.meta.env.VITE_IMAGERY_XYZ_TEMPLATE;
  if (!urlTemplate) return undefined;
  const attribution = import.meta.env.VITE_IMAGERY_ATTRIBUTION;
  if (!attribution) {
    console.warn(
      "VITE_IMAGERY_ATTRIBUTION is required when photographic imagery is configured.",
    );
    return undefined;
  }
  return {
    id: import.meta.env.VITE_IMAGERY_PROVIDER_ID,
    urlTemplate,
    attribution,
    tileSize: optionalNumber(import.meta.env.VITE_IMAGERY_TILE_SIZE),
    minZoom: optionalNumber(import.meta.env.VITE_IMAGERY_MIN_ZOOM),
    maxZoom: optionalNumber(import.meta.env.VITE_IMAGERY_MAX_ZOOM),
  };
}
