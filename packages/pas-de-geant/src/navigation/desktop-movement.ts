import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { createGeantSurfaceMovementModel } from "./surface-movement.js";
import { GEANT_ACTIONS } from "./controller.js";
import { GEANT_MOTION_ACTIONS } from "./motion.js";
import { focusFrame, headOrientation, identityRig } from "./model-geometry.js";
import { movementNumber as number, type GeantMovementFrame, type GeantMovementModel } from "./movement-model.js";
import { relativeJ2000MetresToRender, translatedObserverJ2000M } from "../worlds/world-navigation.js";
import { orbitalAngularStepRadians, orbitalDragRadiansPerPixel, orbitalLogarithmicValue, spaceTravelSpeedHeadsetMPerSecond } from "./policy.js";

/** Desktop policy is separate from the XR metaphors. This model retains centre-based orbit controls. */
export function createGeantDesktopMovementModel(): GeantMovementModel {
  const surface = createGeantSurfaceMovementModel({ retainObserverOnEntry: true });
  let orientation: Quaternion | undefined;
  let orbitCentre: { x: number; y: number; z: number } | undefined;
  const isOrbit = (frame: GeantMovementFrame) => frame.state.mode === "orbit" || frame.state.mode === "observation";
  function orbitalFrame(frame: GeantMovementFrame) {
    const focus = focusFrame(frame).origin;
    let observer = frame.navigation.observerJ2000M ?? { x: focus.x + frame.surface(frame.state.focusBody).body.referenceRadiusM * 3, y: focus.y, z: focus.z };
    if (isOrbit(frame)) {
      // Preserve the orbit offset when the body's ephemeris position changes,
      // including clock seeks. Free flight remains in the inertial frame.
      if (orbitCentre && (focus.x !== orbitCentre.x || focus.y !== orbitCentre.y || focus.z !== orbitCentre.z)) {
        observer = { x: focus.x + (observer.x - orbitCentre.x),
          y: focus.y + (observer.y - orbitCentre.y), z: focus.z + (observer.z - orbitCentre.z) };
        frame.navigation.dispatch(GEANT_ACTIONS.setObserver, observer);
      }
      orbitCentre = { ...focus };
    }
    const offset = relativeJ2000MetresToRender({ x: observer.x - focus.x, y: observer.y - focus.y, z: observer.z - focus.z }, 1);
    return { focus, observer, offset: new Vector3(offset.x, offset.y, offset.z) };
  }
  return {
    id: "desktop",
    enter(frame) {
      orientation = undefined;
      orbitCentre = undefined;
      if (frame.xr) throw new Error("Use an XR movement model for an immersive session.");
      if (frame.state.mode === "surface") surface.enter?.(frame);
      else {
        const observer = (frame.reason === "selection" || frame.reason === "tracking") && frame.observerJ2000M ? frame.observerJ2000M : orbitalFrame(frame).observer;
        frame.navigation.dispatch(GEANT_ACTIONS.setObserver, observer);
      }
    },
    leave(frame) { orbitCentre = undefined; surface.leave?.(frame); },
    update(frame) {
      if (frame.state.mode === "surface") return surface.update(frame);
      const { focus, observer } = orbitalFrame(frame);
      if (isOrbit(frame)) {
        const target = relativeJ2000MetresToRender({ x: focus.x - observer.x, y: focus.y - observer.y, z: focus.z - observer.z }, frame.state.scaleDenominator);
        orientation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(new Vector3(), new Vector3(target.x, target.y, target.z), new Vector3(0, 1, 0)));
      }
      return { originJ2000M: observer, systemRotation: new Quaternion(), translation: new Vector3(), rig: identityRig(),
        desktopPosition: new Vector3(), ...(orientation ? { desktopOrientation: orientation } : {}) };
    },
    command(action, input, frame) {
      if (frame.state.mode === "surface") return surface.command?.(action, input, frame);
      const { focus, observer, offset } = orbitalFrame(frame);
      if (action === GEANT_MOTION_ACTIONS.move) {
        if (isOrbit(frame)) throw new RangeError("Use orbitStep for desktop orbit movement.");
        const direction = new Vector3(number(input, "right"), 0, -number(input, "forward"));
        if (direction.lengthSq() > 1) direction.normalize();
        if (!direction.lengthSq()) return frame.state;
        direction.applyQuaternion(headOrientation(frame));
        const boost = number(input, "boost") > 0;
        const speed = input.speedHeadsetMPerSecond !== undefined ? number(input, "speedHeadsetMPerSecond") * (boost ? 4 : 1)
          : spaceTravelSpeedHeadsetMPerSecond("free", frame.surface(frame.state.focusBody).body.referenceRadiusM / frame.state.scaleDenominator,
            offset.length() / frame.state.scaleDenominator, boost);
        direction.multiplyScalar(speed * number(input, "deltaSeconds"));
        return frame.invoke(GEANT_ACTIONS.setObserver, translatedObserverJ2000M(observer, direction, frame.state.scaleDenominator));
      }
      if (action === GEANT_MOTION_ACTIONS.orbit) {
        if (!isOrbit(frame)) throw new RangeError("Orbital movement requires desktop orbit mode.");
        const x = number(input, "x"), y = number(input, "y");
        if (!x && !y) return frame.state;
        const boost = number(input, "boost") > 0, delta = number(input, "deltaSeconds");
        const radius = frame.surface(frame.state.focusBody).body.referenceRadiusM / frame.state.scaleDenominator;
        const perPixel = input.drag ? orbitalDragRadiansPerPixel(offset.length() / frame.state.scaleDenominator, radius, frame.focalLengthPixels, 0.003) : 0;
        const horizontal = input.drag ? -x * perPixel : -orbitalAngularStepRadians(x, delta, boost);
        const vertical = input.drag ? -y * perPixel : orbitalAngularStepRadians(y, delta, boost);
        const view = headOrientation(frame);
        offset.applyAxisAngle(new Vector3(0, 1, 0).applyQuaternion(view), horizontal)
          .applyAxisAngle(new Vector3(1, 0, 0).applyQuaternion(view), vertical);
        return frame.invoke(GEANT_ACTIONS.setObserver, translatedObserverJ2000M(focus, offset, 1));
      }
      if (action === GEANT_MOTION_ACTIONS.orbitDistance) {
        if (!isOrbit(frame)) throw new RangeError("Orbital distance requires desktop orbit mode.");
        const distance = offset.length(), value = number(input, "value");
        if (!distance) return frame.state;
        const next = input.wheel ? distance * 2 ** (value / 600)
          : orbitalLogarithmicValue(distance, value, number(input, "deltaSeconds"), number(input, "boost") > 0);
        return frame.invoke(GEANT_ACTIONS.setObserver, translatedObserverJ2000M(focus, offset.multiplyScalar(next / distance), 1));
      }
      if (action === GEANT_MOTION_ACTIONS.look) {
        const angles = new Euler().setFromQuaternion(orientation ?? frame.tracking.orientation, "YXZ");
        angles.y += number(input, "yawRadians"); angles.x = Math.max(-1.35, Math.min(1.1, angles.x + number(input, "pitchRadians")));
        orientation = new Quaternion().setFromEuler(angles); return;
      }
      throw new RangeError(`Desktop movement does not implement ${action}.`);
    },
  };
}
