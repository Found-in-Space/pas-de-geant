import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const pages = ["index", "lifecycle", "controls", "xr", "datasets", "voice", "embed", "planner"];

export default defineConfig({
  base: "./",
  publicDir: false,
  resolve: { dedupe: ["three"] },
  server: { port: 4197, strictPort: true },
  build: {
    outDir: "../dist/integration",
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(pages.map(page => [page, fileURLToPath(new URL(`./${page}.html`, import.meta.url))])),
    },
  },
});
