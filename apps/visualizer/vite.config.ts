import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  build: {
    outDir: "../../dist/site",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        explorer: resolve(import.meta.dirname, "index.html"),
        shadowCones: resolve(
          import.meta.dirname,
          "shadow-cones/index.html",
        ),
      },
    },
  },
  server: {
    fs: {
      allow: ["../.."],
    },
  },
});
