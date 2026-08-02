import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import { createReverseGeocodeMiddleware } from "./src/location-context-server.js";
import { createRealtimeTokenMiddleware } from "./src/realtime-token-server.js";
import { createExternalKnowledgeMiddleware } from "./src/external-knowledge-server.js";

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
  return {
    plugins: [
      {
        name: "pas-de-geant-realtime-token",
        configureServer(server) {
          server.middlewares.use(realtimeTokenMiddleware);
          server.middlewares.use(reverseGeocodeMiddleware);
          server.middlewares.use(externalKnowledgeMiddleware);
        },
        configurePreviewServer(server) {
          server.middlewares.use(realtimeTokenMiddleware);
          server.middlewares.use(reverseGeocodeMiddleware);
          server.middlewares.use(externalKnowledgeMiddleware);
        },
      },
    ],
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
