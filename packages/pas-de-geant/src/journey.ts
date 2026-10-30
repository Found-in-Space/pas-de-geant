import { Matrix4, Quaternion, Vector3 } from "three";
import { normalizeSpatialPose, type SpatialPose, type SpatialCoordinateSpace } from "@found-in-space/spatial";
import { createJourneyOperation, type JourneyOperation, type OperationControl } from "@found-in-space/guided-journey/operations";
import type { Cleanup, JourneyContext, JourneyDriver } from "@found-in-space/guided-journey";
import type { GeantBrowser } from "./browser.js";
import type { GeantViewer } from "./viewer.js";
import type { createGeantMovementPlugin } from "./plugins/movement.js";
import type { GeantMovementFrame, GeantMovementModel, GeantPlacement } from "./navigation/movement-model.js";
import { createGeantShipMovementModel } from "./navigation/ship-movement.js";
import { copyRig, headOrientation, headPosition } from "./navigation/model-geometry.js";
import { GEANT_ACTIONS } from "./navigation/controller.js";
import { GEANT_MOTION_ACTIONS } from "./navigation/motion.js";
import { sampleScaleTransition, sampleWarpTransition } from "./navigation/transitions.js";
import { bodyPositionJ2000M, bodyRotation, type SolarSystemBodyId } from "./worlds/solar-system.js";
import { bodyFixedToJ2000Quaternion, bodyFixedToRenderQuaternion } from "./worlds/body-attitude.js";
import { referenceSurfaceObservation } from "./worlds/surface-observation.js";
import { translatedObserverJ2000M } from "./worlds/world-navigation.js";
import type { SimulationClockState } from "./navigation/simulation-clock.js";

const motionActions = new Set<string>(Object.values(GEANT_MOTION_ACTIONS));

export { createGeantSequenceParticipant, createGeantSequencePlugin, type GeantSequenceValue } from "./sequence.js";
export { waitForGeantSurface, GeantSurfaceReadinessError, type GeantSurfacePreparation } from "./journey-readiness.js";
export { createGeantTrackingSequence, evaluateGeantTrackingShot, type GeantTrackingTarget, type GeantTrackingShot } from "./tracking.js";

export interface GeantSurfaceJourneyCamera {
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
export interface GeantBodyPoseCamera {
  readonly kind: "body-pose";
  readonly body: SolarSystemBodyId;
  /** Physical body-fixed metres; camera looks along local -Z, with local +Y up. */
  readonly pose: SpatialPose;
  readonly scaleDenominator: number;
  readonly durationSecs?: number;
}
export type GeantJourneyCamera = GeantSurfaceJourneyCamera | GeantBodyPoseCamera;
/** Body-centred, x at longitude zero, +y north, -z east; orientation follows the body's model at the world epoch. */
export function geantBodyFixedSpace(body: SolarSystemBodyId): SpatialCoordinateSpace {
  return { frameId: `geant:${body}:body-fixed`, metersPerUnit: 1 };
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
  getSnapshot(): GeantJourneyNavigationSnapshot;
  subscribe(listener: (snapshot: GeantJourneyNavigationSnapshot) => void): () => void;
  /** External navigation commands also interrupt preparation before motion exists. */
  subscribeInterruption(listener: () => void): () => void;
  /** Apply an exact sample after body-pose arrival, without restarting live-pose capture. */
  applyPose(camera: GeantBodyPoseCamera): void;
  /** Own the world clock until release. Releasing restores its former rate at the current instant. */
  setTime(time: { readonly atMs: number; readonly rate?: number }): void;
  dispose(): void;
}
export interface GeantJourneyNavigationSnapshot {
  readonly operation: JourneyOperation | null;
  readonly moving: boolean;
  readonly holding: boolean;
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
  const source = Symbol("geant:journey"), listeners = new Set<(snapshot: GeantJourneyNavigationSnapshot) => void>();
  const interruptions = new Set<() => void>();
  const interrupt = () => { for (const listener of [...interruptions]) listener(); };
  let ownedClock: SimulationClockState | null = null, previousRate = 0;
  const write = (action: string, payload: unknown) => browser.navigation.dispatch(action, payload, source);
  const snapshot = (): GeantJourneyNavigationSnapshot => ({ operation: operation?.operation ?? null,
    moving: Boolean(operation && !operation.settled), holding: Boolean(request) });
  const publish = () => { const state = snapshot(); for (const listener of [...listeners]) if (listeners.has(listener)) listener(state); };
  function releaseClock() {
    const owned = ownedClock; ownedClock = null;
    if (!owned) return;
    const current = browser.navigation.getClock();
    if (current.anchorWallTimeMs === owned.anchorWallTimeMs && current.offsetMs === owned.offsetMs && current.scale === owned.scale) {
      write(GEANT_ACTIONS.setTime, { atMs: browser.navigation.getSnapshot().time, rate: previousRate });
    }
  }
  let start: {
    placement: GeantPlacement; eye: Vector3; orientation: Quaternion; scale: number;
    localEye: Vector3;
    location: ReturnType<typeof referenceSurfaceObservation>;
  } | null = null;

  function cancel(preserveMode = false) {
    const owned = Boolean(request);
    const pending = operation;
    operation = null; arrival = false; request = null; start = null;
    pending?.abort();
    releaseClock();
    if (!owned || disposed) return;
    released = true;
    // Ship entry reconstructs the physical observer and rig from the live
    // placement. It does not restore the chapter's authored or saved pose.
    if (!preserveMode) write(GEANT_ACTIONS.setMode, { mode: "free" });
    publish();
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
        eye, orientation: headOrientation(frame), scale: frame.state.scaleDenominator, localEye: local,
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
      const scale = sampleScaleTransition({ ...timing, from: start.scale, to: camera.scaleDenominator }, elapsed * 1000).value;
      const rotation = bodyRotation(camera.body, at), centre = bodyPositionJ2000M(camera.body, at);
      const bodyToRender = bodyFixedToRenderQuaternion(rotation);
      let localEye: Vector3, physicalOrientation: Quaternion;
      if (camera.kind === "body-pose") {
        localEye = start.localEye.clone().lerp(new Vector3().copy(camera.pose.position), eased);
        physicalOrientation = bodyToRender.multiply(new Quaternion().copy(camera.pose.orientation));
      } else {
        const location = sampleWarpTransition({ ...timing, from: start.location, to: camera }, elapsed * 1000).value;
        const ground = camera.altitudeReference === "terrain"
          ? surface.sampleElevationMetres(camera.latitudeDegrees, camera.longitudeDegrees) * frame.state.terrainMultiplier : 0;
        const altitude = start.location.heightMetres + (camera.altitudeM + ground - start.location.heightMetres) * eased;
        const point = surface.geometry.positionAndNormal(location.latitudeDegrees, location.longitudeDegrees);
        localEye = point.position.clone().multiplyScalar(surface.geometry.referenceRadiusM).addScaledVector(point.normal, altitude);
        const latitude = location.latitudeDegrees * Math.PI / 180, longitude = location.longitudeDegrees * Math.PI / 180;
        const north = new Vector3(-Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), Math.sin(latitude) * Math.sin(longitude));
        const outward = point.normal.clone().applyQuaternion(bodyToRender);
        north.applyQuaternion(bodyToRender);
        physicalOrientation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(outward, new Vector3(), north));
      }
      const eyeJ2000 = localEye.clone().applyQuaternion(bodyFixedToJ2000Quaternion(rotation));
      const destinationRotation = start.orientation.clone().multiply(physicalOrientation.invert());
      write(GEANT_ACTIONS.setScale, { scaleDenominator: scale });
      const placement = progress === 0 ? start.placement : {
        originJ2000M: { x: centre.x + eyeJ2000.x, y: centre.y + eyeJ2000.y, z: centre.z + eyeJ2000.z },
        systemRotation: start.placement.systemRotation.clone().slerp(destinationRotation, eased),
        translation: start.eye, rig: start.placement.rig,
      };
      elapsed += Math.max(0, frame.deltaSeconds);
      if (progress === 1 && operation && !operation.settled) arrival = true;
      if (arrival || progress === 1 && camera.kind === "body-pose") {
        const location = camera.kind === "surface" ? camera : referenceSurfaceObservation(surface.body, localEye);
        write(GEANT_ACTIONS.setLocation, { body: camera.body, latitudeDegrees: location.latitudeDegrees,
          longitudeDegrees: location.longitudeDegrees, altitudeM: "altitudeM" in location ? location.altitudeM : location.heightMetres });
      }
      return placement;
    },
    command(action, payload) {
      cancel();
      interrupt();
      // Transfer input in the same frame through the adapter's selection path.
      return browser.context.movement!.command(action, payload);
    },
  };
  const freeSelection = (frame: GeantMovementFrame) => frame.state.mode === "free"
    ? manual : typeof original === "function" ? original(frame) : original;
  const selection = (frame: GeantMovementFrame) => request ? model
    : released ? freeSelection(frame) : typeof original === "function" ? original(frame) : original;
  const removeSelection = movement.subscribeModel(next => { if (request && next !== selection) cancel(true); });
  const removeArrival = browser.viewer.addPart({ id: "geant:journey-arrival", priority: 1, update() {
    // Runs after movement (-50) and world placement (0). No second frame loop.
    if (arrival && operation && !operation.settled) { arrival = false; operation.settle("completed"); publish(); }
  } });
  const removeCommands = browser.navigation.subscribeCommands(command => {
    if (command.source !== source && command.action !== GEANT_ACTIONS.setTerrainMultiplier) {
      // A newer explicit mode wins. Other commands enter free exploration with
      // their newly applied quantities, rather than being overwritten next frame.
      cancel(command.action === GEANT_ACTIONS.setMode);
      interrupt();
    }
  });
  const navigation: GeantJourneyNavigation = {
    transitionTo(camera, options = {}) {
      if (options.signal?.aborted) return createJourneyOperation({ signal: options.signal }).operation;
      const control = createJourneyOperation({ signal: options.signal, lanes: ["movement", "orientation", "scale"], onCancel: () => cancel() });
      if (control.settled) return control.operation;
      try {
        camera = validateCamera(camera, browser);
        const durationSecs = options.durationSecs ?? camera.durationSecs ?? 4;
        if (!Number.isFinite(durationSecs) || durationSecs < 0) throw new RangeError("Duration must be nonnegative seconds.");
        if (disposed) throw new Error("Journey navigation is disposed.");
        const previous = operation;
        operation = null; previous?.abort("superseded");
        // A completed operation can still own a held pose and clock.
        if (request) cancel();
        request = { camera, durationSecs }; start = null; elapsed = 0; arrival = false; operation = control;
        write(GEANT_ACTIONS.focusBody, { body: camera.body });
        installedSelection = true;
        movement.setModel(selection);
        publish();
      } catch (error) { control.settle("failed", error); }
      return control.operation;
    },
    cancel: () => cancel(), getSnapshot: snapshot,
    subscribe(listener) { if (disposed) throw new Error("Journey navigation is disposed."); listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeInterruption(listener) { if (disposed) throw new Error("Journey navigation is disposed."); interruptions.add(listener); return () => { interruptions.delete(listener); }; },
    applyPose(camera) {
      const normalized = validateCamera(camera, browser);
      if (normalized.kind !== "body-pose") throw new TypeError("Sequence samples require a body-pose camera.");
      if (!request || request.camera.kind !== "body-pose" || !start || !operation?.settled || disposed) throw new Error("Join a body pose before applying sequence samples.");
      if (normalized.body !== request.camera.body) throw new RangeError("Rejoin explicitly before changing the sequence body.");
      request = { camera: normalized, durationSecs: 0 };
    },
    setTime(time) {
      if (!request || disposed) throw new Error("Own a journey pose before adopting its clock.");
      const rate = time.rate ?? browser.navigation.getClock().scale;
      if (!Number.isFinite(time.atMs) || !Number.isFinite(rate)) throw new RangeError("Invalid world clock.");
      if (!ownedClock) previousRate = browser.navigation.getClock().scale;
      if (browser.time.getSnapshot().atMs === time.atMs && browser.navigation.getClock().scale === rate) return;
      write(GEANT_ACTIONS.setTime, { atMs: time.atMs, rate });
      ownedClock = browser.navigation.getClock();
    },
    dispose() {
      if (disposed) return;
      cancel(movement.getModel() !== selection); interrupt(); disposed = true; removeArrival(); removeCommands(); removeSelection(); listeners.clear(); interruptions.clear();
      // Keep the live manual placement when the driver is removed. Restoring a
      // former orbit/surface selection could reapply an old authored anchor.
      if (installedSelection && movement.getModel() === selection) movement.setModel(released ? freeSelection : original);
      removeOwner();
    },
  };
  const removeOwner = browser.addDisposable(() => navigation.dispose());
  return navigation;
}

function validateCamera(camera: GeantJourneyCamera, browser: GeantJourneyHost): GeantJourneyCamera {
  if (!browser.configuration.bodies.includes(camera.body) || !Number.isFinite(camera.scaleDenominator) || camera.scaleDenominator <= 0) throw new RangeError("Select a configured body and positive scale denominator.");
  if (camera.kind === "body-pose") {
    if (!camera.pose?.space || !camera.pose.position || !camera.pose.orientation) throw new TypeError("Declare a complete body-fixed camera pose and coordinate space.");
    return { ...camera, pose: normalizeSpatialPose(camera.pose, geantBodyFixedSpace(camera.body)) };
  }
  if (camera.kind !== "surface") throw new RangeError("Select a surface or body-pose camera.");
  if (![camera.latitudeDegrees, camera.longitudeDegrees, camera.altitudeM, camera.scaleDenominator].every(Number.isFinite)
    || Math.abs(camera.latitudeDegrees) > 90 || camera.scaleDenominator <= 0) throw new RangeError("Invalid geographic camera quantities.");
  if (camera.altitudeReference !== "reference" && camera.altitudeReference !== "terrain") throw new TypeError("Declare the altitude reference.");
  return { ...camera };
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
      context.addCleanup(navigation.subscribeInterruption(() => context.cancel()));
      context.addCleanup(browser.viewer.actions.subscribe(event => {
        if ((event.type === "action/invoke" || event.type === "action/press")
          && motionActions.has(event.id)) context.cancel();
      }));
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
          navigation.setTime(scene.time);
        }
      });
      return operation;
    },
    cancel: () => navigation.cancel(), dispose: () => navigation.dispose(),
  };
}
