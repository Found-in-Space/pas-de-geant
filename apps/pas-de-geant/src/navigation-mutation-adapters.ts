import type {
  SupervisionCommand,
  SupervisionNavigationSnapshot,
} from "./supervision-protocol.js";
import type { LocationPin, LocationPinState } from "./location-pin.js";

export interface CanonicalNavigationMutations {
  readonly warp: (
    latitudeDegrees: number,
    longitudeDegrees: number,
    time?: number,
  ) => unknown;
  readonly setScaleDenominator: (
    scaleDenominator: number,
    time?: number,
  ) => unknown;
  readonly setTerrainMultiplier: (terrainMultiplier: number) => unknown;
  readonly setHeading: (headingDegrees: number, time?: number) => unknown;
  readonly readState: () => SupervisionNavigationSnapshot;
}

export interface WarpCoordinates {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly time?: number;
}

type NavigationSupervisionCommand = Extract<
  SupervisionCommand,
  {
    kind:
      | "warp"
      | "setScaleDenominator"
      | "setTerrainMultiplier"
      | "setHeading";
  }
>;

type PinSupervisionCommand = Extract<
  SupervisionCommand,
  { kind: "setPin" | "removePin" | "setPinGuidance" }
>;

export interface CanonicalLocationPinMutations {
  readonly setPin: (pin: LocationPin) => unknown;
  readonly removePin: (pinId: string) => unknown;
  readonly setPinVisibility: (pinId: string, visible: boolean) => unknown;
  readonly renamePin: (pinId: string, label: string) => unknown;
  readonly setPinGuidance: (pinId: string, enabled: boolean) => unknown;
  readonly readPinState: () => LocationPinState;
}

export function applyVoiceWarpMutation(
  coordinates: WarpCoordinates,
  mutations: CanonicalNavigationMutations,
): SupervisionNavigationSnapshot {
  mutations.warp(
    coordinates.latitudeDegrees,
    coordinates.longitudeDegrees,
    coordinates.time,
  );
  return mutations.readState();
}

export function applyVoiceScaleDenominatorMutation(
  scaleDenominator: number,
  mutations: CanonicalNavigationMutations,
  time?: number,
): SupervisionNavigationSnapshot {
  mutations.setScaleDenominator(scaleDenominator, time);
  return mutations.readState();
}

export function applySupervisorNavigationMutation(
  command: NavigationSupervisionCommand,
  mutations: CanonicalNavigationMutations,
): SupervisionNavigationSnapshot {
  if (command.kind === "warp") {
    mutations.warp(
      command.latitudeDegrees,
      command.longitudeDegrees,
      command.time,
    );
  } else if (command.kind === "setScaleDenominator") {
    mutations.setScaleDenominator(command.scaleDenominator, command.time);
  } else if (command.kind === "setTerrainMultiplier") {
    mutations.setTerrainMultiplier(command.terrainMultiplier);
  } else {
    mutations.setHeading(command.headingDegrees, command.time);
  }
  return mutations.readState();
}

export function applySupervisorLocationPinMutation(
  command: PinSupervisionCommand,
  mutations: CanonicalLocationPinMutations,
): LocationPinState {
  if (command.kind === "setPin") {
    mutations.setPin(command.pin);
  } else if (command.kind === "removePin") {
    mutations.removePin(command.pinId);
  } else {
    if (command.enabled) mutations.setPin(command.pin);
    mutations.setPinGuidance(command.pin.pinId, command.enabled);
  }
  return mutations.readPinState();
}

export function applyVoiceSetPinMutation(
  pin: LocationPin,
  mutations: CanonicalLocationPinMutations,
): LocationPinState {
  mutations.setPin(pin);
  return mutations.readPinState();
}

export function applyVoiceRemovePinMutation(
  pinId: string,
  mutations: CanonicalLocationPinMutations,
): LocationPinState {
  mutations.removePin(pinId);
  return mutations.readPinState();
}

export function applyVoiceSetPinVisibilityMutation(
  pinId: string,
  visible: boolean,
  mutations: CanonicalLocationPinMutations,
): LocationPinState {
  mutations.setPinVisibility(pinId, visible);
  return mutations.readPinState();
}

export function applyVoiceRenamePinMutation(
  pinId: string,
  label: string,
  mutations: CanonicalLocationPinMutations,
): LocationPinState {
  mutations.renamePin(pinId, label);
  return mutations.readPinState();
}

export function applyVoiceSetPinGuidanceMutation(
  pinId: string,
  enabled: boolean,
  mutations: CanonicalLocationPinMutations,
): LocationPinState {
  mutations.setPinGuidance(pinId, enabled);
  return mutations.readPinState();
}
