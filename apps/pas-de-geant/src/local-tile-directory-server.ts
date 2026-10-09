import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

export type TileDirectoryMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

/** Maps the canonical runtime tile route (with an optional PNG suffix) to disk. */
export function localTilePath(
  providerId: string,
  directory: string,
  requestUrl: string,
): string | undefined {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(providerId)) {
    throw new Error(`Invalid local tile provider ID: ${providerId}`);
  }
  const route = new RegExp(
    `^/api/tiles/${providerId}/(\\d+)/(\\d+)/(\\d+)(?:\\.png)?$`,
  );
  const pathname = new URL(requestUrl, "http://pas-de-geant.local").pathname;
  const match = route.exec(pathname);
  if (!match) return undefined;
  const [, zoom, x, y] = match;
  return resolve(directory, zoom!, x!, `${y!}.png`);
}

/** Serves one immutable XYZ PNG pyramid without exposing its filesystem root. */
export function createTileDirectoryMiddleware(
  providerId: string,
  directory: string | undefined,
): TileDirectoryMiddleware | undefined {
  if (!directory?.trim()) return undefined;
  const root = resolve(directory);

  return (request, response, next) => {
    const tilePath = localTilePath(providerId, root, request.url ?? "/");
    if (!tilePath) {
      next();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD");
      response.end();
      return;
    }

    void stat(tilePath).then(
      (tile) => {
        if (!tile.isFile()) {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "image/png");
        response.setHeader("Content-Length", String(tile.size));
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        const stream = createReadStream(tilePath);
        stream.on("error", (error) => {
          if (!response.headersSent) response.statusCode = 500;
          response.end();
          console.error(`Could not read lunar imagery tile ${tilePath}:`, error);
        });
        stream.pipe(response);
      },
      () => {
        response.statusCode = 404;
        response.end();
      },
    );
  };
}
