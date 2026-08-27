import type { XyzImageryConfiguration } from "./imagery-provider.js";
import type { TileIdentity } from "./tile-transition-planner.js";

export const TILE_PROXY_PATH = "/api/tiles";
const TILE_PROXY_PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/;

function validatedProviderId(provider: string): string {
  if (!TILE_PROXY_PROVIDER_ID.test(provider)) {
    throw new Error(
      "Tile proxy provider IDs must contain lowercase letters, digits, hyphens, or underscores.",
    );
  }
  return provider;
}

export function tileProxyUrlTemplate(provider: string): string {
  return `${TILE_PROXY_PATH}/${validatedProviderId(provider)}/{z}/{x}/{y}`;
}

export function tileProxyUrl(
  provider: string,
  address: TileIdentity,
): string {
  const prefix = `${TILE_PROXY_PATH}/${validatedProviderId(provider)}`;
  return `${prefix}/${address.z}/${address.x}/${address.y}`;
}

/** Routes configured XYZ imagery through a canonical cached provider. */
export function proxiedTileConfiguration(
  configuration: XyzImageryConfiguration,
  provider: string,
): XyzImageryConfiguration {
  return {
    ...configuration,
    urlTemplate: tileProxyUrlTemplate(provider),
  };
}
