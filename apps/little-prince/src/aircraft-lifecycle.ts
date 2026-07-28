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
