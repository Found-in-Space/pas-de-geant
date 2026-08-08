import { defineConfig, loadEnv, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createReverseGeocodeMiddleware } from "./src/location-context-server.js";
import { createRealtimeTokenMiddleware } from "./src/realtime-token-server.js";
import { createExternalKnowledgeMiddleware } from "./src/external-knowledge-server.js";
import { createSatelliteFeedMiddleware } from "./src/satellite-feed-server.js";
import {
  createTileProxyMiddleware,
  type TileProxyProviderOptions,
  type TileProxyScheme,
} from "./src/tile-proxy-server.js";
import { selectImageryVariant } from "./src/imagery-variants.js";
import { MAPTERHORN_ELEVATION_URL_TEMPLATE } from "./src/elevation-cache.js";

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function commaSeparated(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function optionalCommaSeparated(
  value: string | undefined,
): readonly string[] | undefined {
  return value?.trim() ? commaSeparated(value) : undefined;
}

function stringRecord(
  value: unknown,
  description: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object of string values.`);
  }
  const entries = Object.entries(value);
  if (!entries.every(([, headerValue]) => typeof headerValue === "string")) {
    throw new Error(`${description} must contain only string values.`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function configuredHeaders(
  value: string | undefined,
  description: string,
): Readonly<Record<string, string>> | undefined {
  return !value?.trim()
    ? undefined
    : stringRecord(JSON.parse(value), description);
}

function stringList(
  value: unknown,
  description: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${description} must be an array of strings.`);
  }
  return value;
}

function tileScheme(value: string | undefined): TileProxyScheme {
  if (!value || value === "xyz") return "xyz";
  if (value === "tms") return "tms";
  throw new Error(`Unknown tile proxy scheme: ${value}`);
}

function optionalProviderNumber(
  configuration: Record<string, unknown>,
  property: string,
): number | undefined {
  const value = configuration[property];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`Tile proxy provider ${property} must be a number.`);
}

function configuredTileProviders(
  value: string | undefined,
): Record<string, TileProxyProviderOptions> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tile proxy providers JSON must be an object.");
  }
  const providers: Record<string, TileProxyProviderOptions> = {};
  for (const [provider, rawConfiguration] of Object.entries(parsed)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider)) {
      throw new Error(`Invalid tile proxy provider ID: ${provider}`);
    }
    if (
      !rawConfiguration ||
      typeof rawConfiguration !== "object" ||
      Array.isArray(rawConfiguration)
    ) {
      throw new Error(`Tile proxy provider ${provider} must be an object.`);
    }
    const configuration = rawConfiguration as Record<string, unknown>;
    if (typeof configuration.urlTemplate !== "string") {
      throw new Error(
        `Tile proxy provider ${provider} requires urlTemplate.`,
      );
    }
    const ignored = configuration.cacheKeyIgnoredSearchParameters;
    if (
      ignored !== undefined &&
      (!Array.isArray(ignored) ||
        !ignored.every((parameter) => typeof parameter === "string"))
    ) {
      throw new Error(
        `Tile proxy provider ${provider} cache-key parameters must be strings.`,
      );
    }
    providers[provider] = {
      urlTemplate: configuration.urlTemplate,
      scheme: tileScheme(
        typeof configuration.scheme === "string"
          ? configuration.scheme
          : undefined,
      ),
      ...(ignored ? { cacheKeyIgnoredSearchParameters: ignored } : {}),
      upstreamHeaders: stringRecord(
        configuration.upstreamHeaders,
        `Tile proxy provider ${provider} upstreamHeaders`,
      ),
      forwardRequestHeaders: stringList(
        configuration.forwardRequestHeaders,
        `Tile proxy provider ${provider} forwardRequestHeaders`,
      ),
      maxConcurrency: optionalProviderNumber(
        configuration,
        "maxConcurrency",
      ),
      minimumIntervalMs: optionalProviderNumber(
        configuration,
        "minimumIntervalMs",
      ),
      defaultCacheTtlMs: optionalProviderNumber(
        configuration,
        "defaultCacheTtlMs",
      ),
      upstreamBackoffMs: optionalProviderNumber(
        configuration,
        "upstreamBackoffMs",
      ),
    };
  }
  return providers;
}

function enforceSingleThreeRuntime(): Plugin {
  return {
    name: "pas-de-geant-single-three-runtime",
    generateBundle() {
      const packageRoots = new Set<string>();
      for (const moduleId of this.getModuleIds()) {
        const normalizedId = moduleId.replaceAll("\\", "/").split("?", 1)[0]!;
        const packageMarker = "/node_modules/three/";
        const packageIndex = normalizedId.lastIndexOf(packageMarker);
        if (packageIndex < 0) continue;
        packageRoots.add(
          normalizedId.slice(0, packageIndex + packageMarker.length - 1),
        );
      }
      if (packageRoots.size !== 1) {
        this.error(
          `Expected exactly one bundled Three.js runtime, found ${packageRoots.size}: ${
            [...packageRoots].join(", ") || "none"
          }`,
        );
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, ".", "PAS_DE_GEANT_");
  const serverEnvironment = loadEnv(mode, ".", "");
  const apiKey = process.env.OPENAI_API_KEY || serverEnvironment.OPENAI_API_KEY;
  const realtimeTokenMiddleware = createRealtimeTokenMiddleware(apiKey);
  const externalKnowledgeMiddleware = createExternalKnowledgeMiddleware(apiKey);
  const reverseGeocodeMiddleware = createReverseGeocodeMiddleware(
    process.env.PAS_DE_GEANT_GEOCODER_URL ||
      serverEnvironment.PAS_DE_GEANT_GEOCODER_URL,
  );
  const satelliteFeedMiddleware = createSatelliteFeedMiddleware();
  const textureUrlTemplate =
    serverEnvironment.PAS_DE_GEANT_TILE_PROXY_TEXTURES_UPSTREAM_TEMPLATE ||
    serverEnvironment.VITE_IMAGERY_XYZ_TEMPLATE;
  const textureScheme = tileScheme(
    serverEnvironment.PAS_DE_GEANT_TILE_PROXY_TEXTURES_SCHEME,
  );
  const textureUpstreamHeaders = configuredHeaders(
    serverEnvironment.PAS_DE_GEANT_TILE_PROXY_TEXTURES_UPSTREAM_HEADERS_JSON,
    "Texture proxy upstream headers",
  );
  const textureForwardRequestHeaders = optionalCommaSeparated(
    serverEnvironment
      .PAS_DE_GEANT_TILE_PROXY_TEXTURES_FORWARD_REQUEST_HEADERS,
  );
  const providers: Record<string, TileProxyProviderOptions> = {
    elevation: {
      urlTemplate:
        serverEnvironment
          .PAS_DE_GEANT_TILE_PROXY_ELEVATION_UPSTREAM_TEMPLATE ||
        MAPTERHORN_ELEVATION_URL_TEMPLATE,
      scheme: tileScheme(
        serverEnvironment.PAS_DE_GEANT_TILE_PROXY_ELEVATION_SCHEME,
      ),
      upstreamHeaders: configuredHeaders(
        serverEnvironment
          .PAS_DE_GEANT_TILE_PROXY_ELEVATION_UPSTREAM_HEADERS_JSON,
        "Elevation proxy upstream headers",
      ),
      forwardRequestHeaders: optionalCommaSeparated(
        serverEnvironment
          .PAS_DE_GEANT_TILE_PROXY_ELEVATION_FORWARD_REQUEST_HEADERS,
      ),
    },
  };
  if (textureUrlTemplate) {
    const baseTextureConfiguration = {
      urlTemplate: textureUrlTemplate,
      attribution: serverEnvironment.VITE_IMAGERY_ATTRIBUTION ||
        "Configured imagery",
    };
    providers.textures = {
      urlTemplate:
        selectImageryVariant(baseTextureConfiguration, null).urlTemplate,
      scheme: textureScheme,
      upstreamHeaders: textureUpstreamHeaders,
      forwardRequestHeaders: textureForwardRequestHeaders,
    };
    providers["textures-source"] = {
      urlTemplate: baseTextureConfiguration.urlTemplate,
      scheme: textureScheme,
      upstreamHeaders: textureUpstreamHeaders,
      forwardRequestHeaders: textureForwardRequestHeaders,
    };
  }
  Object.assign(
    providers,
    configuredTileProviders(
      serverEnvironment.PAS_DE_GEANT_TILE_PROXY_PROVIDERS_JSON,
    ),
  );
  const appDirectory = fileURLToPath(new URL(".", import.meta.url));
  const tileProxyMiddleware = createTileProxyMiddleware({
    providers,
    upstreamHeaders: configuredHeaders(
      serverEnvironment.PAS_DE_GEANT_TILE_PROXY_UPSTREAM_HEADERS_JSON,
      "Default tile proxy upstream headers",
    ),
    forwardRequestHeaders: optionalCommaSeparated(
      serverEnvironment.PAS_DE_GEANT_TILE_PROXY_FORWARD_REQUEST_HEADERS,
    ),
    cacheDirectory: resolve(
      appDirectory,
      serverEnvironment.PAS_DE_GEANT_TILE_PROXY_CACHE_DIRECTORY ||
        "../../.cache/tiles",
    ),
    cacheKeyIgnoredSearchParameters: commaSeparated(
      serverEnvironment
        .PAS_DE_GEANT_TILE_PROXY_CACHE_KEY_IGNORED_QUERY_PARAMETERS ??
        "key",
    ),
    maxConcurrency: optionalNumber(
      serverEnvironment.PAS_DE_GEANT_TILE_PROXY_MAX_CONCURRENCY,
    ),
    minimumIntervalMs: optionalNumber(
      serverEnvironment.PAS_DE_GEANT_TILE_PROXY_MIN_INTERVAL_MS,
    ),
    defaultCacheTtlMs: optionalNumber(
      serverEnvironment.PAS_DE_GEANT_TILE_PROXY_DEFAULT_TTL_MS,
    ),
    upstreamBackoffMs: optionalNumber(
      serverEnvironment.PAS_DE_GEANT_TILE_PROXY_UPSTREAM_BACKOFF_MS,
    ),
  });
  return {
    plugins: [
      enforceSingleThreeRuntime(),
      {
        name: "pas-de-geant-development-apis",
        configureServer(server) {
          server.middlewares.use(realtimeTokenMiddleware);
          server.middlewares.use(reverseGeocodeMiddleware);
          server.middlewares.use(externalKnowledgeMiddleware);
          server.middlewares.use(satelliteFeedMiddleware);
          server.middlewares.use(tileProxyMiddleware);
        },
        configurePreviewServer(server) {
          server.middlewares.use(realtimeTokenMiddleware);
          server.middlewares.use(reverseGeocodeMiddleware);
          server.middlewares.use(externalKnowledgeMiddleware);
          server.middlewares.use(satelliteFeedMiddleware);
        },
      },
    ],
    resolve: {
      dedupe: ["three"],
    },
    base: environment.PAS_DE_GEANT_BASE || "./",
    server: {
      allowedHosts: ["geant.dev.k-si.com"],
    },
    preview: {
      allowedHosts: ["geant.dev.k-si.com"],
    },
    build: {
      outDir: "../../dist/pas-de-geant",
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          tileOnion: fileURLToPath(
            new URL("./demos/tile-onion.html", import.meta.url),
          ),
        },
      },
    },
  };
});
