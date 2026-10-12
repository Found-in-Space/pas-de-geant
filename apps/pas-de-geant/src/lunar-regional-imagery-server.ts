import type { IncomingMessage, ServerResponse } from "node:http";
import { LUNAR_REGIONAL_TILE_PATH, lunarRegionalUpstreamUrl } from "./lunar-regional-imagery.js";
import { LUNAR_ARCHIVE_IMAGERY } from "./lunar-regional-imagery-metadata.js";

/** Same-origin access to a fixed public archive product which does not send CORS.
 * Request values choose valid tile coordinates, never an upstream host or path.
 */
export function createLunarRegionalImageryMiddleware() {
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const pathname = new URL(request.url ?? "/", "http://local").pathname;
    if (!pathname.startsWith(`${LUNAR_REGIONAL_TILE_PATH}/`)) { next(); return; }
    const match = new RegExp(`^${LUNAR_REGIONAL_TILE_PATH}/([a-z0-9-]+)/(\\d+)/(\\d+)/(\\d+)\\.jpg$`).exec(pathname);
    const region = match && LUNAR_ARCHIVE_IMAGERY.find((entry) => entry.id === match[1]);
    const upstream = match && region && lunarRegionalUpstreamUrl(Number(match[2]), Number(match[3]), Number(match[4]), region);
    if (!upstream) { response.statusCode = 404; response.end("Unknown regional imagery tile."); return; }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405; response.setHeader("Allow", "GET, HEAD"); response.end(); return;
    }
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    void (async () => {
      try {
        const image = await fetch(upstream, { signal: controller.signal });
        if (!image.ok || !image.headers.get("content-type")?.startsWith("image/")) {
          response.statusCode = 502; response.end("The archive preview could not be loaded."); return;
        }
        const bytes = Buffer.from(await image.arrayBuffer());
        response.setHeader("Content-Type", "image/jpeg");
        response.setHeader("Content-Length", bytes.length);
        response.setHeader("Cache-Control", "public, max-age=86400");
        response.end(request.method === "HEAD" ? undefined : bytes);
      } catch {
        if (!controller.signal.aborted) { response.statusCode = 502; response.end("The archive preview could not be loaded."); }
      }
    })();
  };
}
