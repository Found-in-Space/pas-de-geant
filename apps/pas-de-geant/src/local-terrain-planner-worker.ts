import { selectScreenSpaceTerrainPlan } from "./local-terrain-core.js";
import type {
  TerrainPlanWorkerRequest,
  TerrainPlanWorkerResult,
} from "./local-terrain-planner.js";

const worker = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<TerrainPlanWorkerRequest>) => void,
  ): void;
  postMessage(message: TerrainPlanWorkerResult): void;
};

worker.addEventListener("message", (event) => {
  const request = event.data;
  try {
    const { input } = request;
    const plan = selectScreenSpaceTerrainPlan({
      latitudeDegrees: input.latitudeDegrees,
      longitudeDegrees: input.longitudeDegrees,
      displayRadiusM: input.displayRadiusM,
      eyeHeightWorldM: input.eyeHeightWorldM,
      focalLengthPixels: input.focalLengthPixels,
      lodBias: input.lodBias,
      previousActiveKeys: new Set(input.previousActiveKeys),
      activeTileBudget: input.activeTileBudget,
      heightTileBudget: input.heightTileBudget,
    });
    worker.postMessage({
      type: "plan",
      requestId: request.requestId,
      revision: request.revision,
      plan,
    });
  } catch (error) {
    worker.postMessage({
      type: "error",
      requestId: request.requestId,
      revision: request.revision,
      message:
        error instanceof Error ? error.message : "Terrain planning failed.",
    });
  }
});
