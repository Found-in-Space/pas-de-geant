import {
  copyFile,
  cp,
  mkdir,
  rm,
} from "node:fs/promises";

const workspaceRoot = new URL("../", import.meta.url);
const staticSource = new URL("dist/site/", workspaceRoot);
const staticTarget = new URL("dist/client/", workspaceRoot);
const serverTarget = new URL("dist/server/", workspaceRoot);
const workerSource = new URL(
  "apps/visualizer/src/sites-worker.mjs",
  workspaceRoot,
);

await Promise.all([
  rm(staticTarget, { recursive: true, force: true }),
  rm(serverTarget, { recursive: true, force: true }),
]);
await Promise.all([
  cp(staticSource, staticTarget, { recursive: true }),
  mkdir(serverTarget, { recursive: true }),
]);
await copyFile(workerSource, new URL("index.js", serverTarget));
