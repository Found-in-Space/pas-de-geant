import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const requireFromApp = createRequire(
  new URL("./apps/pas-de-geant/package.json", import.meta.url),
);
const appThreeEsmEntry = resolve(
  dirname(requireFromApp.resolve("three")),
  "three.module.js",
);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^three$/,
        replacement: appThreeEsmEntry,
      },
    ],
  },
  test: {
    exclude: ["tests/browser/**", "node_modules/**", "dist/**"],
    server: {
      deps: {
        inline: [
          /[\\/]node_modules[\\/]@found-in-space[\\/]three-star-field[\\/]/,
          /[\\/]node_modules[\\/]@found-in-space[\\/]touch-os[\\/]dist[\\/]hosts[\\/]/,
        ],
      },
    },
  },
});
