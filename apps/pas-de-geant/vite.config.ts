import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    allowedHosts: ["pas-de-geant.dev.k-si.com"],
  },
  preview: {
    allowedHosts: ["pas-de-geant.dev.k-si.com"],
  },
  build: {
    outDir: "../../dist/pas-de-geant",
    emptyOutDir: true,
    sourcemap: true,
  },
});
