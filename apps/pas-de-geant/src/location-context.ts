export type LocationContextDetail = "country" | "locality";

export interface NamedLocationContext {
  country?: string;
  country_code?: string;
  region?: string;
  locality?: string;
}

export const LOCALITY_DETAIL_SCALE = 1_000;

export function locationDetailForDisplayRadius(
  displayRadiusM: number,
): LocationContextDetail {
  return displayRadiusM < LOCALITY_DETAIL_SCALE ? "country" : "locality";
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
