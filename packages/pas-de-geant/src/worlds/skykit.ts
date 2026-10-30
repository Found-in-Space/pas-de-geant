import { SPATIAL_METERS_PER_PARSEC, scaleSpatialVector, type SpatialVector3 } from "@found-in-space/spatial";
import type { SkykitThreeFrame, SkykitThreePart, SkykitPlugin } from "../skykit-runtime.js";
import type * as THREE from "three";
import type { WorldCameraFrame, WorldRuntime } from "./world-runtime.js";
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

interface WorldSkykitCommonOptions {
  readonly world: WorldRuntime;
  readonly parent?: "origin" | "observer";
  /** Supplied worlds are borrowed unless the host explicitly transfers ownership. */
  readonly disposeWorld?: boolean;
}

export type WorldSkykitOptions = WorldSkykitCommonOptions & (
  | {
    /** Supply placement and exaggeration; the runtime owns camera/terrain measurement. */
    readonly getFrame: (frame: SkykitThreeFrame) => Omit<WorldCameraFrame, "camera">;
    readonly getView?: never;
    readonly present?: never;
  }
  | {
    /** Low-level path: the host owns measurement and its ordering relative to presentation. */
    readonly getView: (frame: SkykitThreeFrame) => TerrainSurfaceView;
    readonly present?: (frame: SkykitThreeFrame, world: WorldRuntime) => void;
    readonly getFrame?: never;
  }
);

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
      world.processFrame();
      if (options.getFrame) world.updateFromCamera({ ...options.getFrame(frame), camera: frame.camera });
      else {
        world.update(options.getView(frame));
        options.present?.(frame, world);
      }
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
    getSnapshot() { return { bodyId: world.body.id, ...world.getReadiness(), view: world.getView() }; },
  };
}

export function createWorldSkykitPlugin(options: WorldSkykitOptions): SkykitPlugin {
  return {
    id: `world:${options.world.body.id}`,
    setup(context) { return context.addPart(createWorldSkykitPart(options)); },
  };
}
