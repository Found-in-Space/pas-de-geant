import type { SessionConfiguration } from "./session-config.js";

export const MAPTILER_IMAGERY_VARIANT_PARAMETER = "imageryVariant";

export type MapTilerImageryVariant = "maptiler-512" | "maptiler-256";
export const MAPTILER_512_VARIANT: MapTilerImageryVariant = "maptiler-512";
export const MAPTILER_256_VARIANT: MapTilerImageryVariant = "maptiler-256";

export function selectedMapTilerImageryVariant(requested: string | null | undefined): MapTilerImageryVariant {
  return requested === MAPTILER_512_VARIANT ? MAPTILER_512_VARIANT : MAPTILER_256_VARIANT;
}

/** Variants are independent providers; their URLs and metadata come from the session. */
export function selectImageryVariant(config: SessionConfiguration, requested: string | null | undefined): string | undefined {
  const variant = selectedMapTilerImageryVariant(requested);
  return config.bindings.earthImageryVariants?.[variant] ?? config.bindings.earthImagery;
}
