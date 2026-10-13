import type { ElevationCacheOptions } from "@found-in-space/worlds/elevation-cache";
import { assertDevelopmentTileSource } from "./development-tile-policy.js";
import { boundProvider, type SessionConfiguration } from "./session-config.js";

export function elevationSourceOptions(config: SessionConfiguration): ElevationCacheOptions {
  const provider = boundProvider(config, "earthElevation");
  if (!provider) throw new Error("The session has no Earth elevation provider.");
  assertDevelopmentTileSource(provider.urlTemplate, {
    development: import.meta.env.DEV,
    allowDirectMapTiler: import.meta.env.PAS_DE_GEANT_DIRECT_MAPTILER_ALLOWED === true,
  });
  return { urlTemplate: provider.urlTemplate, addressing: provider.addressing };
}

export function earthElevationMaximumZoom(config: SessionConfiguration, productMaximumZoom: number): number {
  const provider = boundProvider(config, "earthElevation");
  if (!provider) throw new Error("The session has no Earth elevation provider.");
  return Math.min(productMaximumZoom, provider.maxZoom);
}
