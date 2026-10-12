export const DIRECT_MAPTILER_OVERRIDE = "I_ACCEPT_MAPTILER_RATE_LIMIT_RISK";

export interface DevelopmentTilePolicy {
  readonly development: boolean;
  readonly allowDirectMapTiler?: boolean;
}

export function assertDevelopmentTileSource(template: string, policy: DevelopmentTilePolicy): void {
  if (!policy.development || policy.allowDirectMapTiler) return;
  let hostname: string;
  try { hostname = new URL(template, "http://local").hostname; } catch { return; }
  if (hostname === "maptiler.com" || hostname.endsWith(".maptiler.com")) {
    throw new Error(
      "Direct MapTiler requests are disabled in development. Configure the tile cache; " +
      "it is never bypassed automatically. A deliberate override requires " +
      "PAS_DE_GEANT_ALLOW_DIRECT_MAPTILER=I_ACCEPT_MAPTILER_RATE_LIMIT_RISK.",
    );
  }
}

export function assertDevelopmentPublicTileSources(
  environment: Record<string, string | undefined>,
  policy: DevelopmentTilePolicy,
): void {
  for (const [name, value] of Object.entries(environment)) {
    if (value && (name.startsWith("VITE_") ||
      /^PAS_DE_GEANT_LUNAR_.*(?:URL|URL_TEMPLATE)$/.test(name))) {
      assertDevelopmentTileSource(value, policy);
    }
  }
}
