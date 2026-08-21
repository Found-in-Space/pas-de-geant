import type { EclipseViewPreset } from "./eclipse-types.js";

function record(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function utc(value: unknown, description: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${description} must be a valid ISO 8601 UTC instant.`);
  }
  return new Date(value).toISOString();
}

export function parseEclipseRangeArguments(value: unknown): {
  startUtc: string;
  endUtc: string;
} {
  const candidate = record(value, "Eclipse range arguments");
  const startUtc = utc(candidate["start_utc"], "start_utc");
  const endUtc = utc(candidate["end_utc"], "end_utc");
  if (Date.parse(endUtc) <= Date.parse(startUtc)) {
    throw new Error("end_utc must be after start_utc.");
  }
  return { startUtc, endUtc };
}

export function parseEclipseSelectionArguments(value: unknown): string {
  const eventId = record(value, "Eclipse selection arguments")["event_id"];
  if (typeof eventId !== "string" || !eventId.trim()) {
    throw new Error("event_id must be a non-blank string.");
  }
  return eventId.trim();
}

export function eclipseYearFromEventId(eventId: string): number | null {
  const match = /^solar-(\d{4})-\d{2}-\d{2}-(?:partial|annular|total|hybrid)$/.exec(
    eventId,
  );
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) ? year : null;
}

export function parseEclipseTimeArguments(value: unknown): string {
  return utc(record(value, "Eclipse time arguments")["utc"], "utc");
}

export function parseEclipsePlaybackArguments(value: unknown): boolean {
  const playing = record(value, "Eclipse playback arguments")["playing"];
  if (typeof playing !== "boolean") throw new Error("playing must be boolean.");
  return playing;
}

export function parseEclipseViewArguments(value: unknown): EclipseViewPreset {
  const preset = record(value, "Eclipse view arguments")["preset"];
  if (
    preset !== "system" &&
    preset !== "earth" &&
    preset !== "moon" &&
    preset !== "shadow"
  ) {
    throw new Error("preset must be system, earth, moon, or shadow.");
  }
  return preset;
}

export function parseEclipseScaleArguments(value: unknown): number {
  const scale = record(value, "Eclipse scale arguments")[
    "metres_per_earth_radius"
  ];
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
    throw new Error("metres_per_earth_radius must be positive and finite.");
  }
  return scale;
}
