import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    dedupe: ["three"],
  },
  test: {
    include: ["tests/**/*.test.ts"],
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
