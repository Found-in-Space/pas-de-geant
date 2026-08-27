import type { SupervisionEclipseControlState } from "./supervision-protocol.js";

type EclipseTimelineBounds = Pick<
  SupervisionEclipseControlState,
  "contactStartUtc" | "contactEndUtc"
>;

export function supervisorEclipseTimelineUtc(
  eclipse: EclipseTimelineBounds,
  fraction: number,
): string | undefined {
  if (!eclipse.contactStartUtc || !eclipse.contactEndUtc) return;
  const startMs = Date.parse(eclipse.contactStartUtc);
  const endMs = Date.parse(eclipse.contactEndUtc);
  const normalizedFraction = Math.max(0, Math.min(1, fraction));
  return new Date(startMs + (endMs - startMs) * normalizedFraction)
    .toISOString();
}

export function supervisorEclipseTimelineFraction(
  eclipse: EclipseTimelineBounds,
  utc: string,
): number | undefined {
  if (!eclipse.contactStartUtc || !eclipse.contactEndUtc) return;
  const startMs = Date.parse(eclipse.contactStartUtc);
  const endMs = Date.parse(eclipse.contactEndUtc);
  return Math.max(
    0,
    Math.min(1, (Date.parse(utc) - startMs) / (endMs - startMs)),
  );
}
