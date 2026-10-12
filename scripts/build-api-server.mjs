import { build } from "esbuild";

await build({
  entryPoints: ["scripts/api-server.ts"],
  outfile: "dist/api/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Resolve workspace source directly; the API bundle needs no app build.
  alias: { "@found-in-space/worlds": "./packages/worlds/src" },
});
