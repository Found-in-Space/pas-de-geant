import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { descriptorTileTemplate, parseSessionConfiguration, type SessionBindings, type SessionConfiguration, type SessionTileProvider } from "./session-config.js";
import type { LocalTileProduct } from "./local-tile-server.js";
import { assertDevelopmentTileSource, DIRECT_MAPTILER_OVERRIDE } from "./development-tile-policy.js";

interface ProviderOverride extends Partial<SessionTileProvider> {
  readonly cacheProvider?: string;
  readonly localRoot?: string;
  readonly localTilePathTemplate?: string;
}

export interface DevelopmentSessionSettings {
  readonly cacheBaseUrl?: string;
  readonly providers?: Readonly<Record<string, ProviderOverride>>;
  readonly bindings?: Partial<SessionBindings>;
}

function number(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value && Number.isSafeInteger(parsed) ? parsed : fallback;
}

function cacheTemplate(base: string, provider: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider)) throw new Error("Invalid cache provider name.");
  const endpoint = new URL(base);
  if (!/https?:/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("The development cache must be a browser-usable HTTP(S) origin without credentials.");
  }
  return descriptorTileTemplate(`/api/tiles/${provider}/{z}/{x}/{y}`, endpoint.href);
}

function localTemplate(id: string, path: string): string {
  if (path.startsWith("/") || path.split("/").includes("..")) throw new Error("Local tile paths must stay inside their product root.");
  return `/_local-tiles/${id}/${path}`;
}

export async function readDevelopmentSessionSettings(appDirectory: string): Promise<DevelopmentSessionSettings> {
  try {
    return JSON.parse(await readFile(resolve(appDirectory, "session-config.local.json"), "utf8")) as DevelopmentSessionSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function compileDevelopmentSession(
  environment: Record<string, string | undefined>,
  appDirectory: string,
  settings: DevelopmentSessionSettings = {},
): { config: SessionConfiguration; localProducts: Readonly<Record<string, LocalTileProduct>> } {
  const cacheBase = settings.cacheBaseUrl || environment.PAS_DE_GEANT_TILE_CACHE_URL;
  if (!cacheBase) throw new Error("Set PAS_DE_GEANT_TILE_CACHE_URL in local settings for development.");
  const earthAttribution = environment.VITE_IMAGERY_ATTRIBUTION || "Configured satellite imagery";
  const earthZoom = number(environment.VITE_IMAGERY_MAX_ZOOM, 22);
  const earthMinimumZoom = number(environment.VITE_IMAGERY_MIN_ZOOM, 0);
  const providers: Record<string, SessionTileProvider> = {
    "earth-imagery-512": {
      urlTemplate: cacheTemplate(cacheBase, "textures-source"), addressing: "xyz",
      attribution: earthAttribution, tileSize: number(environment.VITE_IMAGERY_TILE_SIZE, 512),
      minZoom: earthMinimumZoom, maxZoom: earthZoom,
    },
    "earth-imagery-256": {
      urlTemplate: cacheTemplate(cacheBase, "textures"), addressing: "xyz",
      attribution: earthAttribution, tileSize: 256,
      minZoom: earthMinimumZoom, maxZoom: earthZoom,
    },
    "earth-elevation": {
      urlTemplate: cacheTemplate(cacheBase, "elevation"), addressing: "xyz",
      attribution: "Mapterhorn · Terrarium elevation tiles", tileSize: 512,
      minZoom: 0, maxZoom: 12,
    },
  };
  const bindings: { -readonly [K in keyof SessionBindings]: SessionBindings[K] } = {
    earthImagery: "earth-imagery-256",
    earthImageryVariants: { "maptiler-256": "earth-imagery-256", "maptiler-512": "earth-imagery-512" },
    earthElevation: "earth-elevation",
  };
  const localProducts: Record<string, LocalTileProduct> = {};
  const local = (id: string, root: string, tilePathTemplate: string, metadata: Omit<SessionTileProvider, "urlTemplate" | "productUrl">) => {
    localProducts[id] = { root: resolve(appDirectory, root), tilePathTemplate };
    providers[id] = {
      ...metadata,
      urlTemplate: localTemplate(id, tilePathTemplate),
      productUrl: `/_local-tiles/${id}/product.json`,
    };
  };
  if (environment.VITE_IMAGERY_XYZ_TEMPLATE) {
    providers["earth-imagery-512"] = { ...providers["earth-imagery-512"]!, urlTemplate: environment.VITE_IMAGERY_XYZ_TEMPLATE };
  }
  const lunarImageryRoot = environment.PAS_DE_GEANT_LUNAR_IMAGERY_DIRECTORY;
  if (lunarImageryRoot) {
    local("moon-global", dirname(resolve(appDirectory, lunarImageryRoot)), "imagery/{z}/{x}/{y}.png", {
      addressing: "xyz", attribution: "NASA/GSFC/Arizona State University; USGS Astrogeology",
      tileSize: 512, minZoom: 0, maxZoom: number(environment.PAS_DE_GEANT_LUNAR_IMAGERY_MAX_ZOOM, 8),
    });
    bindings.moonImagery = "moon-global";
  } else if (environment.PAS_DE_GEANT_LUNAR_IMAGERY_URL_TEMPLATE) {
    const template = environment.PAS_DE_GEANT_LUNAR_IMAGERY_URL_TEMPLATE;
    const productUrl = environment.PAS_DE_GEANT_LUNAR_IMAGERY_PRODUCT_URL;
    if (!productUrl) throw new Error("A hosted Moon imagery provider needs an explicit product descriptor URL.");
    providers["moon-global"] = {
      urlTemplate: template, addressing: "xyz", attribution: "NASA/GSFC/Arizona State University; USGS Astrogeology",
      tileSize: 512, minZoom: 0, maxZoom: number(environment.PAS_DE_GEANT_LUNAR_IMAGERY_MAX_ZOOM, 8),
      productUrl,
    };
    bindings.moonImagery = "moon-global";
  }
  if (environment.PAS_DE_GEANT_LUNAR_ELEVATION_DIRECTORY) {
    local("moon-elevation", environment.PAS_DE_GEANT_LUNAR_ELEVATION_DIRECTORY, "{z}/{x}/{y}.png", {
      addressing: "xyz", attribution: "NASA LRO / LOLA", tileSize: 512, minZoom: 0, maxZoom: 15,
    });
    bindings.moonElevation = "moon-elevation";
  } else if (environment.PAS_DE_GEANT_LUNAR_ELEVATION_URL_TEMPLATE && environment.PAS_DE_GEANT_LUNAR_ELEVATION_PRODUCT_URL) {
    providers["moon-elevation"] = {
      urlTemplate: environment.PAS_DE_GEANT_LUNAR_ELEVATION_URL_TEMPLATE, addressing: "xyz",
      attribution: "NASA LRO / LOLA", tileSize: 512, minZoom: 0, maxZoom: 15,
      productUrl: environment.PAS_DE_GEANT_LUNAR_ELEVATION_PRODUCT_URL,
    };
    bindings.moonElevation = "moon-elevation";
  }
  const apolloRoot = environment.PAS_DE_GEANT_LUNAR_RUNTIME_DIRECTORY ||
    (environment.PAS_DE_GEANT_LUNAR_PREVIEW_DIRECTORY ? resolve(appDirectory, environment.PAS_DE_GEANT_LUNAR_PREVIEW_DIRECTORY, "runtime") : undefined);
  if (apolloRoot) {
    local("apollo-prepared", apolloRoot, "{source}/{z}/{x}/{y}.png", {
      addressing: "xyz", attribution: "NASA LRO / LROC", tileSize: 512, minZoom: 0, maxZoom: 18,
    });
    bindings.apolloImagery = "apollo-prepared";
  }
  for (const [id, override] of Object.entries(settings.providers ?? {})) {
    const current = providers[id];
    const { cacheProvider, localRoot, localTilePathTemplate, ...publicFields } = override;
    const fields: { -readonly [K in keyof SessionTileProvider]?: SessionTileProvider[K] } = { ...publicFields };
    if (cacheProvider) fields.urlTemplate = cacheTemplate(cacheBase, cacheProvider);
    if (localRoot) {
      const pathTemplate = localTilePathTemplate || localProducts[id]?.tilePathTemplate || "{z}/{x}/{y}.png";
      localProducts[id] = { root: resolve(appDirectory, localRoot), tilePathTemplate: pathTemplate };
      fields.urlTemplate = localTemplate(id, pathTemplate);
      fields.productUrl = `/_local-tiles/${id}/product.json`;
    } else if (fields.urlTemplate || cacheProvider) {
      delete localProducts[id];
      if (current?.productUrl && fields.productUrl === undefined) fields.productUrl = undefined;
    }
    providers[id] = { ...current, ...fields } as SessionTileProvider;
  }
  const config = parseSessionConfiguration({
    formatVersion: 1, providers,
    bindings: { ...bindings, ...settings.bindings },
  });
  for (const item of Object.values(config.providers)) {
    assertDevelopmentTileSource(item.urlTemplate, {
      development: true,
      allowDirectMapTiler: environment.PAS_DE_GEANT_ALLOW_DIRECT_MAPTILER === DIRECT_MAPTILER_OVERRIDE,
    });
  }
  return { config, localProducts };
}
