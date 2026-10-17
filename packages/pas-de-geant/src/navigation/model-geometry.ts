import { Euler, Quaternion, Vector2, Vector3 } from "three";
import { bodyPositionJ2000M, bodyRotation } from "../worlds/solar-system.js";
import { bodyFixedToRenderQuaternion } from "../worlds/body-attitude.js";
import { displayRadiusForScale, relativeJ2000MetresToRender } from "../worlds/world-navigation.js";
import { solveBodySurfacePose } from "../worlds/planet-state.js";
import { referenceSurfaceObservation } from "../worlds/surface-observation.js";
import { GEANT_ACTIONS } from "./controller.js";
import type { GeantMovementFrame, GeantPlacement, GeantRigPose } from "./movement-model.js";

export type GeantHeightReference = "terrain" | "reference";
export const identityRig = (): GeantRigPose => ({ position: new Vector3(), orientation: new Quaternion() });
export const copyRig = (rig: GeantRigPose): GeantRigPose => ({ position: rig.position.clone(), orientation: rig.orientation.clone() });
export const headPosition = (frame: GeantMovementFrame, rig = frame.rig): Vector3 =>
  frame.tracking.position.clone().applyQuaternion(rig.orientation).add(rig.position);
export const headOrientation = (frame: GeantMovementFrame, rig = frame.rig): Quaternion =>
  rig.orientation.clone().multiply(frame.tracking.orientation);
export function focusFrame(frame: GeantMovementFrame) {
  const at = new Date(frame.state.time);
  return { origin: bodyPositionJ2000M(frame.state.focusBody, at),
    attitude: bodyFixedToRenderQuaternion(bodyRotation(frame.state.focusBody, at)) };
}
export function surfacePlacement(frame: GeantMovementFrame, rig: GeantRigPose, reference: GeantHeightReference): GeantPlacement {
  const state = frame.navigation.getSnapshot(), surface = frame.surface(state.focusBody), location = state.locations[state.focusBody]!;
  const head = headPosition(frame, rig), focus = focusFrame({ ...frame, state });
  const elevation = reference === "terrain" ? surface.sampleElevationMetres(location.latitudeDegrees, location.longitudeDegrees) : 0;
  const pose = solveBodySurfacePose({ contact: frame.navigation.getContact(), terrainMultiplier: state.terrainMultiplier },
    new Vector2(head.x, head.z), displayRadiusForScale(state.focusBody, state.scaleDenominator), surface.geometry, elevation);
  pose.centre.y -= location.altitudeM / state.scaleDenominator;
  return { originJ2000M: focus.origin, systemRotation: pose.bodyToWorld.multiply(focus.attitude.invert()), translation: pose.centre, rig };
}
/** Reconstruct a floor anchor when a different model supplies an existing eye position. */
export function retainSurfaceObserver(frame: GeantMovementFrame, reference: GeantHeightReference) {
  if (frame.reason !== "selection" || !frame.observerJ2000M) return;
  const state = frame.state, focus = focusFrame(frame), surface = frame.surface(state.focusBody);
  const relative = relativeJ2000MetresToRender({ x: frame.observerJ2000M.x - focus.origin.x,
    y: frame.observerJ2000M.y - focus.origin.y, z: frame.observerJ2000M.z - focus.origin.z }, 1);
  const observed = referenceSurfaceObservation(surface.body, new Vector3(relative.x, relative.y, relative.z).applyQuaternion(focus.attitude.invert()));
  const elevation = reference === "terrain" ? surface.sampleElevationMetres(observed.latitudeDegrees, observed.longitudeDegrees) : 0;
  frame.navigation.dispatch(GEANT_ACTIONS.setLocation, { latitudeDegrees: observed.latitudeDegrees, longitudeDegrees: observed.longitudeDegrees,
    altitudeM: observed.heightMetres - elevation * state.terrainMultiplier - headPosition(frame).y * state.scaleDenominator });
}
/** Turn about the eye. A turn does not create an artificial walking displacement. */
export function turnRig(rig: GeantRigPose, frame: GeantMovementFrame, yaw: number, pitch = 0, roll = 0): GeantRigPose {
  const pivot = headPosition(frame, rig);
  const rotation = new Quaternion().setFromEuler(new Euler(pitch, yaw, -roll, "YXZ"));
  const orientation = rig.orientation.clone().multiply(rotation).normalize();
  return { orientation, position: pivot.sub(frame.tracking.position.clone().applyQuaternion(orientation)) };
}
