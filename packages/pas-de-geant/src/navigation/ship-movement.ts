import { Quaternion, Vector3 } from "three";
import { GEANT_ACTIONS } from "./controller.js";
import { GEANT_MOTION_ACTIONS } from "./motion.js";
import { copyRig, focusFrame, headPosition, identityRig, turnRig } from "./model-geometry.js";
import { movementNumber as number, type GeantMovementFrame, type GeantMovementModel } from "./movement-model.js";
import { relativeJ2000MetresToRender, translatedObserverJ2000M } from "../worlds/world-navigation.js";
import { spaceTravelSpeedHeadsetMPerSecond } from "./policy.js";

export interface GeantShipMovementOptions {
  readonly id?: string;
  readonly speedRoomMPerSecond?: number;
  readonly boostMultiplier?: number;
  readonly yawRateRadiansPerSecond?: number;
  readonly pitchRateRadiansPerSecond?: number;
  readonly rollRateRadiansPerSecond?: number;
}
/** Translation and attitude use the ship frame. Looking around never steers the ship. */
export function createGeantShipMovementModel(options: GeantShipMovementOptions = {}): GeantMovementModel {
  let rig = identityRig();
  function observer(frame: GeantMovementFrame) {
    const focus = focusFrame(frame).origin, body = frame.surface(frame.state.focusBody).body;
    return frame.navigation.observerJ2000M ?? { x: focus.x + body.referenceRadiusM * 3, y: focus.y, z: focus.z };
  }
  return {
    id: options.id ?? "ship",
    enter(frame) {
      rig = copyRig(frame.rig);
      if ((frame.reason === "selection" || frame.reason === "tracking") && frame.observerJ2000M) {
        rig.orientation.premultiply(frame.previousSystemRotation.clone().invert()).normalize();
        rig.position.set(0, 0, 0);
        const head = headPosition(frame, rig).multiplyScalar(-1);
        frame.navigation.dispatch(GEANT_ACTIONS.setObserver, translatedObserverJ2000M(frame.observerJ2000M, head, frame.state.scaleDenominator));
      } else if (!frame.navigation.observerJ2000M) frame.navigation.dispatch(GEANT_ACTIONS.setObserver, observer(frame));
    },
    update(frame) {
      return { originJ2000M: observer(frame), systemRotation: new Quaternion(), translation: new Vector3(), rig };
    },
    command(action, input, frame) {
      if (action === GEANT_MOTION_ACTIONS.move) {
        const direction = new Vector3(number(input, "right"), number(input, "up"), -number(input, "forward"));
        if (direction.lengthSq() > 1) direction.normalize();
        if (!direction.lengthSq()) return frame.state;
        direction.applyQuaternion(rig.orientation);
        const focus = focusFrame(frame).origin, origin = observer(frame);
        const offset = relativeJ2000MetresToRender({ x: origin.x - focus.x, y: origin.y - focus.y, z: origin.z - focus.z }, frame.state.scaleDenominator);
        const radius = frame.surface(frame.state.focusBody).body.referenceRadiusM / frame.state.scaleDenominator;
        const boosted = number(input, "boost") > 0;
        const speed = input.speedHeadsetMPerSecond !== undefined ? number(input, "speedHeadsetMPerSecond")
          : options.speedRoomMPerSecond ?? spaceTravelSpeedHeadsetMPerSecond("free", radius, Math.hypot(offset.x, offset.y, offset.z), false);
        direction.multiplyScalar(speed * (boosted ? options.boostMultiplier ?? 4 : 1) * number(input, "deltaSeconds"));
        return frame.invoke(GEANT_ACTIONS.setObserver, translatedObserverJ2000M(origin, direction, frame.state.scaleDenominator));
      }
      if (action === GEANT_MOTION_ACTIONS.attitude) {
        const delta = number(input, "deltaSeconds");
        rig = turnRig(rig, frame, number(input, "yaw") * (options.yawRateRadiansPerSecond ?? Math.PI * 0.375) * delta,
          number(input, "pitch") * (options.pitchRateRadiansPerSecond ?? Math.PI * 0.3) * delta,
          number(input, "roll") * (options.rollRateRadiansPerSecond ?? Math.PI * 0.375) * delta);
        return;
      }
      if (action === GEANT_MOTION_ACTIONS.look) {
        rig = turnRig(rig, frame, number(input, "yawRadians"), frame.xr ? 0 : number(input, "pitchRadians")); return;
      }
      throw new RangeError(`Ship movement does not implement ${action}.`);
    },
  };
}
