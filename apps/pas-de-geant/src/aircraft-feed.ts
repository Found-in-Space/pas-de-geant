export const AIRPLANES_LIVE_BASE_URL = "https://api.airplanes.live/v2/point";
export const AIRCRAFT_QUERY_RADIUS_NM = 250;
export const AIRCRAFT_POLL_INTERVAL_MS = 30_000;
export const AIRCRAFT_EXTRAPOLATION_LIMIT_MS = 30_000;

const EARTH_RADIUS_NM = 3_440.065;

export interface TrackedAircraft {
  id: string;
  callsign: string;
  latitudeDegrees: number;
  longitudeDegrees: number;
  altitudeFt: number;
  groundSpeedKt: number;
  trackDegrees: number;
  trackRateDegreesPerSecond: number;
  sampledAtMs: number;
}

interface AirplanesLivePayload {
  ac?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

export function airplanesLiveUrl(
  latitudeDegrees: number,
  longitudeDegrees: number,
  radiusNm = AIRCRAFT_QUERY_RADIUS_NM,
): string {
  const latitude = Math.max(-90, Math.min(90, latitudeDegrees));
  const longitude =
    ((longitudeDegrees + 180) % 360 + 360) % 360 - 180;
  const radius = Math.max(1, Math.min(250, Math.round(radiusNm)));
  return (
    `${AIRPLANES_LIVE_BASE_URL}/${latitude.toFixed(4)}/` +
    `${longitude.toFixed(4)}/${radius}`
  );
}

export function parseAirplanesLive(
  payload: unknown,
  receivedAtMs = Date.now(),
): TrackedAircraft[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("Airplanes.live returned an invalid response.");
  }
  const aircraft = (payload as AirplanesLivePayload).ac;
  if (!Array.isArray(aircraft)) {
    throw new Error("Airplanes.live response did not contain aircraft.");
  }

  const parsed: TrackedAircraft[] = [];
  for (const value of aircraft) {
    if (!value || typeof value !== "object") continue;
    const raw = value as Record<string, unknown>;
    const latitudeDegrees = finiteNumber(raw.lat);
    const longitudeDegrees = finiteNumber(raw.lon);
    const id = trimmedString(raw.hex);
    if (
      latitudeDegrees === undefined ||
      longitudeDegrees === undefined ||
      !id
    ) {
      continue;
    }

    const altitudeValue =
      finiteNumber(raw.alt_baro) ?? finiteNumber(raw.alt_geom);
    if (altitudeValue === undefined || raw.alt_baro === "ground") continue;

    const seenSeconds = Math.max(0, finiteNumber(raw.seen_pos) ?? 0);
    parsed.push({
      id: id.toUpperCase(),
      callsign:
        trimmedString(raw.flight) ??
        trimmedString(raw.r) ??
        id.toUpperCase(),
      latitudeDegrees,
      longitudeDegrees,
      altitudeFt: altitudeValue,
      groundSpeedKt: Math.max(0, finiteNumber(raw.gs) ?? 0),
      trackDegrees:
        finiteNumber(raw.track) ??
        finiteNumber(raw.true_heading) ??
        finiteNumber(raw.mag_heading) ??
        0,
      trackRateDegreesPerSecond: finiteNumber(raw.track_rate) ?? 0,
      sampledAtMs: receivedAtMs - seenSeconds * 1_000,
    });
  }
  return parsed;
}

export function extrapolateAircraft(
  aircraft: TrackedAircraft,
  atMs: number,
): TrackedAircraft {
  const elapsedSeconds = Math.max(
    0,
    Math.min(
      AIRCRAFT_EXTRAPOLATION_LIMIT_MS,
      atMs - aircraft.sampledAtMs,
    ) / 1_000,
  );
  const finalTrack =
    aircraft.trackDegrees +
    aircraft.trackRateDegreesPerSecond * elapsedSeconds;
  if (elapsedSeconds === 0 || aircraft.groundSpeedKt === 0) {
    return { ...aircraft, trackDegrees: normalizeDegrees(finalTrack) };
  }

  const meanTrack =
    aircraft.trackDegrees +
    aircraft.trackRateDegreesPerSecond * elapsedSeconds / 2;
  const bearing = meanTrack * Math.PI / 180;
  const angularDistance =
    aircraft.groundSpeedKt * elapsedSeconds / 3_600 / EARTH_RADIUS_NM;
  const latitude = aircraft.latitudeDegrees * Math.PI / 180;
  const longitude = aircraft.longitudeDegrees * Math.PI / 180;
  const nextLatitude = Math.asin(
    Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) *
        Math.sin(angularDistance) *
        Math.cos(bearing),
  );
  const nextLongitude =
    longitude +
    Math.atan2(
      Math.sin(bearing) *
        Math.sin(angularDistance) *
        Math.cos(latitude),
      Math.cos(angularDistance) -
        Math.sin(latitude) * Math.sin(nextLatitude),
    );

  return {
    ...aircraft,
    latitudeDegrees: nextLatitude * 180 / Math.PI,
    longitudeDegrees:
      ((nextLongitude * 180 / Math.PI + 180) % 360 + 360) % 360 - 180,
    trackDegrees: normalizeDegrees(finalTrack),
  };
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

export async function fetchAirplanesLive(
  latitudeDegrees: number,
  longitudeDegrees: number,
  signal?: AbortSignal,
): Promise<TrackedAircraft[]> {
  const response = await fetch(
    airplanesLiveUrl(latitudeDegrees, longitudeDegrees),
    {
      headers: { Accept: "application/json" },
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Airplanes.live returned HTTP ${response.status}.`);
  }
  return parseAirplanesLive(await response.json());
}
