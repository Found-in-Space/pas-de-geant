export const GEO_IP_ENDPOINT = "https://get.geojs.io/v1/ip/geo.json";

export type InitialLocationSource = "device" | "ip" | "fallback";

export interface InitialLocation {
  latitudeDegrees: number;
  longitudeDegrees: number;
  source: InitialLocationSource;
}

export interface InitialLocationDependencies {
  geolocation?: Pick<Geolocation, "getCurrentPosition">;
  fetcher?: typeof fetch;
  deviceTimeoutMs?: number;
  ipTimeoutMs?: number;
}

export const GLOBAL_FALLBACK_LOCATION: InitialLocation = {
  latitudeDegrees: 0,
  longitudeDegrees: 0,
  source: "fallback",
};

function finiteCoordinate(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || value.trim() === "")
  ) {
    return undefined;
  }
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? coordinate : undefined;
}

function locationFromCoordinates(
  latitudeValue: unknown,
  longitudeValue: unknown,
  source: InitialLocationSource,
): InitialLocation | undefined {
  const latitudeDegrees = finiteCoordinate(latitudeValue);
  const longitudeDegrees = finiteCoordinate(longitudeValue);
  if (
    latitudeDegrees === undefined ||
    longitudeDegrees === undefined ||
    latitudeDegrees < -90 ||
    latitudeDegrees > 90 ||
    longitudeDegrees < -180 ||
    longitudeDegrees > 180
  ) {
    return undefined;
  }
  return { latitudeDegrees, longitudeDegrees, source };
}

export function locateByDevice(
  geolocation: Pick<Geolocation, "getCurrentPosition"> | undefined,
  timeoutMs = 5_000,
): Promise<InitialLocation | undefined> {
  if (!geolocation) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      geolocation.getCurrentPosition(
        (position) => {
          resolve(
            locationFromCoordinates(
              position.coords.latitude,
              position.coords.longitude,
              "device",
            ),
          );
        },
        () => resolve(undefined),
        {
          enableHighAccuracy: true,
          maximumAge: 15 * 60 * 1_000,
          timeout: timeoutMs,
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

export async function locateByIp(
  fetcher: typeof fetch | undefined,
  timeoutMs = 4_000,
): Promise<InitialLocation | undefined> {
  if (!fetcher) return undefined;
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(GEO_IP_ENDPOINT, {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const result = await response.json() as {
      latitude?: unknown;
      longitude?: unknown;
    };
    return locationFromCoordinates(
      result.latitude,
      result.longitude,
      "ip",
    );
  } catch {
    return undefined;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function resolveInitialLocation(
  dependencies: InitialLocationDependencies = {},
): Promise<InitialLocation> {
  const geolocation =
    dependencies.geolocation ?? globalThis.navigator?.geolocation;
  const fetcher =
    dependencies.fetcher ?? globalThis.fetch?.bind(globalThis);
  const deviceLocation = await locateByDevice(
    geolocation,
    dependencies.deviceTimeoutMs,
  );
  if (deviceLocation) return deviceLocation;
  return await locateByIp(fetcher, dependencies.ipTimeoutMs) ??
    GLOBAL_FALLBACK_LOCATION;
}
