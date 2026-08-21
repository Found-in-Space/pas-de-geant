export interface AircraftStreamingState {
  enabled: boolean;
  vrSessionActive: boolean;
  documentVisible: boolean;
}

export function shouldStreamAircraft(state: AircraftStreamingState): boolean {
  return (
    state.enabled &&
    state.vrSessionActive &&
    state.documentVisible
  );
}

export type AircraftDisplayTarget = "aircraft" | "labels";

export function parseAircraftDisplayArguments(value: unknown): {
  target: AircraftDisplayTarget;
  enabled: boolean;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Aircraft display arguments must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.target !== "aircraft" && candidate.target !== "labels") {
    throw new Error("Aircraft display target must be aircraft or labels.");
  }
  if (typeof candidate.enabled !== "boolean") {
    throw new Error("Aircraft display enabled must be a boolean.");
  }
  return { target: candidate.target, enabled: candidate.enabled };
}
