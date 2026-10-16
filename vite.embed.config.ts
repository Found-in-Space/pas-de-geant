import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({ base: "./", resolve: { dedupe: ["three"] }, build: {
  outDir: "dist/embed", emptyOutDir: true, sourcemap: true,
  lib: { entry: fileURLToPath(new URL("./packages/pas-de-geant/dist/embed.js", import.meta.url)), formats: ["es"], fileName: () => "geant.js" },
} });
