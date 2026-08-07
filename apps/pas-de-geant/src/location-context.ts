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

export const AGENT_LOCATION_DETAIL: LocationContextDetail = "address";

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
