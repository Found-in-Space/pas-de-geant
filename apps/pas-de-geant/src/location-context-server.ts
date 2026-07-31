import type { IncomingMessage, ServerResponse } from "node:http";
import { isAllowedRequestOrigin } from "./realtime-token-server.js";
import type {
  LocationContextDetail,
  NamedLocationContext,
} from "./location-context.js";

export const REVERSE_LOCATION_PATH = "/api/location/reverse";
export const DEFAULT_GEOCODER_URL =
  "https://nominatim.openstreetmap.org/reverse";
const GEOCODER_USER_AGENT =
  "Pas-de-Geant/0.1 (+https://github.com/Found-in-Space/pas-de-geant)";
const MINIMUM_REQUEST_INTERVAL_MS = 1_000;

interface NominatimAddress {
  country?: string;
  country_code?: string;
  region?: string;
  state?: string;
  state_district?: string;
  county?: string;
  municipality?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
}

interface NominatimResponse {
  address?: NominatimAddress;
}

export interface ReverseGeocodeRequest {
  latitudeDegrees: number;
  longitudeDegrees: number;
  detail: LocationContextDetail;
}

function finiteCoordinate(
  value: string | null,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

export function parseReverseGeocodeRequest(
  url: URL,
): ReverseGeocodeRequest | undefined {
  const latitudeDegrees = finiteCoordinate(url.searchParams.get("lat"), -90, 90);
  const longitudeDegrees = finiteCoordinate(
    url.searchParams.get("lon"),
    -180,
    180,
  );
  const detail = url.searchParams.get("detail");
  if (
    latitudeDegrees === undefined ||
    longitudeDegrees === undefined ||
    (detail !== "country" && detail !== "locality")
  ) {
    return undefined;
  }
  return { latitudeDegrees, longitudeDegrees, detail };
}

export async function requestReverseGeocode(
  request: ReverseGeocodeRequest,
  fetchImplementation: typeof fetch = fetch,
  geocoderUrl = DEFAULT_GEOCODER_URL,
): Promise<NamedLocationContext | undefined> {
  const url = new URL(geocoderUrl);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("layer", "address");
  url.searchParams.set("accept-language", "en");
  url.searchParams.set("zoom", request.detail === "country" ? "3" : "12");
  url.searchParams.set("lat", String(request.latitudeDegrees));
  url.searchParams.set("lon", String(request.longitudeDegrees));
  const response = await fetchImplementation(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": GEOCODER_USER_AGENT,
    },
  });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as NominatimResponse;
  const address = payload.address;
  if (!address?.country) return undefined;
  const result: NamedLocationContext = {
    country: address.country,
    country_code: address.country_code?.toUpperCase(),
  };
  if (request.detail === "locality") {
    result.region =
      address.state ??
      address.region ??
      address.state_district ??
      address.county;
    result.locality =
      address.city ??
      address.town ??
      address.village ??
      address.municipality ??
      address.hamlet;
  }
  return result;
}

function requestHost(request: IncomingMessage): string | undefined {
  const forwardedHost = request.headers["x-forwarded-host"];
  return (
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
      ?.split(",")[0]
      ?.trim() ?? request.headers.host
  );
}

function roundedRequest(request: ReverseGeocodeRequest): ReverseGeocodeRequest {
  const decimals = request.detail === "country" ? 1 : 2;
  return {
    ...request,
    latitudeDegrees: Number(request.latitudeDegrees.toFixed(decimals)),
    longitudeDegrees: Number(request.longitudeDegrees.toFixed(decimals)),
  };
}

export function createReverseGeocodeMiddleware(
  geocoderUrl = DEFAULT_GEOCODER_URL,
  fetchImplementation: typeof fetch = fetch,
) {
  const cache = new Map<string, NamedLocationContext | null>();
  let requestQueue = Promise.resolve();
  let lastRequestAt = 0;

  const scheduleLookup = (
    request: ReverseGeocodeRequest,
  ): Promise<NamedLocationContext | undefined> => {
    const run = requestQueue.then(async () => {
      const waitMs = Math.max(
        0,
        MINIMUM_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt),
      );
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      lastRequestAt = Date.now();
      return requestReverseGeocode(request, fetchImplementation, geocoderUrl);
    });
    requestQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://local");
    if (url.pathname !== REVERSE_LOCATION_PATH) {
      next();
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "private, max-age=3600");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Method not allowed." }));
      return;
    }
    if (!isAllowedRequestOrigin(request.headers.origin, requestHost(request))) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "Cross-origin requests are denied." }));
      return;
    }
    const parsed = parseReverseGeocodeRequest(url);
    if (!parsed) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Invalid location query." }));
      return;
    }
    const lookup = roundedRequest(parsed);
    const cacheKey = JSON.stringify(lookup);
    try {
      let result = cache.get(cacheKey);
      if (result === undefined) {
        result = (await scheduleLookup(lookup)) ?? null;
        cache.set(cacheKey, result);
      }
      if (!result) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "No named location found." }));
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify(result));
    } catch (error) {
      console.error("Reverse-geocoding request failed:", error);
      response.statusCode = 502;
      response.end(JSON.stringify({ error: "Location lookup failed." }));
    }
  };
}
