import { resolve } from "node:path";
import { createTileCacheForwarder, readTileCachePublicEnvironment } from "./tile-cache-client.js";
import { createLocationGeocodeMiddleware } from "./location-context-server.js";
import { createRealtimeTokenMiddleware } from "./realtime-token-server.js";
import { createExternalKnowledgeMiddleware } from "./external-knowledge-server.js";
import { createSatelliteFeedMiddleware } from "./satellite-feed-server.js";
import { createTileDirectoryMiddleware } from "./local-tile-directory-server.js";
import { createLunarRegionalImageryMiddleware } from "./lunar-regional-imagery-server.js";
import { createLunarPreviewMiddleware } from "./lunar-preview-server.js";


function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createApplicationApis(
  serverEnvironment: Record<string, string | undefined>,
  appDirectory: string,
) {
  const apiKey = process.env.OPENAI_API_KEY || serverEnvironment.OPENAI_API_KEY;
  const realtimeTokenMiddleware = createRealtimeTokenMiddleware(apiKey);
  const externalKnowledgeMiddleware = createExternalKnowledgeMiddleware(apiKey);
  const locationGeocodeMiddleware = createLocationGeocodeMiddleware(
    process.env.PAS_DE_GEANT_GEOCODER_URL ||
      serverEnvironment.PAS_DE_GEANT_GEOCODER_URL,
    process.env.PAS_DE_GEANT_FORWARD_GEOCODER_URL ||
      serverEnvironment.PAS_DE_GEANT_FORWARD_GEOCODER_URL,
  );
  const satelliteFeedMiddleware = createSatelliteFeedMiddleware();
  const tileCacheUrl = serverEnvironment.PAS_DE_GEANT_TILE_CACHE_URL?.trim();
  const publicImageryUrl = serverEnvironment.VITE_IMAGERY_XYZ_TEMPLATE;
  const publicLunarImageryUrlTemplate =
    serverEnvironment.PAS_DE_GEANT_LUNAR_IMAGERY_URL_TEMPLATE;
  const lunarImageryDirectory =
    serverEnvironment.PAS_DE_GEANT_LUNAR_IMAGERY_DIRECTORY;
  const lunarImageryMaximumZoom = optionalNumber(
    serverEnvironment.PAS_DE_GEANT_LUNAR_IMAGERY_MAX_ZOOM,
  ) ?? 8;
  const lunarElevationDirectory =
    serverEnvironment.PAS_DE_GEANT_LUNAR_ELEVATION_DIRECTORY;
  const tileCacheMiddleware = createTileCacheForwarder(tileCacheUrl);
  const lunarImageryDirectoryMiddleware = createTileDirectoryMiddleware(
    "lunar-imagery",
    lunarImageryDirectory
      ? resolve(appDirectory, lunarImageryDirectory)
      : undefined,
    { metadataDirectory: lunarImageryDirectory ? resolve(appDirectory, lunarImageryDirectory, "..") : undefined },
  );
  const lunarElevationDirectoryMiddleware = createTileDirectoryMiddleware(
    "lunar-elevation",
    lunarElevationDirectory
      ? resolve(appDirectory, lunarElevationDirectory)
      : undefined,
    { metadataDirectory: lunarElevationDirectory ? resolve(appDirectory, lunarElevationDirectory) : undefined },
  );
  const publicEnvironment = {
    PAS_DE_GEANT_IMAGERY_CONFIGURED: Boolean(publicImageryUrl || tileCacheUrl),
    PAS_DE_GEANT_LUNAR_IMAGERY_CONFIGURED: Boolean(publicLunarImageryUrlTemplate || lunarImageryDirectory),
    PAS_DE_GEANT_LUNAR_IMAGERY_URL_TEMPLATE: publicLunarImageryUrlTemplate || "",
    PAS_DE_GEANT_LUNAR_IMAGERY_MAX_ZOOM: lunarImageryMaximumZoom,
    PAS_DE_GEANT_LUNAR_IMAGERY_PRODUCT_URL: serverEnvironment.PAS_DE_GEANT_LUNAR_IMAGERY_PRODUCT_URL || "",
    PAS_DE_GEANT_LUNAR_STUDY_IMAGERY_URL_TEMPLATE: serverEnvironment.PAS_DE_GEANT_LUNAR_STUDY_IMAGERY_URL_TEMPLATE || "",
    PAS_DE_GEANT_LUNAR_ELEVATION_PRODUCT_URL: serverEnvironment.PAS_DE_GEANT_LUNAR_ELEVATION_PRODUCT_URL || "",
    PAS_DE_GEANT_LUNAR_ELEVATION_URL_TEMPLATE: serverEnvironment.PAS_DE_GEANT_LUNAR_ELEVATION_URL_TEMPLATE || "",
    PAS_DE_GEANT_LUNAR_ELEVATION_CONFIGURED: Boolean(serverEnvironment.PAS_DE_GEANT_LUNAR_ELEVATION_URL_TEMPLATE || lunarElevationDirectory),
    ...Object.fromEntries(["VITE_IMAGERY_XYZ_TEMPLATE", "VITE_IMAGERY_ATTRIBUTION", "VITE_IMAGERY_PROVIDER_ID", "VITE_IMAGERY_TILE_SIZE", "VITE_IMAGERY_MIN_ZOOM", "VITE_IMAGERY_MAX_ZOOM", "VITE_ELEVATION_XYZ_TEMPLATE"].flatMap(key => serverEnvironment[key] === undefined ? [] : [[key, serverEnvironment[key]]])),
  } as Record<string, string | number | boolean>;
  return {
    middlewares: [
      createLunarPreviewMiddleware(
        serverEnvironment.PAS_DE_GEANT_LUNAR_PREVIEW_DIRECTORY || resolve(appDirectory, "../../.cache/apollo11-preview"),
        serverEnvironment.PAS_DE_GEANT_LUNAR_RUNTIME_DIRECTORY
          ? resolve(appDirectory, serverEnvironment.PAS_DE_GEANT_LUNAR_RUNTIME_DIRECTORY) : undefined,
      ),
      createLunarRegionalImageryMiddleware(),
      realtimeTokenMiddleware,
      locationGeocodeMiddleware,
      externalKnowledgeMiddleware,
      satelliteFeedMiddleware,
      ...(lunarImageryDirectoryMiddleware ? [lunarImageryDirectoryMiddleware] : []),
      ...(lunarElevationDirectoryMiddleware ? [lunarElevationDirectoryMiddleware] : []),
      tileCacheMiddleware,
    ],
    publicEnvironment,
    async readPublicEnvironment() {
      if (publicImageryUrl) return publicEnvironment;
      const cacheEnvironment = tileCacheUrl ? await readTileCachePublicEnvironment(tileCacheUrl) : {};
      return { ...publicEnvironment, ...cacheEnvironment };
    },
  };
}
