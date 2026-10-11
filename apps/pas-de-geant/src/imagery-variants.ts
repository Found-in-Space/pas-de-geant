import type { XyzImageryConfiguration } from "@found-in-space/worlds/imagery-provider";
import { tileProxyUrlTemplate } from "@found-in-space/worlds/tile-proxy";

export const MAPTILER_IMAGERY_VARIANT_PARAMETER = "imageryVariant";

export type MapTilerImageryVariant = "maptiler-512" | "maptiler-256";

export const MAPTILER_512_VARIANT: MapTilerImageryVariant = "maptiler-512";
export const MAPTILER_256_VARIANT: MapTilerImageryVariant = "maptiler-256";
const MAPTILER_SATELLITE_V2_PATH =
  /^\/tiles\/satellite-v2\/\{z\}\/\{x\}\/\{y\}(?:\.(?:jpe?g|png|webp))?\/?$/i;
const MAPTILER_SATELLITE_V2_PROVIDER_ID = "maptiler-satellite-v2";

function configuredMapTilerSatelliteUrl(
  configuration: XyzImageryConfiguration,
): URL | undefined {
  try {
    const configuredUrl = new URL(configuration.urlTemplate);
    return configuredUrl.protocol === "https:" &&
        configuredUrl.hostname === "api.maptiler.com" &&
        MAPTILER_SATELLITE_V2_PATH.test(
          decodeURIComponent(configuredUrl.pathname),
        )
      ? configuredUrl
      : undefined;
  } catch {
    return undefined;
  }
}

export function selectedMapTilerImageryVariant(
  requestedVariant: string | null | undefined,
): MapTilerImageryVariant {
  return requestedVariant === MAPTILER_512_VARIANT
    ? MAPTILER_512_VARIANT
    : MAPTILER_256_VARIANT;
}

/**
 * Derives the 256 px Satellite Plain endpoint from the configured raw
 * MapTiler source, retaining its query string (including the existing key).
 * Other providers and unknown experiment values deliberately pass through.
 */
export function selectImageryVariant(
  configuration: XyzImageryConfiguration,
  requestedVariant: string | null | undefined,
): XyzImageryConfiguration {
  if (
    selectedMapTilerImageryVariant(requestedVariant) !== MAPTILER_256_VARIANT
  ) return configuration;

  const configuredUrl = configuredMapTilerSatelliteUrl(configuration);
  const cachedSource =
    configuration.id?.trim().toLowerCase() ===
      MAPTILER_SATELLITE_V2_PROVIDER_ID &&
    configuration.urlTemplate === tileProxyUrlTemplate("textures-source");
  if (!configuredUrl && !cachedSource) return configuration;
  return {
    ...configuration,
    id: `${configuration.id?.trim() || "configured-xyz"}:maptiler-satellite-v4-256`,
    urlTemplate: configuredUrl
      ? `${configuredUrl.origin}/maps/satellite-v4/256/{z}/{x}/{y}.jpg` +
        configuredUrl.search + configuredUrl.hash
      : tileProxyUrlTemplate("textures"),
    tileSize: 256,
  };
}
