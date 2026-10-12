import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createApplicationApis } from "./application-apis.js";
import { isAllowedRequestOrigin } from "./realtime-token-server.js";

export function createApiRequestHandler(
  environment: Record<string, string | undefined> = process.env,
  appDirectory = resolve("apps/pas-de-geant"),
) {
  return createApplicationRequestHandler(createApplicationApis(environment, appDirectory));
}

function createApplicationRequestHandler(
  { middlewares, readPublicEnvironment }: ReturnType<typeof createApplicationApis>,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", "http://local").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (!isAllowedRequestOrigin(request.headers.origin)) {
      response.writeHead(403).end("Cross-origin requests are denied.");
      return;
    }
    if (pathname === "/healthz" || pathname === "/api/config") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      if (pathname === "/healthz") {
        response.end(request.method === "HEAD" ? undefined : JSON.stringify({ status: "ok" }));
      } else {
        void readPublicEnvironment().then(configuration => {
          response.end(request.method === "HEAD" ? undefined : JSON.stringify(configuration));
        }).catch(() => {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: "Tile cache unavailable; direct upstream fallback is disabled." }));
        });
      }
      return;
    }
    let index = 0;
    const next = (): void => {
      const middleware = middlewares[index++];
      if (!middleware) {
        response.writeHead(404).end("Not found.");
        return;
      }
      void Promise.resolve(middleware(request, response, next)).catch(() => {
        // Upstream URLs can contain credentials; avoid logging request/error objects.
        if (!response.headersSent) response.statusCode = 500;
        response.end("API request failed.");
      });
    };
    next();
  };
}

/** Application HTTP routes stay on the development server alongside its local files. */
export function createApplicationApiMiddleware(apis: ReturnType<typeof createApplicationApis>) {
  const handleRequest = createApplicationRequestHandler(apis);
  return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    const pathname = new URL(request.url ?? "/", "http://local").pathname;
    if (!pathname.startsWith("/api/") || pathname === "/api/supervision") { next(); return; }
    handleRequest(request, response);
  };
}

export function startApiServer(environment: Record<string, string | undefined> = process.env) {
  const host = environment.PAS_DE_GEANT_API_HOST || "127.0.0.1";
  const port = Number(environment.PAS_DE_GEANT_API_PORT || 4198);
  const server = createServer(createApiRequestHandler(environment));
  server.listen(port, host, () => console.log(`Pas de Géant APIs listening on ${host}:${port}`));
  const stop = () => {
    server.close();
    server.closeIdleConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return server;
}
