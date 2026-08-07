export interface AircraftPollingState {
  enabled: boolean;
  vrSessionActive: boolean;
  documentVisible: boolean;
  requestActive: boolean;
}

export function shouldPollAircraft(state: AircraftPollingState): boolean {
  return (
    state.enabled &&
    state.vrSessionActive &&
    state.documentVisible &&
    !state.requestActive
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
