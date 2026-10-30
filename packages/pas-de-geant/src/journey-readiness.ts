import type { GeantViewer } from "./viewer.js";
import type { SolarSystemBodyId } from "./worlds/solar-system.js";
import { assessSurfaceReadiness, type SurfaceLayer, type WorldSurfaceReadiness,
  type SurfaceReadinessAssessment } from "./worlds/surface-readiness.js";
let serial = 0;

export interface GeantSurfacePreparation {
  readonly assessment: SurfaceReadinessAssessment;
  readonly readiness: WorldSurfaceReadiness;
}
export class GeantSurfaceReadinessError extends Error {
  constructor(readonly result: GeantSurfacePreparation) {
    super(`Required surface detail is unavailable: ${result.assessment.unmet.join(", ")}.`);
    this.name = "GeantSurfaceReadinessError";
  }
}

/**
 * Await current-view publication in the existing host loop. Use in a chapter's
 * arrive hook, after its camera is placed. This is not future-route preparation.
 * Failure policy is authored: continue returns an explicit degraded result.
 */
export function waitForGeantSurface(options: {
  browser: Pick<GeantViewer, "worlds" | "viewer">;
  body: SolarSystemBodyId;
  required: readonly SurfaceLayer[];
  onDegraded: "fail" | "continue";
  signal: AbortSignal;
  onProgress?: (result: GeantSurfacePreparation) => void;
}): Promise<GeantSurfacePreparation> {
  return new Promise((resolve, reject) => {
    let remove = () => {}, settled = false;
    const finish = (result?: GeantSurfacePreparation, error?: unknown) => {
      if (settled) return;
      settled = true; options.signal.removeEventListener("abort", abort); remove();
      if (result) resolve(result); else reject(error);
    };
    const abort = () => finish(undefined, options.signal.reason);
    const check = () => {
      if (settled) return;
      try {
        const world = options.browser.worlds.get(options.body);
        if (!world) throw new Error("Install the target world before waiting for its surface.");
        const readiness = world.getSurfaceReadiness();
        const assessment = assessSurfaceReadiness(readiness, options.required);
        const result = { assessment, readiness };
        options.onProgress?.(result);
        if (options.signal.aborted) return abort();
        if (assessment.status === "ready") finish(result);
        else if (assessment.status === "degraded") {
          if (options.onDegraded === "continue") finish(result);
          else finish(undefined, new GeantSurfaceReadinessError(result));
        }
      } catch (error) { finish(undefined, error); }
    };
    if (options.signal.aborted) { abort(); return; }
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      remove = options.browser.viewer.addPart({ id: `geant:surface-ready:${options.body}:${++serial}`, priority: 2,
        update: check, dispose: () => finish(undefined, new Error("The surface host was disposed.")) });
    } catch (error) { finish(undefined, error); return; }
    check();
  });
}
