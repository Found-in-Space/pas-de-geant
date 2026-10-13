import type { TileAddressing } from "@found-in-space/worlds/tile-url";

export interface SessionTileProvider {
  readonly urlTemplate: string;
  readonly addressing: TileAddressing;
  readonly attribution: string;
  readonly tileSize: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly bounds?: readonly [number, number, number, number];
  readonly productUrl?: string;
}

export interface SessionBindings {
  readonly earthImagery?: string;
  readonly earthImageryVariants?: Readonly<Record<string, string>>;
  readonly earthElevation?: string;
  readonly moonImagery?: string;
  readonly moonElevation?: string;
  readonly apolloImagery?: string;
}

export interface SessionConfiguration {
  readonly formatVersion: 1;
  readonly providers: Readonly<Record<string, SessionTileProvider>>;
  readonly bindings: SessionBindings;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function provider(value: unknown, id: string): SessionTileProvider {
  if (!object(value) || typeof value.urlTemplate !== "string" ||
      !["xyz", "tms"].includes(String(value.addressing)) ||
      typeof value.attribution !== "string" || !value.attribution.trim() ||
      !Number.isSafeInteger(value.tileSize) || Number(value.tileSize) <= 0 ||
      !Number.isSafeInteger(value.minZoom) || Number(value.minZoom) < 0 ||
      !Number.isSafeInteger(value.maxZoom) || Number(value.maxZoom) < Number(value.minZoom) ||
      !["{z}", "{x}", "{y}"].every(token => String(value.urlTemplate).includes(token)) ||
      (value.productUrl !== undefined && typeof value.productUrl !== "string")) {
    throw new Error(`Invalid tile provider ${id} in session-config.json.`);
  }
  if (value.bounds !== undefined && (!Array.isArray(value.bounds) || value.bounds.length !== 4 ||
      !value.bounds.every(item => typeof item === "number" && Number.isFinite(item)))) {
    throw new Error(`Invalid coverage bounds for tile provider ${id}.`);
  }
  return value as unknown as SessionTileProvider;
}

export function parseSessionConfiguration(value: unknown): SessionConfiguration {
  if (!object(value) || value.formatVersion !== 1 || !object(value.providers) || !object(value.bindings)) {
    throw new Error("Unsupported session-config.json format.");
  }
  const providers: Record<string, SessionTileProvider> = {};
  for (const [id, item] of Object.entries(value.providers)) {
    if (!PROVIDER_ID.test(id)) throw new Error(`Invalid tile provider ID: ${id}.`);
    providers[id] = provider(item, id);
  }
  const bindings = value.bindings as Record<string, unknown>;
  for (const name of ["earthImagery", "earthElevation", "moonImagery", "moonElevation", "apolloImagery"]) {
    const id = bindings[name];
    if (id !== undefined && (typeof id !== "string" || !providers[id])) {
      throw new Error(`Session binding ${name} refers to an unknown provider.`);
    }
  }
  if (bindings.earthImageryVariants !== undefined) {
    if (!object(bindings.earthImageryVariants)) throw new Error("Invalid Earth imagery variants.");
    for (const id of Object.values(bindings.earthImageryVariants)) {
      if (typeof id !== "string" || !providers[id]) throw new Error("Earth imagery variant refers to an unknown provider.");
    }
  }
  for (const name of ["moonImagery", "moonElevation", "apolloImagery"]) {
    const id = bindings[name];
    if (typeof id === "string" && !providers[id]!.productUrl) {
      throw new Error(`Session binding ${name} needs a product descriptor URL.`);
    }
  }
  return { formatVersion: 1, providers, bindings: bindings as SessionBindings };
}

export function boundProvider(config: SessionConfiguration, name: keyof Omit<SessionBindings, "earthImageryVariants">): SessionTileProvider | undefined {
  const id = config.bindings[name];
  return id ? config.providers[id] : undefined;
}

export function boundProviderId(config: SessionConfiguration, name: keyof Omit<SessionBindings, "earthImageryVariants">): string | undefined {
  return config.bindings[name];
}

/** Both Vite source modules and built assets live one directory below the app base. */
export function sessionConfigurationUrl(moduleUrl: string): string {
  return new URL("../" + "session-config.json", moduleUrl).href;
}

/** A product's relative tile path is authoritative; URL parsing must retain tile tokens. */
export function descriptorTileTemplate(pathTemplate: string, productUrl: string): string {
  const tokens: Readonly<Record<string, string>> = { "{z}": "__TILE_Z__", "{x}": "__TILE_X__", "{y}": "__TILE_Y__", "{source}": "__TILE_SOURCE__" };
  let path = pathTemplate;
  for (const [token, marker] of Object.entries(tokens)) path = path.replaceAll(token, marker);
  let url = new URL(path, productUrl).href;
  for (const [token, marker] of Object.entries(tokens)) url = url.replaceAll(marker, token);
  return url;
}

export function resolveSessionUrls(config: SessionConfiguration, configUrl: string): SessionConfiguration {
  return {
    ...config,
    providers: Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => [id, {
      ...provider,
      urlTemplate: descriptorTileTemplate(provider.urlTemplate, configUrl),
      ...(provider.productUrl ? { productUrl: new URL(provider.productUrl, configUrl).href } : {}),
    }])),
  };
}

let pending: Promise<SessionConfiguration> | undefined;

export function loadSessionConfiguration(): Promise<SessionConfiguration> {
  pending ??= (async () => {
    const url = sessionConfigurationUrl(import.meta.url);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Session configuration unavailable (HTTP ${response.status}).`);
    return resolveSessionUrls(parseSessionConfiguration(await response.json()), url);
  })();
  return pending;
}
