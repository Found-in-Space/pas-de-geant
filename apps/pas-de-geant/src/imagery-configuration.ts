import type { XyzImageryConfiguration } from "@found-in-space/pas-de-geant/worlds";
import { assertDevelopmentTileSource } from "./development-tile-policy.js";
import { selectImageryVariant } from "./imagery-variants.js";
import type { SessionConfiguration } from "./session-config.js";

export function imageryConfiguration(config: SessionConfiguration, variant?: string | null): XyzImageryConfiguration | undefined {
  const id = selectImageryVariant(config, variant);
  if (!id) return undefined;
  const provider = config.providers[id]!;
  assertDevelopmentTileSource(provider.urlTemplate, {
    development: import.meta.env.DEV,
    allowDirectMapTiler: import.meta.env.PAS_DE_GEANT_DIRECT_MAPTILER_ALLOWED === true,
  });
  return {
    id,
    urlTemplate: provider.urlTemplate,
    addressing: provider.addressing,
    attribution: provider.attribution,
    tileSize: provider.tileSize,
    minZoom: provider.minZoom,
    maxZoom: provider.maxZoom,
  };
}
