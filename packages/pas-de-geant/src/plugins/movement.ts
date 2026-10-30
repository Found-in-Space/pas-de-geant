import type { SkykitActionMetadata, SkykitPlugin } from "../skykit-runtime.js";
import { getGeantContext } from "../viewer.js";
import { celestialBody, type SolarSystemBodyId } from "../worlds/solar-system.js";
import { createBodySurfaceModel } from "../worlds/surface-model.js";
import { translatedObserverJ2000M } from "../worlds/world-navigation.js";
import type { GeantMovementFrame, GeantMovementModel, GeantMovementSelection, GeantMovementSurface } from "../navigation/movement-model.js";

export interface GeantMovementOptions {
  readonly model: GeantMovementSelection;
  /** Override the geometry adapter to use models without a world renderer. */
  readonly surface?: (body: SolarSystemBodyId) => GeantMovementSurface;
}
/** Applies a model's placement. This adapter has no list of supported metaphors. */
export function createGeantMovementPlugin(options: GeantMovementOptions) {
  let selection = options.model, invalidate = () => {};
  let disposed = false, installed = false;
  return {
    id: "geant:movement",
    setModel(model: GeantMovementSelection) {
      if (disposed) throw new Error("Movement is disposed.");
      selection = model; invalidate();
    },
    setup(context) {
      const geant = getGeantContext(context);
      if (installed || disposed || geant.movement) throw new Error("This viewer already has a movement adapter. Use setModel().");
      installed = true;
      const previousRig = { position: geant.cameraRoot.position.clone(), orientation: geant.cameraRoot.quaternion.clone() };
      const previousPresentation = { ...geant.presentation, translation: geant.presentation.translation.clone(), systemRotation: geant.presentation.systemRotation.clone() };
      let active: GeantMovementModel | undefined, lastFrame: GeantMovementFrame | undefined;
      let mode: string | undefined, body: SolarSystemBodyId | undefined, xr: boolean | undefined;
      let reference: XRReferenceSpace | undefined, session: XRSession | undefined, trackingReset = false;
      let lastDelta = 0;
      const reset = () => { trackingReset = true; };
      const surface = options.surface ?? ((id: SolarSystemBodyId): GeantMovementSurface => {
        const world = geant.worlds.get(id), definition = celestialBody(id);
        return { body: definition, geometry: world?.surfaceModel ?? createBodySurfaceModel(definition),
          sampleElevationMetres: (latitude, longitude) => world?.surface?.sampleElevationMetres?.(latitude, longitude) ?? 0 };
      });
      async function invoke(action: string, payload: Record<string, unknown>, metadata?: SkykitActionMetadata) {
        const results = await context.actions.invoke(action, payload, metadata);
        for (const result of results) if (result.status === "rejected") throw result.reason;
        return results;
      }
      function frame(metadata?: SkykitActionMetadata): GeantMovementFrame {
        const time = geant.time.getSnapshot();
        const state = { ...geant.navigation.getSnapshot(), time: time.atMs, timeRate: time.rate }, presenting = Boolean(geant.renderer.xr?.isPresenting);
        const manager = geant.renderer.xr;
        const nextReference = manager?.getReferenceSpace?.() ?? undefined;
        const nextSession = manager?.getSession?.() ?? undefined;
        if (reference !== nextReference) {
          reference?.removeEventListener("reset", reset); nextReference?.addEventListener("reset", reset);
          reference = nextReference; trackingReset = true;
        }
        const camera = presenting ? manager.getCamera() : geant.camera;
        const raw = presenting && reference ? manager.getFrame?.()?.getViewerPose(reference) : undefined;
        const tracking = { position: camera.position.clone(), orientation: camera.quaternion.clone(), tracked: raw !== null };
        if (raw) { tracking.position.copy(raw.transform.position); tracking.orientation.copy(raw.transform.orientation); }
        const reason = !active ? "initial" : body !== state.focusBody ? "focus"
          : trackingReset || xr !== presenting || session !== nextSession ? "tracking" : "selection";
        return { state, navigation: geant.navigation, deltaSeconds: lastDelta, xr: presenting, tracking,
          rig: { position: geant.cameraRoot.position.clone(), orientation: geant.cameraRoot.quaternion.clone() },
          observerJ2000M: geant.presentation.observerJ2000M, previousSystemRotation: geant.presentation.systemRotation.clone(), reason,
          viewportHeight: geant.host?.clientHeight ?? 600,
          focalLengthPixels: (geant.host?.clientHeight ?? 600) * geant.camera.projectionMatrix.elements[5]! * 0.5,
          surface, invoke: (action, payload) => invoke(action, payload, metadata) };
      }
      function select(metadata?: SkykitActionMetadata) {
        let current = frame(metadata);
        const next = typeof selection === "function" ? selection(current) : selection;
        if (!next || typeof next.update !== "function") throw new TypeError("Select a movement model object.");
        if (next !== active || mode !== current.state.mode || body !== current.state.focusBody ||
            xr !== current.xr || session !== (geant.renderer.xr?.getSession?.() ?? undefined) || trackingReset) {
          const replacing = Boolean(active);
          active?.leave?.(lastFrame ?? current);
          active = undefined;
          try { next.enter?.(current); } catch (error) { next.leave?.(current); throw error; }
          active = next; mode = current.state.mode; body = current.state.focusBody; xr = current.xr;
          session = geant.renderer.xr?.getSession?.() ?? undefined; trackingReset = false;
          if (replacing) geant.movementRevision++;
          current = frame(metadata);
        }
        lastFrame = current;
        return { current, model: active! };
      }
      geant.movement = { command(action, payload, metadata) {
        const { current, model } = select(metadata);
        if (!model.command) throw new Error(`${model.id} does not accept movement commands.`);
        return model.command(action, payload, current);
      } };
      invalidate = () => { mode = undefined; geant.movementRevision++; };
      const removers: Array<() => void> = [];
      const teardown = context.addDisposable(() => {
        if (disposed) return;
        disposed = true; invalidate = () => {};
        for (const remove of removers.reverse()) remove();
        reference?.removeEventListener("reset", reset);
        try { if (active && lastFrame) active.leave?.(lastFrame); }
        finally {
          geant.movement = null; geant.movementRevision++;
          geant.cameraRoot.position.copy(previousRig.position); geant.cameraRoot.quaternion.copy(previousRig.orientation);
          Object.assign(geant.presentation, previousPresentation);
        }
      });
      removers.push(context.addPart({ id: "geant:movement-selection", priority: -150, update(frame) { lastDelta = frame.deltaSeconds; select(); } }));
      removers.push(context.addPart({ id: "geant:movement-placement", priority: -50, update() {
        const { current, model } = select(), placement = model.update(current);
        const rig = placement.rig ?? current.rig;
        geant.cameraRoot.position.copy(rig.position); geant.cameraRoot.quaternion.copy(rig.orientation);
        if (!current.xr && placement.desktopOrientation) geant.camera.quaternion.copy(placement.desktopOrientation);
        if (!current.xr && placement.desktopPosition) geant.camera.position.copy(placement.desktopPosition);
        geant.cameraRoot.updateMatrixWorld(true);
        if (current.xr) geant.renderer.xr.updateCamera?.(geant.camera);
        const head = (current.xr ? current.tracking.position : placement.desktopPosition ?? current.tracking.position).clone().applyQuaternion(rig.orientation).add(rig.position);
        const relative = head.sub(placement.translation).applyQuaternion(placement.systemRotation.clone().invert());
        geant.presentation.originJ2000M = { ...placement.originJ2000M };
        geant.presentation.systemRotation.copy(placement.systemRotation);
        geant.presentation.translation.copy(placement.translation);
        geant.presentation.observerJ2000M = translatedObserverJ2000M(placement.originJ2000M, relative, geant.navigation.scaleDenominator);
      } }));
      return teardown;
    },
  } satisfies SkykitPlugin & { setModel(model: GeantMovementSelection): void };
}
