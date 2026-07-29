import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, ".", "PAS_DE_GEANT_");
  return {
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
          construct: fileURLToPath(
            new URL("./construct/index.html", import.meta.url),
          ),
        },
      },
    },
  };
});
