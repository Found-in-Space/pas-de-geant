import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({ root: "examples", resolve: { dedupe: ["three"] }, build: {
  outDir: "../dist/examples", emptyOutDir: true, rollupOptions: { input: {
    independent: fileURLToPath(new URL("./examples/independent-worlds.html", import.meta.url)),
    embed: fileURLToPath(new URL("./examples/embed.html", import.meta.url)),
  } },
} });
