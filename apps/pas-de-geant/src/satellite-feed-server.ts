import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SATELLITE_FEED_PATH,
  SATELLITE_REFRESH_INTERVAL_MS,
  type SatelliteGroupPayload,
} from "./satellite-feed.js";
import {
  isSatelliteGroupId,
  satelliteGroupConfiguration,
  type SatelliteGroupId,
} from "./satellite-groups.js";

const CELESTRAK_GP_URL = "https://celestrak.org/NORAD/elements/gp.php";
const CELESTRAK_USER_AGENT =
  "Pas-de-Geant/0.1 (+https://github.com/Found-in-Space/pas-de-geant)";

interface SourceResult {
  readonly fetchedAtMs: number;
  readonly satellites: readonly unknown[];
}

interface SourceCacheEntry extends SourceResult {
  readonly expiresAtMs: number;
}

export type SatelliteGroupLoader = (
  group: SatelliteGroupId,
) => Promise<SatelliteGroupPayload>;

function celestrakUrl(group: string): URL {
  const url = new URL(CELESTRAK_GP_URL);
  url.searchParams.set("GROUP", group.toUpperCase());
  url.searchParams.set("FORMAT", "JSON");
  return url;
}

function catalogId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const id = (value as Record<string, unknown>).NORAD_CAT_ID;
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : undefined;
}

export function createSatelliteGroupLoader(
  fetchImplementation: typeof fetch = fetch,
  now: () => number = Date.now,
): SatelliteGroupLoader {
  const cache = new Map<string, SourceCacheEntry>();
  const inFlight = new Map<string, Promise<SourceResult>>();

  const loadSource = async (sourceGroup: string): Promise<SourceResult> => {
    const cached = cache.get(sourceGroup);
    const requestTime = now();
    if (cached && cached.expiresAtMs > requestTime) return cached;
    const activeRequest = inFlight.get(sourceGroup);
    if (activeRequest) return activeRequest;

    const request = (async (): Promise<SourceResult> => {
      const response = await fetchImplementation(celestrakUrl(sourceGroup), {
        headers: {
          Accept: "application/json",
          "User-Agent": CELESTRAK_USER_AGENT,
        },
      });
      if (!response.ok) {
        throw new Error(
          `CelesTrak ${sourceGroup} request failed (${response.status}).`,
        );
      }
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error(`CelesTrak ${sourceGroup} returned invalid data.`);
      }
      const fetchedAtMs = now();
      const result = { fetchedAtMs, satellites: payload };
      cache.set(sourceGroup, {
        ...result,
        expiresAtMs: fetchedAtMs + SATELLITE_REFRESH_INTERVAL_MS,
      });
      return result;
    })();
    inFlight.set(sourceGroup, request);
    try {
      return await request;
    } finally {
      if (inFlight.get(sourceGroup) === request) inFlight.delete(sourceGroup);
    }
  };

  return async (group): Promise<SatelliteGroupPayload> => {
    const configuration = satelliteGroupConfiguration(group);
    const sourceResults = await Promise.all(
      configuration.celestrakGroups.map(loadSource),
    );
    const unique = new Map<string, unknown>();
    let anonymousIndex = 0;
    for (const source of sourceResults) {
      for (const satellite of source.satellites) {
        unique.set(
          catalogId(satellite) ?? `anonymous-${anonymousIndex++}`,
          satellite,
        );
      }
    }
    return {
      group,
      fetchedAtMs: Math.min(
        ...sourceResults.map(({ fetchedAtMs }) => fetchedAtMs),
      ),
      satellites: [...unique.values()] as SatelliteGroupPayload["satellites"],
    };
  };
}

function requestHost(request: IncomingMessage): string | undefined {
  const forwardedHost = request.headers["x-forwarded-host"];
  return (
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
      ?.split(",")[0]
      ?.trim() ?? request.headers.host
  );
}

function requestOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createSatelliteFeedMiddleware(
  loadGroup: SatelliteGroupLoader = createSatelliteGroupLoader(),
) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://local");
    if (url.pathname !== SATELLITE_FEED_PATH) {
      next();
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Method not allowed." }));
      return;
    }
    if (!requestOriginAllowed(request.headers.origin, requestHost(request))) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "Cross-origin requests are denied." }));
      return;
    }
    const group = url.searchParams.get("group");
    if (!isSatelliteGroupId(group)) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Unknown satellite group." }));
      return;
    }
    try {
      response.statusCode = 200;
      response.end(JSON.stringify(await loadGroup(group)));
    } catch (error) {
      console.error("Satellite feed request failed:", error);
      response.statusCode = 502;
      response.end(JSON.stringify({ error: "Satellite data is unavailable." }));
    }
  };
}
