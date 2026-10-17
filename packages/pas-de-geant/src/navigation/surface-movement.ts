import { Euler, Quaternion, Vector2, Vector3 } from "three";
import { GEANT_ACTIONS } from "./controller.js";
import { GEANT_MOTION_ACTIONS } from "./motion.js";
import { headRelativeTravel } from "./controller-input.js";
import { copyRig, headOrientation, identityRig, retainSurfaceObserver, surfacePlacement, turnRig, type GeantHeightReference } from "./model-geometry.js";
import { movementNumber as number, type GeantMovementModel } from "./movement-model.js";

export interface GeantSurfaceMovementOptions {
  readonly id?: string;
  readonly heightReference?: GeantHeightReference;
  readonly speedRoomMPerSecond?: number;
  /** Omit to move vertically at 0.5 room metres per second, converted to physical metres. */
  readonly altitudeSpeedMPerSecond?: number;
  readonly retainObserverOnEntry?: boolean;
}
/** Places a surface under the floor anchor. Head height remains tracked. */
export function createGeantSurfaceMovementModel(options: GeantSurfaceMovementOptions = {}): GeantMovementModel {
  const reference = options.heightReference ?? "terrain";
  let rig = identityRig(), previousTracking: Vector3 | undefined, desktopOrientation: Quaternion | undefined;
  return {
    id: options.id ?? "surface",
    enter(frame) {
      rig = copyRig(frame.rig);
      // The surface normal defines gravity. Preserve yaw, but remove ship pitch and roll.
      const yaw = new Euler().setFromQuaternion(rig.orientation, "YXZ").y;
      rig.orientation.setFromAxisAngle(new Vector3(0, 1, 0), yaw); rig.position.set(0, 0, 0);
      previousTracking = undefined; desktopOrientation = undefined;
      if (options.retainObserverOnEntry === true) retainSurfaceObserver({ ...frame, rig }, reference);
    },
    update(frame) {
      if (frame.xr && frame.tracking.tracked) {
        if (previousTracking) {
          const delta = frame.tracking.position.clone().sub(previousTracking).applyQuaternion(rig.orientation);
          if (delta.x || delta.z) frame.navigation.dispatch(GEANT_ACTIONS.travel, {
            eastM: delta.x * frame.state.scaleDenominator, northM: -delta.z * frame.state.scaleDenominator });
        }
        previousTracking = frame.tracking.position.clone();
      } else previousTracking = undefined;
      return { ...surfacePlacement(frame, rig, reference), ...(desktopOrientation ? { desktopOrientation } : {}) };
    },
    leave() { previousTracking = undefined; },
    command(action, input, frame) {
      if (action === GEANT_MOTION_ACTIONS.move) {
        const local = new Vector2(number(input, "right"), -number(input, "forward"));
        if (local.lengthSq() > 1) local.normalize();
        if (!local.lengthSq()) return frame.state;
        const travel = headRelativeTravel(local, headOrientation(frame, rig));
        if (travel.lengthSq() > 1) travel.normalize();
        const boost = number(input, "boost") > 0;
        const speed = input.speedHeadsetMPerSecond !== undefined ? number(input, "speedHeadsetMPerSecond") * (boost ? 4 : 1)
          : options.speedRoomMPerSecond !== undefined ? options.speedRoomMPerSecond * (boost ? 4 : 1) : boost ? 4.2 : 1.35;
        travel.multiplyScalar(speed * number(input, "deltaSeconds") * frame.state.scaleDenominator);
        return frame.invoke(GEANT_ACTIONS.travel, { eastM: travel.x, northM: -travel.y });
      }
      if (action === GEANT_MOTION_ACTIONS.altitude) {
        const rate = options.altitudeSpeedMPerSecond ?? 0.5 * frame.state.scaleDenominator;
        return frame.invoke(GEANT_ACTIONS.setAltitude, { altitudeM: frame.state.locations[frame.state.focusBody]!.altitudeM +
          number(input, "value") * rate * number(input, "deltaSeconds") });
      }
      if (action === GEANT_MOTION_ACTIONS.surfaceDrag) {
        if (!frame.viewportHeight) return frame.state;
        return frame.invoke(GEANT_ACTIONS.travel, { eastM: -number(input, "x") * frame.state.scaleDenominator / frame.viewportHeight,
          northM: number(input, "y") * frame.state.scaleDenominator / frame.viewportHeight });
      }
      if (action === GEANT_MOTION_ACTIONS.look) {
        const yaw = number(input, "yawRadians"), pitch = number(input, "pitchRadians");
        if (frame.xr) rig = turnRig(rig, frame, yaw);
        else {
          const angles = new Euler().setFromQuaternion(desktopOrientation ?? frame.tracking.orientation, "YXZ");
          angles.y += yaw; angles.x = Math.max(-1.35, Math.min(1.1, angles.x + pitch));
          desktopOrientation = new Quaternion().setFromEuler(angles);
        }
        return;
      }
      throw new RangeError(`Surface movement does not implement ${action}.`);
    },
  };
}
