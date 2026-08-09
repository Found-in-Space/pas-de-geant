import { defineConfig, loadEnv, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { createReverseGeocodeMiddleware } from "./src/location-context-server.js";
import { createRealtimeTokenMiddleware } from "./src/realtime-token-server.js";
import { createExternalKnowledgeMiddleware } from "./src/external-knowledge-server.js";
import { createSatelliteFeedMiddleware } from "./src/satellite-feed-server.js";

const siteChrome = `
  <!-- 100% privacy-first analytics -->
  <script data-collect-dnt="true" async src="https://scripts.simpleanalyticscdn.com/latest.js"></script>
  <noscript><img src="https://queue.simpleanalyticscdn.com/noscript.gif?collect-dnt=true" alt="" referrerpolicy="no-referrer-when-downgrade" /></noscript>
  <footer class="fis-made-by-kaj" aria-label="Site credit">
    Made with <span aria-hidden="true">❤️</span> by <a href="https://k-si.com/">Kaj</a>
  </footer>
  <style>
    .fis-made-by-kaj {
      position: fixed; left: max(0.5rem, env(safe-area-inset-left)); bottom: max(0.5rem, env(safe-area-inset-bottom)); z-index: 2147483647;
      box-sizing: border-box; max-width: calc(100vw - 1rem); margin: 0; padding: 0.28rem 0.52rem; border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 999px;
      color: rgba(255, 255, 255, 0.72); background: rgba(5, 8, 12, 0.76); box-shadow: 0 0.25rem 1rem rgba(0, 0, 0, 0.24);
      font: 500 0.72rem/1.35 system-ui, sans-serif; letter-spacing: 0.01em; white-space: nowrap; backdrop-filter: blur(8px); pointer-events: none;
    }
    .fis-made-by-kaj a { color: #9fbcff; text-decoration: none; pointer-events: auto; }
    .fis-made-by-kaj a:hover, .fis-made-by-kaj a:focus-visible { text-decoration: underline; }
  </style>
`;

function analyticsAndCreditPlugin(): Plugin {
  return {
    name: "found-in-space-analytics-and-credit",
    transformIndexHtml(html) {
      return html.replace(/<\/body>/i, `${siteChrome}</body>`);
    },
  };
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
  return {
    plugins: [
      analyticsAndCreditPlugin(),
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
