import { SPATIAL_METERS_PER_PARSEC } from "@found-in-space/spatial";
import type { SkykitPlugin } from "../skykit-runtime.js";
import * as THREE from "three";
import { getGeantContext } from "../viewer.js";
import { bodyPositionJ2000M } from "../worlds/solar-system.js";
import { j2000ToWorldQuaternion } from "../worlds/stellar-coordinate-frame.js";
import type { SpatialStarPassOptions } from "./spatial-star-pass.js";
import { backgroundRenderHooks } from "./background-render.js";
export async function createGeantStarPass(options?: SpatialStarPassOptions) {
  const { SpatialStarPass } = await import("./spatial-star-pass.js"); return new SpatialStarPass(options);
}
export function createGeantStarsPlugin(options?: SpatialStarPassOptions): SkykitPlugin {
  return { id: "geant:stars", async setup(context) {
    const geant = getGeantContext(context); const stars = await createGeantStarPass(options);
    const abort = new AbortController();
    let disposed = false;
    let remove: (() => void) | undefined;
    const dispose = async () => {
      if (disposed) return;
      disposed = true; abort.abort(); remove?.(); await stars.dispose();
    };
    context.addDisposable(dispose);
    const position = () => {
      const state = geant.navigation.getSnapshot();
      const metres = geant.presentation.observerJ2000M ?? bodyPositionJ2000M(state.focusBody, new Date(geant.time.getSnapshot().atMs));
      return { x: metres.x / SPATIAL_METERS_PER_PARSEC, y: metres.y / SPATIAL_METERS_PER_PARSEC, z: metres.z / SPATIAL_METERS_PER_PARSEC };
    };
    // An unavailable optional catalog leaves the worlds usable.
    void stars.load(position(), abort.signal).catch(() => {});
    const anchor = new THREE.Vector3();
    const hooks = backgroundRenderHooks(geant.renderer, () => {
      geant.camera.getWorldPosition(anchor);
      stars.setView({ observerJ2000Pc: position(), sunObserverJ2000Pc: position(),
        j2000ToWorld: j2000ToWorldQuaternion(geant.presentation.systemRotation), trackingAnchorWorld: anchor, parallaxBlend: 0, sunOpacity: 0 });
      stars.render(geant.renderer, geant.camera);
    });
    remove = context.addPart({ id: "geant:stars", priority: -100,
      ...hooks, getSnapshot: () => stars.getSnapshot() });
    return dispose;
  } };
}
