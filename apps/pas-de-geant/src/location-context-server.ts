import type { IncomingMessage, ServerResponse } from "node:http";
import { isAllowedRequestOrigin } from "./realtime-token-server.js";
import type {
  LocationLookupResponse,
  LocationLookupResult,
  LocationContextDetail,
  NamedLocationContext,
} from "./location-context.js";

export const REVERSE_LOCATION_PATH = "/api/location/reverse";
export const FORWARD_LOCATION_PATH = "/api/location/search";
export const DEFAULT_GEOCODER_URL =
  "https://nominatim.openstreetmap.org/reverse";
export const DEFAULT_FORWARD_GEOCODER_URL =
  "https://nominatim.openstreetmap.org/search";
const GEOCODER_USER_AGENT =
  "Pas-de-Geant/0.1 (+https://github.com/Found-in-Space/pas-de-geant)";
const MINIMUM_REQUEST_INTERVAL_MS = 1_000;

interface NominatimAddress {
  house_number?: string;
  road?: string;
  pedestrian?: string;
  footway?: string;
  cycleway?: string;
  neighbourhood?: string;
  quarter?: string;
  suburb?: string;
  city_district?: string;
  borough?: string;
  postcode?: string;
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
  ocean?: string;
  sea?: string;
  water?: string;
}

interface NominatimResponse {
  lat?: string;
  lon?: string;
  importance?: number;
  name?: string;
  display_name?: string;
  category?: string;
  type?: string;
  addresstype?: string;
  address?: NominatimAddress;
}

export interface ForwardGeocodeRequest {
  readonly query: string;
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
    detail !== "address"
  ) {
    return undefined;
  }
  return { latitudeDegrees, longitudeDegrees, detail };
}

export function parseForwardGeocodeRequest(
  url: URL,
): ForwardGeocodeRequest | undefined {
  const query = url.searchParams.get("q")?.trim();
  return query ? { query } : undefined;
}

function responseCoordinate(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

export async function requestForwardGeocode(
  request: ForwardGeocodeRequest,
  fetchImplementation: typeof fetch = fetch,
  geocoderUrl = DEFAULT_FORWARD_GEOCODER_URL,
): Promise<LocationLookupResponse> {
  const url = new URL(geocoderUrl);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "en");
  url.searchParams.set("limit", "5");
  url.searchParams.set("q", request.query);
  const response = await fetchImplementation(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": GEOCODER_USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`Location lookup failed (${response.status}).`);
  }
  const payload = await response.json() as unknown;
  const results: LocationLookupResult[] = [];
  if (Array.isArray(payload)) {
    for (const value of payload) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as NominatimResponse;
      const displayName = candidate.display_name?.trim();
      const latitudeDegrees = responseCoordinate(candidate.lat, -90, 90);
      const longitudeDegrees = responseCoordinate(candidate.lon, -180, 180);
      if (!displayName || latitudeDegrees === undefined ||
          longitudeDegrees === undefined) continue;
      results.push({
        display_name: displayName,
        latitude_degrees: latitudeDegrees,
        longitude_degrees: longitudeDegrees,
        category: candidate.category,
        feature_type: candidate.addresstype ?? candidate.type,
        importance: typeof candidate.importance === "number" &&
            Number.isFinite(candidate.importance)
          ? candidate.importance
          : undefined,
      });
    }
  }
  return { query: request.query, results };
}

export async function requestReverseGeocode(
  request: ReverseGeocodeRequest,
  fetchImplementation: typeof fetch = fetch,
  geocoderUrl = DEFAULT_GEOCODER_URL,
): Promise<NamedLocationContext | undefined> {
  const url = new URL(geocoderUrl);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("layer", "address,poi,natural,manmade");
  url.searchParams.set("accept-language", "en");
  url.searchParams.set("zoom", "18");
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
  const address = payload.address ?? {};
  const result: NamedLocationContext = {
    display_name: payload.display_name,
    name: payload.name,
    category: payload.category,
    feature_type: payload.addresstype ?? payload.type,
    house_number: address.house_number,
    road:
      address.road ??
      address.pedestrian ??
      address.footway ??
      address.cycleway,
    neighbourhood: address.neighbourhood ?? address.quarter,
    suburb: address.suburb,
    district: address.city_district ?? address.borough,
    postcode: address.postcode,
    county: address.county,
    country: address.country,
    country_code: address.country_code?.toUpperCase(),
    region:
      address.state ??
      address.region ??
      address.state_district,
    locality:
      address.city ??
      address.town ??
      address.village ??
      address.municipality ??
      address.hamlet,
    water: address.ocean ?? address.sea ?? address.water,
  };
  return Object.values(result).some((value) => value !== undefined)
    ? result
    : undefined;
}

export function createLocationGeocodeMiddleware(
  reverseGeocoderUrl = DEFAULT_GEOCODER_URL,
  forwardGeocoderUrl = DEFAULT_FORWARD_GEOCODER_URL,
  fetchImplementation: typeof fetch = fetch,
) {
  const cache = new Map<string, NamedLocationContext | null>();
  const forwardCache = new Map<string, LocationLookupResponse>();
  let requestQueue = Promise.resolve();
  let lastRequestAt = 0;

  const scheduleLookup = <T>(lookup: () => Promise<T>): Promise<T> => {
    const run = requestQueue.then(async () => {
      const waitMs = Math.max(
        0,
        MINIMUM_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt),
      );
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      lastRequestAt = Date.now();
      return await lookup();
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
    const reverse = url.pathname === REVERSE_LOCATION_PATH;
    const forward = url.pathname === FORWARD_LOCATION_PATH;
    if (!reverse && !forward) {
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
    if (!isAllowedRequestOrigin(request.headers.origin)) {
      response.statusCode = 403;
      response.end(JSON.stringify({ error: "Cross-origin requests are denied." }));
      return;
    }
    const parsed = reverse
      ? parseReverseGeocodeRequest(url)
      : parseForwardGeocodeRequest(url);
    if (!parsed) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Invalid location query." }));
      return;
    }
    try {
      if (reverse) {
        const reverseRequest = parsed as ReverseGeocodeRequest;
        const cacheKey = JSON.stringify(reverseRequest);
        let result = cache.get(cacheKey);
        if (result === undefined) {
          result = (await scheduleLookup(() => requestReverseGeocode(
            reverseRequest,
            fetchImplementation,
            reverseGeocoderUrl,
          ))) ?? null;
          cache.set(cacheKey, result);
        }
        if (!result) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "No named location found." }));
          return;
        }
        response.statusCode = 200;
        response.end(JSON.stringify(result));
      } else {
        const forwardRequest = parsed as ForwardGeocodeRequest;
        let result = forwardCache.get(forwardRequest.query);
        if (!result) {
          result = await scheduleLookup(() => requestForwardGeocode(
            forwardRequest,
            fetchImplementation,
            forwardGeocoderUrl,
          ));
          forwardCache.set(forwardRequest.query, result);
        }
        response.statusCode = 200;
        response.end(JSON.stringify(result));
      }
    } catch (error) {
      console.error("Location-geocoding request failed:", error);
      response.statusCode = 502;
      response.end(JSON.stringify({ error: "Location lookup failed." }));
    }
  };
}
