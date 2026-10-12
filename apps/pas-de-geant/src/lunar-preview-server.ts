import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Serve generated preview evidence and PNGs; arbitrary paths are never exposed. */
export function createLunarPreviewMiddleware(directory = process.env.PAS_DE_GEANT_LUNAR_PREVIEW_DIRECTORY || fileURLToPath(new URL("../../../.cache/apollo11-preview/", import.meta.url)), runtimeDirectory = resolve(directory, "runtime")) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const pathname = new URL(request.url ?? "/", "http://local").pathname;
    if (!pathname.startsWith("/lunar-preview/")) { next(); return; }
    const relative = pathname.slice("/lunar-preview/".length);
    if (!/^(product\.json|imagery\/\d+\/\d+\/\d+\.png|runtime\/(product\.json|[a-z0-9-]+\/\d+\/\d+\/\d+\.png))$/.test(relative)) { response.statusCode = 404; response.end(); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { response.statusCode = 405; response.setHeader("Allow", "GET, HEAD"); response.end(); return; }
    void (async () => {
      try {
        const path = relative.startsWith("runtime/")
          ? resolve(runtimeDirectory, relative.slice("runtime/".length)) : resolve(directory, relative);
        const info = await stat(path);
        response.setHeader("Content-Type", relative.endsWith(".json") ? "application/json" : "image/png");
        response.setHeader("Content-Length", info.size);
        // Generated local previews can be rebuilt at the same path.
        response.setHeader("Cache-Control", "no-cache");
        if (request.method === "HEAD") { response.end(); return; }
        const stream = createReadStream(path);
        response.once("close", () => stream.destroy());
        stream.on("error", () => response.destroy());
        stream.pipe(response);
      } catch {
        response.statusCode = 404;
        response.end("Build the Apollo 11 preview with the texture pipeline first.");
      }
    })();
  };
}
