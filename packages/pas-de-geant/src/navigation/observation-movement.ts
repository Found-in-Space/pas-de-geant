import { Euler, Quaternion, Vector3 } from "three";
import { earthToWorldQuaternion } from "../worlds/planet-state.js";
import { GEANT_ACTIONS } from "./controller.js";
import { GEANT_MOTION_ACTIONS } from "./motion.js";
import { copyRig, focusFrame, headOrientation, headPosition, identityRig, turnRig, type GeantHeightReference } from "./model-geometry.js";
import { movementNumber as number, type GeantMovementFrame, type GeantMovementModel, type GeantRigPose } from "./movement-model.js";

export interface GeantObservationMovementOptions {
  readonly id?: string;
  readonly distanceRoomM?: number;
  readonly heightReference?: GeantHeightReference;
  readonly heightSpeedRoomMPerSecond?: number;
  readonly speedRoomMPerSecond?: number;
  /** Local +Z is the outward surface normal. Local +Y is the top of the map. */
  readonly anchor?: GeantRigPose;
}
/** Holds an observation plane in room space. Walking never selects another contact. */
export function createGeantObservationMovementModel(options: GeantObservationMovementOptions = {}) {
  let anchor = options.anchor ? copyRig(options.anchor) : null, authored = Boolean(options.anchor);
  let rig = identityRig(), capturePending = !authored;
  function capture(frame: GeantMovementFrame) {
    const yaw = new Euler().setFromQuaternion(headOrientation(frame, rig), "YXZ").y;
    const orientation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    anchor = { orientation, position: headPosition(frame, rig).add(new Vector3(0, 0, -(options.distanceRoomM ?? 2)).applyQuaternion(orientation)) };
  }
  return {
    id: options.id ?? "observation",
    getAnchor() { return anchor ? copyRig(anchor) : null; },
    setAnchor(pose: GeantRigPose) { anchor = copyRig(pose); authored = true; capturePending = false; },
    enter(frame) {
      rig = copyRig(frame.rig);
      const yaw = new Euler().setFromQuaternion(rig.orientation, "YXZ").y;
      rig.orientation.setFromAxisAngle(new Vector3(0, 1, 0), yaw); rig.position.set(0, 0, 0);
      capturePending = !authored;
      if (capturePending && frame.tracking.tracked) { capture(frame); capturePending = false; }
    },
    update(frame) {
      if (!anchor || capturePending && frame.tracking.tracked) { capture(frame); capturePending = !frame.tracking.tracked; }
      const state = frame.navigation.getSnapshot(), location = state.locations[state.focusBody]!;
      const surface = frame.surface(state.focusBody), focus = focusFrame({ ...frame, state });
      const { position, normal } = surface.geometry.positionAndNormal(location.latitudeDegrees, location.longitudeDegrees);
      const elevation = options.heightReference === "terrain" ? surface.sampleElevationMetres(location.latitudeDegrees, location.longitudeDegrees) * state.terrainMultiplier : 0;
      position.addScaledVector(normal, elevation / surface.geometry.referenceRadiusM).multiplyScalar(surface.geometry.referenceRadiusM / state.scaleDenominator);
      // The shared contact frame maps normal to +Y and north to -Z.
      const contact = frame.navigation.getContact();
      const bodyToWorld = earthToWorldQuaternion(contact);
      const rotation = anchor!.orientation.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2)).multiply(bodyToWorld);
      const translation = anchor!.position.clone().sub(position.applyQuaternion(rotation));
      return { originJ2000M: focus.origin, systemRotation: rotation.multiply(focus.attitude.invert()), translation, rig };
    },
    command(action, input, frame) {
      if (action === GEANT_MOTION_ACTIONS.move) {
        const direction = new Vector3(number(input, "right"), number(input, "forward"), 0);
        if (direction.lengthSq() > 1) direction.normalize();
        if (!direction.lengthSq()) return frame.state;
        const speed = number(input, "speedHeadsetMPerSecond", options.speedRoomMPerSecond ?? 1.35) * (number(input, "boost") > 0 ? 4 : 1);
        direction.multiplyScalar(speed * number(input, "deltaSeconds") * frame.state.scaleDenominator);
        return frame.invoke(GEANT_ACTIONS.travel, { eastM: direction.x, northM: direction.y });
      }
      if (action === GEANT_MOTION_ACTIONS.altitude) {
        if (!anchor) capture(frame);
        anchor!.position.y += number(input, "value") * (options.heightSpeedRoomMPerSecond ?? 0.5) * number(input, "deltaSeconds");
        return;
      }
      if (action === GEANT_MOTION_ACTIONS.recenter) { authored = false; capturePending = !frame.tracking.tracked; capture(frame); return; }
      if (action === GEANT_MOTION_ACTIONS.look) { rig = turnRig(rig, frame, number(input, "yawRadians")); return; }
      throw new RangeError(`Observation movement does not implement ${action}.`);
    },
  } satisfies GeantMovementModel & { getAnchor(): GeantRigPose | null; setAnchor(pose: GeantRigPose): void };
}
