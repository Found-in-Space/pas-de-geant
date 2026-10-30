import { Matrix4, Quaternion, Vector3 } from "three";
import { createJourneyOperation, type JourneyOperation, type OperationControl } from "@found-in-space/guided-journey/operations";
import type { Cleanup, JourneyContext, JourneyDriver } from "@found-in-space/guided-journey";
import type { GeantBrowser } from "./browser.js";
import type { GeantViewer } from "./viewer.js";
import type { createGeantMovementPlugin } from "./plugins/movement.js";
import type { GeantMovementFrame, GeantMovementModel, GeantPlacement } from "./navigation/movement-model.js";
import { createGeantShipMovementModel } from "./navigation/ship-movement.js";
import { copyRig, headOrientation, headPosition } from "./navigation/model-geometry.js";
import { GEANT_ACTIONS } from "./navigation/controller.js";
import { sampleScaleTransition, sampleWarpTransition } from "./navigation/transitions.js";
import { bodyPositionJ2000M, bodyRotation, type SolarSystemBodyId } from "./worlds/solar-system.js";
import { bodyFixedToJ2000Quaternion, bodyFixedToRenderQuaternion } from "./worlds/body-attitude.js";
import { referenceSurfaceObservation } from "./worlds/surface-observation.js";
import { translatedObserverJ2000M } from "./worlds/world-navigation.js";

export interface GeantJourneyCamera {
  readonly kind: "surface";
  readonly body: SolarSystemBodyId;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  /** Eye altitude above the declared datum, not room height or distance to body centre. */
  readonly altitudeM: number;
  readonly altitudeReference: "reference" | "terrain";
  readonly scaleDenominator: number;
  readonly durationSecs?: number;
}
export interface GeantJourneyScene {
  readonly camera: GeantJourneyCamera;
  readonly time?: { readonly atMs: number; readonly rate?: number };
  /** Usability only. This does not promise route-wide high-resolution imagery. */
  readonly readiness?: "usable" | "none";
}
type Movement = ReturnType<typeof createGeantMovementPlugin>;
export type GeantJourneyHost = GeantViewer & { readonly movement: Movement | null };
export interface GeantJourneyServices { readonly browser: GeantJourneyHost; readonly navigation: GeantJourneyNavigation }
export interface GeantJourneyNavigation {
  transitionTo(camera: GeantJourneyCamera, options?: { signal?: AbortSignal; durationSecs?: number }): JourneyOperation;
  cancel(): void;
  getSnapshot(): { operation: JourneyOperation | null; moving: boolean; holding: boolean };
  dispose(): void;
}
export type GeantJourneyDriver = JourneyDriver<GeantJourneyScene, GeantJourneyServices> & {
  readonly navigation: GeantJourneyNavigation;
  dispose(): void;
};

/**
 * The ordinary movement adapter remains the only placement writer. During travel
 * it samples this model; free exploration hands over to the existing ship model.
 * The head pose is never authored or overwritten, including on XR re-entry.
 */
export function createGeantJourneyNavigation(browser: GeantJourneyHost): GeantJourneyNavigation {
  const movement = browser.movement;
  if (!movement) throw new Error("A journey requires the host's movement adapter.");
  const original = movement.getModel();
  const manual = createGeantShipMovementModel({ id: "geant:journey-exploration" });
  let released = false, disposed = false;
  let installedSelection = false;
  let operation: OperationControl | null = null;
  let request: { camera: GeantJourneyCamera; durationSecs: number } | null = null;
  let elapsed = 0, arrival = false;
  let start: {
    placement: GeantPlacement; eye: Vector3; orientation: Quaternion; scale: number;
    location: ReturnType<typeof referenceSurfaceObservation>;
  } | null = null;

  function cancel() {
    const owned = Boolean(request);
    const pending = operation;
    operation = null; arrival = false; request = null; start = null;
    pending?.abort();
    if (!owned || disposed) return;
    released = true;
    // Ship entry reconstructs the physical observer and rig from the live
    // placement. It does not restore the chapter's authored or saved pose.
    browser.navigation.dispatch(GEANT_ACTIONS.setMode, { mode: "free" });
  }
  const model: GeantMovementModel = {
    id: "geant:journey",
    enter(frame) {
      if (!request) return;
      const presentation = browser.context.presentation, eye = headPosition(frame);
      const relative = eye.clone().sub(presentation.translation).applyQuaternion(presentation.systemRotation.clone().invert());
      const observer = translatedObserverJ2000M(presentation.originJ2000M, relative, frame.state.scaleDenominator);
      const at = new Date(frame.state.time), centre = bodyPositionJ2000M(request.camera.body, at);
      const local = new Vector3(observer.x - centre.x, observer.y - centre.y, observer.z - centre.z)
        .applyQuaternion(bodyFixedToJ2000Quaternion(bodyRotation(request.camera.body, at)).invert());
      start = {
        placement: { originJ2000M: observer, systemRotation: presentation.systemRotation.clone(), translation: eye.clone(), rig: copyRig(frame.rig) },
        eye, orientation: headOrientation(frame), scale: frame.state.scaleDenominator,
        location: referenceSurfaceObservation(frame.surface(request.camera.body).body, local),
      };
      elapsed = 0;
    },
    update(frame) {
      if (!start || !request) throw new Error("Journey movement must enter before sampling.");
      const { camera, durationSecs } = request;
      const at = new Date(frame.state.time), surface = frame.surface(camera.body);
      const progress = durationSecs === 0 ? 1 : Math.min(1, elapsed / durationSecs);
      const eased = progress * progress * (3 - 2 * progress);
      const timing = { startedAtMs: 0, durationSeconds: durationSecs };
      const location = sampleWarpTransition({ ...timing, from: start.location, to: camera }, elapsed * 1000).value;
      const ground = camera.altitudeReference === "terrain"
        ? surface.sampleElevationMetres(camera.latitudeDegrees, camera.longitudeDegrees) * frame.state.terrainMultiplier : 0;
      const altitude = start.location.heightMetres + (camera.altitudeM + ground - start.location.heightMetres) * eased;
      const scale = sampleScaleTransition({ ...timing, from: start.scale, to: camera.scaleDenominator }, elapsed * 1000).value;
      const point = surface.geometry.positionAndNormal(location.latitudeDegrees, location.longitudeDegrees);
      const localEye = point.position.clone().multiplyScalar(surface.geometry.referenceRadiusM).addScaledVector(point.normal, altitude);
      const rotation = bodyRotation(camera.body, at), centre = bodyPositionJ2000M(camera.body, at);
      const eyeJ2000 = localEye.clone().applyQuaternion(bodyFixedToJ2000Quaternion(rotation));
      const latitude = location.latitudeDegrees * Math.PI / 180, longitude = location.longitudeDegrees * Math.PI / 180;
      const north = new Vector3(-Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), Math.sin(latitude) * Math.sin(longitude));
      const bodyToRender = bodyFixedToRenderQuaternion(rotation);
      const outward = point.normal.clone().applyQuaternion(bodyToRender);
      north.applyQuaternion(bodyToRender);
      const physicalOrientation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(outward, new Vector3(), north));
      const destinationRotation = start.orientation.clone().multiply(physicalOrientation.invert());
      browser.navigation.dispatch(GEANT_ACTIONS.setScale, { scaleDenominator: scale });
      const placement = progress === 0 ? start.placement : {
        originJ2000M: { x: centre.x + eyeJ2000.x, y: centre.y + eyeJ2000.y, z: centre.z + eyeJ2000.z },
        systemRotation: start.placement.systemRotation.clone().slerp(destinationRotation, eased),
        translation: start.eye, rig: start.placement.rig,
      };
      elapsed += Math.max(0, frame.deltaSeconds);
      if (progress === 1 && operation && !operation.settled) arrival = true;
      if (arrival) browser.navigation.dispatch(GEANT_ACTIONS.setLocation, {
        body: camera.body, latitudeDegrees: camera.latitudeDegrees, longitudeDegrees: camera.longitudeDegrees,
        altitudeM: camera.altitudeM,
      });
      return placement;
    },
    command(action, payload) {
      cancel();
      // Transfer input in the same frame through the adapter's selection path.
      return browser.context.movement!.command(action, payload);
    },
  };
  const freeSelection = (frame: GeantMovementFrame) => frame.state.mode === "free"
    ? manual : typeof original === "function" ? original(frame) : original;
  const selection = (frame: GeantMovementFrame) => request ? model
    : released ? freeSelection(frame) : typeof original === "function" ? original(frame) : original;
  const removeArrival = browser.viewer.addPart({ id: "geant:journey-arrival", priority: 1, update() {
    // Runs after movement (-50) and world placement (0). No second frame loop.
    if (arrival && operation && !operation.settled) { arrival = false; operation.settle("completed"); }
  } });
  const navigation: GeantJourneyNavigation = {
    transitionTo(camera, options = {}) {
      if (options.signal?.aborted) return createJourneyOperation({ signal: options.signal }).operation;
      const control = createJourneyOperation({ signal: options.signal, lanes: ["movement", "orientation", "scale"], onCancel: cancel });
      if (control.settled) return control.operation;
      try {
        validateCamera(camera, browser);
        const durationSecs = options.durationSecs ?? camera.durationSecs ?? 4;
        if (!Number.isFinite(durationSecs) || durationSecs < 0) throw new RangeError("Duration must be nonnegative seconds.");
        if (disposed) throw new Error("Journey navigation is disposed.");
        const previous = operation;
        operation = null; previous?.abort("superseded");
        request = { camera, durationSecs }; start = null; elapsed = 0; arrival = false; operation = control;
        browser.navigation.dispatch(GEANT_ACTIONS.focusBody, { body: camera.body });
        installedSelection = true;
        movement.setModel(selection);
      } catch (error) { control.settle("failed", error); }
      return control.operation;
    },
    cancel,
    getSnapshot: () => ({ operation: operation?.operation ?? null, moving: Boolean(operation && !operation.settled), holding: Boolean(request) }),
    dispose() {
      if (disposed) return;
      cancel(); disposed = true; removeArrival();
      // Keep the live manual placement when the driver is removed. Restoring a
      // former orbit/surface selection could reapply an old authored anchor.
      if (installedSelection) movement.setModel(released ? freeSelection : original);
      removeOwner();
    },
  };
  const removeOwner = browser.addDisposable(() => navigation.dispose());
  return navigation;
}

function validateCamera(camera: GeantJourneyCamera, browser: GeantJourneyHost) {
  if (camera.kind !== "surface" || !browser.configuration.bodies.includes(camera.body)) throw new RangeError("Select a configured body surface.");
  if (![camera.latitudeDegrees, camera.longitudeDegrees, camera.altitudeM, camera.scaleDenominator].every(Number.isFinite)
    || Math.abs(camera.latitudeDegrees) > 90 || camera.scaleDenominator <= 0) throw new RangeError("Invalid geographic camera quantities.");
  if (camera.altitudeReference !== "reference" && camera.altitudeReference !== "terrain") throw new TypeError("Declare the altitude reference.");
}

export function createGeantJourneyDriver(options: {
  browser: GeantBrowser | GeantJourneyHost;
  prepare?: (scene: GeantJourneyScene, context: JourneyContext<GeantJourneyScene, GeantJourneyServices>) => void | Cleanup | Promise<void | Cleanup>;
}): GeantJourneyDriver {
  const { browser } = options;
  const navigation = createGeantJourneyNavigation(browser);
  return {
    services: { browser, navigation }, navigation,
    async prepare(scene, context) {
      validateCamera(scene.camera, browser);
      if (scene.time && (!Number.isFinite(scene.time.atMs) || !Number.isFinite(scene.time.rate ?? 0))) throw new RangeError("Invalid world clock.");
      if (scene.readiness !== "none" && !browser.worlds.has(scene.camera.body)) throw new Error("Install the target world before preparing its journey.");
      if (scene.readiness !== "none") await new Promise<void>((resolve, reject) => {
        let remove = () => {};
        const abort = () => { remove(); reject(context.signal.reason); };
        const check = () => {
          const readiness = browser.worlds.get(scene.camera.body)?.getReadiness();
          context.reportProgress({ body: scene.camera.body, ...readiness });
          if (readiness?.ready) { remove(); context.signal.removeEventListener("abort", abort); resolve(); }
        };
        remove = browser.viewer.addPart({ id: `geant:journey-ready:${context.chapterId}`, priority: 1, update: check });
        context.addCleanup(() => { remove(); context.signal.removeEventListener("abort", abort); });
        context.signal.addEventListener("abort", abort, { once: true });
        if (context.signal.aborted) abort(); else check();
      });
      context.throwIfAborted();
      return options.prepare?.(scene, context);
    },
    enter(_scene, context) {
      context.throwIfAborted();
    },
    transition(scene, context) {
      const operation = navigation.transitionTo(scene.camera, { signal: context.signal, durationSecs: context.transition.durationSecs });
      void operation.finished.then(result => {
        // Adopt the chapter epoch once body-relative arrival is established.
        // The next host frame samples that epoch for movement and worlds alike.
        if (result.status === "completed" && context.isCurrent() && scene.time) {
          const previousRate = browser.navigation.getClock().scale;
          browser.navigation.dispatch(GEANT_ACTIONS.setTime, scene.time);
          const ownedClock = browser.navigation.getClock();
          context.addCleanup(() => {
            const current = browser.navigation.getClock();
            // Restore the borrowed rate at the current instant. A subsequent
            // explicit clock edit belongs to its caller and is left intact.
            if (current.anchorWallTimeMs === ownedClock.anchorWallTimeMs
              && current.offsetMs === ownedClock.offsetMs && current.scale === ownedClock.scale) {
              browser.navigation.dispatch(GEANT_ACTIONS.setTime, {
                atMs: browser.navigation.getSnapshot().time, rate: previousRate,
              });
            }
          });
        }
      });
      return operation;
    },
    cancel: () => navigation.cancel(), dispose: () => navigation.dispose(),
  };
}
