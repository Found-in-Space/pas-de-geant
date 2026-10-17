import { SPATIAL_METERS_PER_PARSEC, scaleSpatialVector, type SpatialVector3 } from "@found-in-space/spatial";
import type { SkykitThreeFrame, SkykitThreePart, SkykitPlugin } from "../skykit-runtime.js";
import type * as THREE from "three";
import type { WorldRuntime } from "./world-runtime.js";
import type { TerrainSurfaceView } from "./terrain-surface.js";
import type { Vector3d } from "./solar-system.js";

export const WORLD_METRES_PER_PARSEC = SPATIAL_METERS_PER_PARSEC;

/** Axis/unit conversion only. The caller must already align the physical and catalog origins.
 * This does not calculate a heliocentric-to-barycentric or J2000-to-ICRS correction. */
export function physicalJ2000MetresToSkykitPosition(
  positionM: Vector3d,
  coordinateUnitsPerParsec: number,
): SpatialVector3 {
  const scale = coordinateUnitsPerParsec / WORLD_METRES_PER_PARSEC;
  return scaleSpatialVector(positionM, scale);
}

export interface WorldSkykitOptions {
  readonly world: WorldRuntime;
  /** Explicit application boundary for scale, observer location, projection, and exaggeration. */
  readonly getView: (frame: SkykitThreeFrame) => TerrainSurfaceView;
  readonly present?: (frame: SkykitThreeFrame, world: WorldRuntime) => void;
  readonly parent?: "origin" | "observer";
  /** Supplied worlds are borrowed unless the host explicitly transfers ownership. */
  readonly disposeWorld?: boolean;
}

/** Works with Skykit's public lifecycle; does not create a camera or a render loop. */
export function createWorldSkykitPart(options: WorldSkykitOptions): SkykitThreePart {
  const { world } = options;
  return {
    id: `world:${world.body.id}`,
    object3d: world.object3d,
    attach(context) {
      (options.parent === "observer"
        ? context.roots.observerContentRoot : context.roots.originContentRoot).add(world.object3d);
    },
    update(frame) {
      world.update(options.getView(frame));
      options.present?.(frame, world);
      world.processFrame();
    },
    beforeRender(frame) {
      const renderer = frame.renderer as THREE.WebGLRenderer;
      const camera = renderer.xr?.isPresenting ? renderer.xr.getCamera() : frame.camera;
      world.beforeRender(camera);
    },
    detach() { world.object3d.removeFromParent(); },
    dispose() {
      world.object3d.removeFromParent();
      if (options.disposeWorld) world.dispose();
    },
    getSnapshot() { return { bodyId: world.body.id, ...world.getReadiness() }; },
  };
}

export function createWorldSkykitPlugin(options: WorldSkykitOptions): SkykitPlugin {
  return {
    id: `world:${options.world.body.id}`,
    setup(context) { return context.addPart(createWorldSkykitPart(options)); },
  };
}
