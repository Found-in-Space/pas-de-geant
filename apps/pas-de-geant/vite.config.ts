import { defineConfig, loadEnv, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { createReverseGeocodeMiddleware } from "./src/location-context-server.js";
import { createRealtimeTokenMiddleware } from "./src/realtime-token-server.js";
import { createExternalKnowledgeMiddleware } from "./src/external-knowledge-server.js";
import { createSatelliteFeedMiddleware } from "./src/satellite-feed-server.js";

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
  return {
    plugins: [
      enforceSingleThreeRuntime(),
      {
        name: "pas-de-geant-realtime-token",
        configureServer(server) {
          server.middlewares.use(realtimeTokenMiddleware);
          server.middlewares.use(reverseGeocodeMiddleware);
          server.middlewares.use(externalKnowledgeMiddleware);
          server.middlewares.use(satelliteFeedMiddleware);
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
