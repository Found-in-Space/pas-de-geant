import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import { createReverseGeocodeMiddleware } from "./src/location-context-server.js";
import { createRealtimeTokenMiddleware } from "./src/realtime-token-server.js";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, ".", "PAS_DE_GEANT_");
  const serverEnvironment = loadEnv(mode, ".", "");
  const realtimeTokenMiddleware = createRealtimeTokenMiddleware(
    process.env.OPENAI_API_KEY || serverEnvironment.OPENAI_API_KEY,
  );
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
        },
        configurePreviewServer(server) {
          server.middlewares.use(realtimeTokenMiddleware);
          server.middlewares.use(reverseGeocodeMiddleware);
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
          construct: fileURLToPath(
            new URL("./construct/index.html", import.meta.url),
          ),
        },
      },
    },
  };
});
