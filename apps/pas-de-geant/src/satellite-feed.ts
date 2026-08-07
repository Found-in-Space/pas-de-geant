import type { OMMJsonObject } from "satellite.js";
import {
  isSatelliteGroupId,
  type SatelliteGroupId,
} from "./satellite-groups.js";

export const SATELLITE_FEED_PATH = "/api/satellites";
export const SATELLITE_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1_000;

export interface SatelliteGroupPayload {
  readonly group: SatelliteGroupId;
  readonly fetchedAtMs: number;
  readonly satellites: readonly OMMJsonObject[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numericField(value: unknown): boolean {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.trim() !== "" &&
      Number.isFinite(Number(value)))
  );
}

export function isOmmSatellite(value: unknown): value is OMMJsonObject {
  const candidate = record(value);
  return (
    typeof candidate?.OBJECT_NAME === "string" &&
    typeof candidate.OBJECT_ID === "string" &&
    typeof candidate.EPOCH === "string" &&
    numericField(candidate.MEAN_MOTION) &&
    numericField(candidate.ECCENTRICITY) &&
    numericField(candidate.INCLINATION) &&
    numericField(candidate.RA_OF_ASC_NODE) &&
    numericField(candidate.ARG_OF_PERICENTER) &&
    numericField(candidate.MEAN_ANOMALY) &&
    numericField(candidate.NORAD_CAT_ID) &&
    numericField(candidate.ELEMENT_SET_NO) &&
    numericField(candidate.BSTAR) &&
    numericField(candidate.MEAN_MOTION_DOT) &&
    numericField(candidate.MEAN_MOTION_DDOT)
  );
}

export function parseSatelliteGroupPayload(
  value: unknown,
  expectedGroup?: SatelliteGroupId,
): SatelliteGroupPayload {
  const candidate = record(value);
  if (!isSatelliteGroupId(candidate?.group)) {
    throw new Error("Satellite feed returned an unknown group.");
  }
  if (expectedGroup !== undefined && candidate.group !== expectedGroup) {
    throw new Error("Satellite feed returned the wrong group.");
  }
  if (
    typeof candidate.fetchedAtMs !== "number" ||
    !Number.isFinite(candidate.fetchedAtMs)
  ) {
    throw new Error("Satellite feed returned an invalid fetch time.");
  }
  if (!Array.isArray(candidate.satellites)) {
    throw new Error("Satellite feed did not contain orbital elements.");
  }
  return {
    group: candidate.group,
    fetchedAtMs: candidate.fetchedAtMs,
    satellites: candidate.satellites.filter(isOmmSatellite),
  };
}

export async function fetchSatelliteGroup(
  group: SatelliteGroupId,
  signal?: AbortSignal,
): Promise<SatelliteGroupPayload> {
  const url = new URL(SATELLITE_FEED_PATH, window.location.origin);
  url.searchParams.set("group", group);
  const response = await fetch(`${url.pathname}${url.search}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Satellite feed returned HTTP ${response.status}.`);
  }
  return parseSatelliteGroupPayload(await response.json(), group);
}
