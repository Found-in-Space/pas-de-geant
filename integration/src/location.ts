export interface DetectedLocation {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly source: "device" | "ip";
}

function coordinates(latitude: unknown, longitude: unknown, source: DetectedLocation["source"]): DetectedLocation | undefined {
  if ((typeof latitude !== "number" && typeof latitude !== "string") ||
    (typeof longitude !== "number" && typeof longitude !== "string") ||
    String(latitude).trim() === "" || String(longitude).trim() === "") return;
  const latitudeDegrees = Number(latitude), longitudeDegrees = Number(longitude);
  if (Number.isFinite(latitudeDegrees) && Math.abs(latitudeDegrees) <= 90 &&
    Number.isFinite(longitudeDegrees) && Math.abs(longitudeDegrees) <= 180) {
    return { latitudeDegrees, longitudeDegrees, source };
  }
}

/** Browser permission first, then an approximate IP location, as in the former main app. */
export async function detectLocation(options: {
  readonly geolocation?: Pick<Geolocation, "getCurrentPosition"> | null;
  readonly fetcher?: typeof fetch;
  readonly signal?: AbortSignal;
} = {}): Promise<DetectedLocation | undefined> {
  const geolocation = options.geolocation === undefined ? globalThis.navigator?.geolocation : options.geolocation;
  const device = await new Promise<DetectedLocation | undefined>((resolve) => {
    if (!geolocation || options.signal?.aborted) { resolve(undefined); return; }
    const aborted = () => finish(undefined);
    const finish = (value: DetectedLocation | undefined) => {
      options.signal?.removeEventListener("abort", aborted);
      resolve(value);
    };
    options.signal?.addEventListener("abort", aborted, { once: true });
    try {
      geolocation.getCurrentPosition(position => finish(coordinates(position.coords.latitude, position.coords.longitude, "device")),
        () => finish(undefined), { enableHighAccuracy: true, maximumAge: 15 * 60_000, timeout: 5_000 });
    } catch { finish(undefined); }
  });
  options.signal?.throwIfAborted();
  if (device) return device;
  try {
    const response = await (options.fetcher ?? fetch)("https://get.geojs.io/v1/ip/geo.json", {
      cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json" },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(4_000)]) : AbortSignal.timeout(4_000),
    });
    if (!response.ok) return;
    const value = await response.json();
    return coordinates(value.latitude, value.longitude, "ip");
  } catch { options.signal?.throwIfAborted(); return; }
}
