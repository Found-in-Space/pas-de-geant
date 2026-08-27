import type {
  SupervisionCommand,
  SupervisionNavigationSnapshot,
} from "./supervision-protocol.js";

export interface CanonicalNavigationMutations {
  readonly warp: (
    latitudeDegrees: number,
    longitudeDegrees: number,
  ) => unknown;
  readonly setDisplayRadius: (displayRadiusM: number) => unknown;
  readonly readState: () => SupervisionNavigationSnapshot;
}

export interface WarpCoordinates {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export function applyVoiceWarpMutation(
  coordinates: WarpCoordinates,
  mutations: CanonicalNavigationMutations,
): SupervisionNavigationSnapshot {
  mutations.warp(coordinates.latitudeDegrees, coordinates.longitudeDegrees);
  return mutations.readState();
}

export function applyVoiceDisplayRadiusMutation(
  displayRadiusM: number,
  mutations: CanonicalNavigationMutations,
): SupervisionNavigationSnapshot {
  mutations.setDisplayRadius(displayRadiusM);
  return mutations.readState();
}

export function applySupervisorNavigationMutation(
  command: SupervisionCommand,
  mutations: CanonicalNavigationMutations,
): SupervisionNavigationSnapshot {
  if (command.kind === "warp") {
    mutations.warp(command.latitudeDegrees, command.longitudeDegrees);
  } else {
    mutations.setDisplayRadius(command.displayRadiusM);
  }
  return mutations.readState();
}
