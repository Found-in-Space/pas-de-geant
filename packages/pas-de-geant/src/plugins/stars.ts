import { SPATIAL_METERS_PER_PARSEC } from "@found-in-space/spatial";
import type { SkykitPlugin } from "@found-in-space/skykit";
import * as THREE from "three";
import { getGeantContext } from "../viewer.js";
import { bodyPositionJ2000M } from "../worlds/solar-system.js";
import { j2000ToWorldQuaternion } from "../worlds/stellar-coordinate-frame.js";
import type { SpatialStarPassOptions } from "./spatial-star-pass.js";
export async function createGeantStarPass(options?: SpatialStarPassOptions) {
  const { SpatialStarPass } = await import("./spatial-star-pass.js"); return new SpatialStarPass(options);
}
export function createGeantStarsPlugin(options?: SpatialStarPassOptions): SkykitPlugin {
  return { id: "geant:stars", async setup(context) {
    const geant = getGeantContext(context); const stars = await createGeantStarPass(options);
    context.addDisposable(() => stars.dispose());
    const position = () => {
      const state = geant.navigation.getSnapshot();
      const metres = geant.presentation.observerJ2000M ?? bodyPositionJ2000M(state.focusBody, new Date(state.time));
      return { x: metres.x / SPATIAL_METERS_PER_PARSEC, y: metres.y / SPATIAL_METERS_PER_PARSEC, z: metres.z / SPATIAL_METERS_PER_PARSEC };
    };
    // An unavailable optional catalog leaves the worlds usable.
    void stars.load(position()).catch(() => {});
    const anchor = new THREE.Vector3();
    context.addPart({ id: "geant:stars", priority: 100,
      beforeRender() {
        geant.camera.getWorldPosition(anchor);
        stars.setView({ observerJ2000Pc: position(), sunObserverJ2000Pc: position(),
          j2000ToWorld: j2000ToWorldQuaternion(geant.presentation.systemRotation), trackingAnchorWorld: anchor, parallaxBlend: 0, sunOpacity: 0 });
        stars.render(geant.renderer, geant.camera); geant.renderer.clearDepth();
      }, getSnapshot: () => stars.getSnapshot() });
  } };
}
