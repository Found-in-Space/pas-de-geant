import * as THREE from "three";
import type { SkykitPlugin } from "@found-in-space/skykit";
import { getGeantContext } from "../viewer.js";
import { GEANT_ACTIONS } from "../navigation/controller.js";
import { bodyPositionJ2000M } from "../worlds/solar-system.js";
import { translatedObserverJ2000M } from "../worlds/world-navigation.js";
export interface GeantControlsOptions {
  readonly keyboard?: boolean;
  readonly pointer?: "look" | "grab" | "orbit" | "none";
  readonly movement?: boolean;
  readonly speedHeadsetMPerSecond?: number;
}
export function createGeantControlsPlugin(options: GeantControlsOptions = {}): SkykitPlugin {
  return { id: "geant:controls", setup(context) {
    const geant = getGeantContext(context); const host = geant.host;
    if (!host) throw new Error("Browser controls require a host.");
    const canvas = geant.renderer.domElement;
    const abort = new AbortController(); const signal = abort.signal;
    const keys = new Set<string>(); let pointer: { id: number; x: number; y: number } | undefined;
    const direction = new THREE.Vector3();
    const dispatch = geant.navigation.dispatch;
    const clear = () => { keys.clear(); pointer = undefined; };
    host.addEventListener("blur", clear, { signal });
    host.ownerDocument.addEventListener("visibilitychange", clear, { signal });
    host.ownerDocument.defaultView?.addEventListener("blur", clear, { signal });
    const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (options.keyboard !== false) {
      host.addEventListener("keydown", event => {
        if (editable(event.target) || options.movement === false) return;
        if (["KeyW", "KeyA", "KeyS", "KeyD", "KeyX", "KeyZ", "ShiftLeft", "ShiftRight"].includes(event.code)) { keys.add(event.code); event.preventDefault(); }
      }, { signal });
      host.addEventListener("keyup", event => { keys.delete(event.code); }, { signal });
    }
    canvas.addEventListener("pointerdown", event => {
      host.focus({ preventScroll: true });
      if (options.pointer === "none") return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId);
    }, { signal });
    canvas.addEventListener("pointermove", event => {
      if (geant.renderer.xr?.isPresenting || !pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
      pointer.x = event.clientX; pointer.y = event.clientY;
      const state = geant.navigation.getSnapshot();
      if (options.pointer === "grab" && state.mode === "surface" && options.movement !== false) {
        dispatch(GEANT_ACTIONS.travel, { eastM: -dx * state.scaleDenominator / host.clientHeight, northM: dy * state.scaleDenominator / host.clientHeight });
      } else if (options.pointer === "orbit" || state.mode === "orbit") {
        const location = state.locations[state.focusBody]!;
        dispatch(GEANT_ACTIONS.setLocation, { latitudeDegrees: Math.max(-90, Math.min(90, location.latitudeDegrees + dy * 0.2)), longitudeDegrees: ((location.longitudeDegrees + dx * 0.2 + 540) % 360) - 180 });
        const focus = bodyPositionJ2000M(state.focusBody, new Date(state.time));
        const observer = state.observerJ2000M; if (observer) {
          const offset = new THREE.Vector3(observer.x - focus.x, observer.y - focus.y, observer.z - focus.z);
          offset.applyAxisAngle(new THREE.Vector3(0, 0, 1), -dx * 0.003).applyAxisAngle(new THREE.Vector3(0, 1, 0), -dy * 0.003);
          dispatch(GEANT_ACTIONS.setObserver, { x: focus.x + offset.x, y: focus.y + offset.y, z: focus.z + offset.z });
        }
      } else {
        geant.camera.rotation.y -= dx * 0.0035;
        geant.camera.rotation.x = Math.max(-1.35, Math.min(1.1, geant.camera.rotation.x - dy * 0.0035));
      }
    }, { signal });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) canvas.addEventListener(type, clear, { signal });
    canvas.addEventListener("wheel", event => {
      if (options.movement === false || options.pointer === "none") return;
      event.preventDefault(); const state = geant.navigation.getSnapshot();
      dispatch(GEANT_ACTIONS.setScale, { scaleDenominator: state.scaleDenominator * 2 ** (event.deltaY / 600) });
    }, { signal, passive: false });
    context.addPart({ id: "geant:manual-input", priority: -100, update(frame) {
      if (options.movement === false || geant.renderer.xr?.isPresenting) return;
      const state = geant.navigation.getSnapshot();
      const step = (options.speedHeadsetMPerSecond ?? 1.35) * frame.deltaSeconds * state.scaleDenominator * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 4 : 1);
      const forward = Number(keys.has("KeyW")) - Number(keys.has("KeyS")); const right = Number(keys.has("KeyD")) - Number(keys.has("KeyA"));
      if (forward || right) {
        direction.set(right, 0, -forward).normalize().applyQuaternion(geant.camera.quaternion);
        if (state.mode === "surface") dispatch(GEANT_ACTIONS.travel, { eastM: direction.x * step, northM: -direction.z * step });
        else if (state.observerJ2000M) dispatch(GEANT_ACTIONS.setObserver, translatedObserverJ2000M(state.observerJ2000M, direction.multiplyScalar(step / state.scaleDenominator), state.scaleDenominator));
      }
      const scaleAxis = Number(keys.has("KeyZ")) - Number(keys.has("KeyX"));
      if (scaleAxis) dispatch(GEANT_ACTIONS.setScale, { scaleDenominator: state.scaleDenominator * 2 ** (scaleAxis * frame.deltaSeconds * 0.72) });
    } });
    return () => { clear(); abort.abort(); };
  } };
}
