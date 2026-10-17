import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const pages = ["index", "lifecycle", "backgrounds", "size-comparison", "planner-overlays", "xr", "datasets", "voice", "embed", "planner"];

export default defineConfig({
  base: "./",
  publicDir: false,
  resolve: { dedupe: ["three"] },
  // Headset previews use HTTPS proxies with arbitrary hostnames.
  server: { port: 4197, strictPort: true, allowedHosts: true },
  build: {
    outDir: "../dist/integration",
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(pages.map(page => [page, fileURLToPath(new URL(`./${page}.html`, import.meta.url))])),
    },
  },
});
