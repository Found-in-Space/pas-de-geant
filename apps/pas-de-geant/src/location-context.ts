export type LocationContextDetail = "address";

export interface NamedLocationContext {
  display_name?: string;
  name?: string;
  category?: string;
  feature_type?: string;
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  district?: string;
  postcode?: string;
  county?: string;
  country?: string;
  country_code?: string;
  region?: string;
  locality?: string;
  water?: string;
}

export interface LocationLookupResult {
  readonly display_name: string;
  readonly latitude_degrees: number;
  readonly longitude_degrees: number;
  readonly category?: string;
  readonly feature_type?: string;
  readonly importance?: number;
}

export interface LocationLookupResponse {
  readonly query: string;
  readonly results: readonly LocationLookupResult[];
}

export const AGENT_LOCATION_DETAIL: LocationContextDetail = "address";

export function parseLocationLookupArguments(value: unknown): { query: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Location lookup arguments must be an object.");
  }
  const query = (value as Record<string, unknown>).query;
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("Location lookup query must be a non-blank string.");
  }
  return { query: query.trim() };
}

export async function lookupLocations(
  queryValue: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<LocationLookupResponse> {
  const { query } = parseLocationLookupArguments({ query: queryValue });
  const parameters = new URLSearchParams({ q: query });
  const response = await fetchImplementation(
    `/api/location/search?${parameters}`,
    { headers: { Accept: "application/json" } },
  );
  const payload = await response.json().catch(() => undefined) as
    | LocationLookupResponse
    | undefined;
  if (!response.ok || !payload) {
    throw new Error(`Location lookup failed (${response.status}).`);
  }
  return payload;
}

export async function fetchNamedLocationContext(
  latitudeDegrees: number,
  longitudeDegrees: number,
  detail: LocationContextDetail,
  fetchImplementation: typeof fetch = fetch,
): Promise<NamedLocationContext | undefined> {
  const query = new URLSearchParams({
    lat: String(latitudeDegrees),
    lon: String(longitudeDegrees),
    detail,
  });
  try {
    const response = await fetchImplementation(`/api/location/reverse?${query}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return undefined;
    return (await response.json()) as NamedLocationContext;
  } catch {
    return undefined;
  }
}
