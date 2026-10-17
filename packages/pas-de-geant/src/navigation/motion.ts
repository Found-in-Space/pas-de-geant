import * as THREE from "three";
import type { SkykitActionRegistry, SkykitActionMetadata } from "@found-in-space/skykit";
import type { GeantContext } from "../viewer.js";
import { GEANT_ACTIONS } from "./controller.js";
import { headRelativeTravel } from "./controller-input.js";
import { bodyPositionJ2000M, celestialBody } from "../worlds/solar-system.js";
import { relativeJ2000MetresToRender, translatedObserverJ2000M } from "../worlds/world-navigation.js";
import { orbitalAngularStepRadians, orbitalDragRadiansPerPixel, orbitalLogarithmicValue, scaleDenominatorAfterInput, spaceTravelSpeedHeadsetMPerSecond } from "./policy.js";

/** Device-independent commands shared by keyboard, pointer, XR and authored callers. */
export const GEANT_MOTION_ACTIONS = Object.freeze({
  move: "geant:navigation.move", orbit: "geant:navigation.orbitStep",
  orbitDistance: "geant:navigation.adjustOrbitDistance", surfaceDrag: "geant:navigation.dragSurface",
  scale: "geant:scale.adjust", look: "geant:view.look",
});
function args(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Motion arguments are required.");
  return value as Record<string, unknown>;
}
function number(value: Record<string, unknown>, name: string, fallback = 0): number {
  const result = value[name] ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result)) throw new TypeError(`${name} must be finite.`);
  return result;
}

/** Registers behavior independently of device listeners or the controls plugin. */
export function registerGeantMotionActions(geant: GeantContext, actions: SkykitActionRegistry): () => void {
  const invoke = async (id: string, payload: unknown, metadata: SkykitActionMetadata) => {
    const results = await actions.invoke(id, payload, metadata);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    return results;
  };
  const camera = () => geant.renderer.xr?.isPresenting ? geant.renderer.xr.getCamera() : geant.camera;
  const viewQuaternion = () => {
    camera().updateWorldMatrix(true, false);
    return camera().getWorldQuaternion(new THREE.Quaternion());
  };
  function orbitalFrame() {
    const state = geant.navigation.getSnapshot();
    const focus = bodyPositionJ2000M(state.focusBody, new Date(state.time));
    const observer = state.observerJ2000M ?? { x: focus.x + celestialBody(state.focusBody).referenceRadiusM * 3, y: focus.y, z: focus.z };
    const offset = relativeJ2000MetresToRender({ x: observer.x - focus.x, y: observer.y - focus.y, z: observer.z - focus.z }, 1);
    return { state, focus, observer, offset: new THREE.Vector3(offset.x, offset.y, offset.z) };
  }
  const unregisters = [
    actions.registerAction(GEANT_MOTION_ACTIONS.move, ({ payload, metadata }) => {
      const input = args(payload), state = geant.navigation.getSnapshot();
      if (state.mode === "orbit") throw new RangeError("Use orbitStep in orbit mode.");
      const right = number(input, "right"), forward = number(input, "forward");
      const local = new THREE.Vector3(right, 0, -forward);
      if (local.lengthSq() > 1) local.normalize();
      if (!local.lengthSq()) return state;
      const orientation = viewQuaternion();
      const direction = local.clone().applyQuaternion(orientation);
      if (state.mode === "surface") {
        const travel = headRelativeTravel(new THREE.Vector2(local.x, local.z), orientation);
        direction.set(travel.x, 0, travel.y);
        if (direction.lengthSq() > 1) direction.normalize();
      }
      const boosted = number(input, "boost") > 0;
      const radius = celestialBody(state.focusBody).referenceRadiusM / state.scaleDenominator;
      const focusWorld = geant.worlds.get(state.focusBody)?.object3d.getWorldPosition(new THREE.Vector3());
      const distance = focusWorld ? camera().getWorldPosition(new THREE.Vector3()).distanceTo(focusWorld) : radius * 3;
      const speed = input.speedHeadsetMPerSecond !== undefined ? number(input, "speedHeadsetMPerSecond") * (boosted ? 4 : 1)
        : state.mode === "surface" ? (boosted ? 4.2 : 1.35) : spaceTravelSpeedHeadsetMPerSecond("free", radius, distance, boosted);
      direction.multiplyScalar(speed * number(input, "deltaSeconds"));
      if (state.mode === "surface") return invoke(GEANT_ACTIONS.travel, {
        eastM: direction.x * state.scaleDenominator, northM: -direction.z * state.scaleDenominator,
      }, metadata);
      const observer = state.observerJ2000M ?? geant.presentation.observerJ2000M ?? orbitalFrame().observer;
      return invoke(GEANT_ACTIONS.setObserver, translatedObserverJ2000M(observer, direction, state.scaleDenominator), metadata);
    }),
    actions.registerAction(GEANT_MOTION_ACTIONS.surfaceDrag, ({ payload, metadata }) => {
      const input = args(payload), state = geant.navigation.getSnapshot();
      const height = geant.host!.clientHeight;
      if (!height) return state;
      return invoke(GEANT_ACTIONS.travel, { eastM: -number(input, "x") * state.scaleDenominator / height,
        northM: number(input, "y") * state.scaleDenominator / height }, metadata);
    }),
    actions.registerAction(GEANT_MOTION_ACTIONS.scale, ({ payload, metadata }) => {
      const input = args(payload), state = geant.navigation.getSnapshot();
      const value = number(input, "value");
      return invoke(GEANT_ACTIONS.setScale, { scaleDenominator: input.wheel
        ? state.scaleDenominator * 2 ** (value / 600)
        : scaleDenominatorAfterInput(state.scaleDenominator, value, number(input, "deltaSeconds")) }, metadata);
    }),
    actions.registerAction(GEANT_MOTION_ACTIONS.orbit, ({ payload, metadata }) => {
      const input = args(payload), { state, focus, offset } = orbitalFrame();
      if (state.mode !== "orbit") throw new RangeError("Orbital movement requires orbit mode.");
      const x = number(input, "x"), y = number(input, "y");
      if (!x && !y) return state;
      const boosted = number(input, "boost") > 0, delta = number(input, "deltaSeconds");
      const radius = celestialBody(state.focusBody).referenceRadiusM / state.scaleDenominator;
      const focalPixels = (geant.host?.clientHeight || 600) / (2 * Math.tan(geant.camera.fov * Math.PI / 360));
      const perPixel = input.drag ? orbitalDragRadiansPerPixel(offset.length() / state.scaleDenominator, radius, focalPixels, 0.003) : 0;
      const horizontal = input.drag ? -x * perPixel : -orbitalAngularStepRadians(x, delta, boosted);
      const vertical = input.drag ? -y * perPixel : orbitalAngularStepRadians(y, delta, boosted);
      const orientation = viewQuaternion();
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0).applyQuaternion(orientation), horizontal)
        .applyAxisAngle(new THREE.Vector3(1, 0, 0).applyQuaternion(orientation), vertical);
      return invoke(GEANT_ACTIONS.setObserver, translatedObserverJ2000M(focus, offset, 1), metadata);
    }),
    actions.registerAction(GEANT_MOTION_ACTIONS.orbitDistance, ({ payload, metadata }) => {
      const input = args(payload), { state, focus, offset } = orbitalFrame();
      if (state.mode !== "orbit") throw new RangeError("Orbital distance requires orbit mode.");
      const distance = offset.length(), value = number(input, "value");
      if (!distance) return state;
      const next = input.wheel ? distance * 2 ** (value / 600)
        : orbitalLogarithmicValue(distance, value, number(input, "deltaSeconds"), number(input, "boost") > 0);
      return invoke(GEANT_ACTIONS.setObserver, translatedObserverJ2000M(focus, offset.multiplyScalar(next / distance), 1), metadata);
    }),
    actions.registerAction(GEANT_MOTION_ACTIONS.look, ({ payload }) => {
      const input = args(payload), yaw = number(input, "yawRadians"), pitch = number(input, "pitchRadians");
      if (geant.renderer.xr?.isPresenting) geant.cameraRoot.rotation.y += yaw;
      else {
        geant.camera.rotation.order = "YXZ";
        geant.camera.rotation.y += yaw;
        geant.camera.rotation.x = Math.max(-1.35, Math.min(1.1, geant.camera.rotation.x + pitch));
      }
    }),
  ];
  return () => { for (const unregister of unregisters.reverse()) unregister(); };
}
