import { defineConfig, loadEnv, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { attachSupervisionRelay } from "./src/supervision-server.js";
import { createApplicationApis } from "./src/application-apis.js";
import { createApplicationApiMiddleware } from "./src/api-server.js";
import { assertDevelopmentPublicTileSources, DIRECT_MAPTILER_OVERRIDE } from "./src/development-tile-policy.js";
import { compileDevelopmentSession, readDevelopmentSessionSettings } from "./src/development-session-config.js";
import { createLocalTileServer } from "./src/local-tile-server.js";

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

export default defineConfig(async ({ mode, command }) => {
  const environment = loadEnv(mode, ".", "PAS_DE_GEANT_");
  const serverEnvironment = loadEnv(mode, ".", "");
  const allowDirectMapTiler = serverEnvironment.PAS_DE_GEANT_ALLOW_DIRECT_MAPTILER === DIRECT_MAPTILER_OVERRIDE;
  assertDevelopmentPublicTileSources(serverEnvironment, { development: command === "serve", allowDirectMapTiler });
  if (serverEnvironment.PAS_DE_GEANT_API_BACKEND_URL?.trim()) {
    throw new Error("Shared application API forwarding has been retired. Configure PAS_DE_GEANT_TILE_CACHE_URL; application APIs and local lunar files stay on the development machine.");
  }
  const appDirectory = fileURLToPath(new URL(".", import.meta.url));
  const localApis = createApplicationApis(
    serverEnvironment, appDirectory,
  );
  const localApiMiddleware = createApplicationApiMiddleware(localApis);
  return {
    define: {
      "import.meta.env.PAS_DE_GEANT_DIRECT_MAPTILER_ALLOWED": JSON.stringify(allowDirectMapTiler),
    },
    plugins: [
      enforceSingleThreeRuntime(),
      {
        name: "pas-de-geant-development-apis",
        async configureServer(server) {
          const settings = await readDevelopmentSessionSettings(appDirectory);
          const { config, localProducts } = compileDevelopmentSession(serverEnvironment, appDirectory, settings);
          const localTiles = await createLocalTileServer(localProducts);
          server.middlewares.use((request, response, next) => {
            if (new URL(request.url ?? "/", "http://local").pathname !== "/session-config.json") { next(); return; }
            if (request.method !== "GET" && request.method !== "HEAD") {
              response.writeHead(405, { Allow: "GET, HEAD" }).end(); return;
            }
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end(request.method === "HEAD" ? undefined : JSON.stringify(config));
          });
          server.middlewares.use(localTiles);
          const httpServer = server.httpServer;
          if (httpServer) {
            const detachSupervisionRelay = attachSupervisionRelay(httpServer);
            httpServer.once("close", detachSupervisionRelay);
          }
          server.middlewares.use(localApiMiddleware);
        },
        configurePreviewServer(server) {
          server.middlewares.use(localApiMiddleware);
        },
      } satisfies Plugin,
    ],
    resolve: {
      dedupe: ["three"],
    },
    base: environment.PAS_DE_GEANT_BASE || "./",
    server: {
      allowedHosts: [".k-si.com"],
    },
    preview: {
      allowedHosts: [".k-si.com"],
    },
    build: {
      outDir: "../../dist/pas-de-geant",
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          eclipse: fileURLToPath(
            new URL("./eclipse/index.html", import.meta.url),
          ),
          moon: fileURLToPath(
            new URL("./moon/index.html", import.meta.url),
          ),
          apollo11Vr: fileURLToPath(
            new URL("./moon/apollo11/index.html", import.meta.url),
          ),
          tileOnion: fileURLToPath(
            new URL("./demos/tile-onion.html", import.meta.url),
          ),
        },
      },
    },
  };
});
