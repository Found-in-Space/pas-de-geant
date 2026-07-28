import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    allowedHosts: ["prince.dev.k-si.com"],
  },
  preview: {
    allowedHosts: ["prince.dev.k-si.com"],
  },
  build: {
    outDir: "../../dist/little-prince",
    emptyOutDir: true,
    sourcemap: true,
  },
});
