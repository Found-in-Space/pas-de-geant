import type {
  ScreenSpaceTerrainPlan,
} from "./local-terrain-core.js";

export interface TerrainPlanningInput {
  latitudeDegrees: number;
  longitudeDegrees: number;
  displayRadiusM: number;
  radialMultiplier: number;
  eyeHeightWorldM: number;
  focalLengthPixels: number;
  lodBias: number;
  activeTileBudget: number;
  heightTileBudget: number;
}

export interface TerrainPlanningWorkerInput extends TerrainPlanningInput {
  previousActiveKeys: string[];
}

export interface TerrainPlanWorkerRequest {
  type: "plan";
  requestId: number;
  revision: number;
  input: TerrainPlanningWorkerInput;
}

export type TerrainPlanWorkerResult =
  | {
      type: "plan";
      requestId: number;
      revision: number;
      plan: ScreenSpaceTerrainPlan;
    }
  | {
      type: "error";
      requestId: number;
      revision: number;
      message: string;
    };

export type TerrainPlanCompletion =
  | {
      input: TerrainPlanningWorkerInput;
      plan: ScreenSpaceTerrainPlan;
    }
  | {
      input: TerrainPlanningWorkerInput;
      error: string;
    };

interface PendingTerrainPlan {
  revision: number;
  signature: string;
  input: TerrainPlanningInput;
}

export function terrainPlanningInputSignature(
  input: TerrainPlanningInput,
): string {
  return [
    input.latitudeDegrees,
    input.longitudeDegrees,
    input.displayRadiusM,
    input.radialMultiplier,
    input.eyeHeightWorldM,
    input.focalLengthPixels,
    input.lodBias,
    input.activeTileBudget,
    input.heightTileBudget,
  ].join("|");
}

/**
 * Keeps at most one worker request in flight. Inputs recorded while that
 * request runs replace one another, so only the latest snapshot is dispatched
 * after a stale result returns.
 */
export class LatestTerrainPlanScheduler {
  private latest: PendingTerrainPlan | undefined;
  private inFlight: TerrainPlanWorkerRequest | undefined;
  private paused = false;
  private disposed = false;
  private nextRequestId = 0;
  private nextRevision = 0;
  private settledRevision = 0;
  private staleResultTotal = 0;

  constructor(
    private readonly dispatch: (request: TerrainPlanWorkerRequest) => void,
    private readonly previousActiveKeys: () => readonly string[],
  ) {}

  get hasRequestInFlight(): boolean {
    return this.inFlight !== undefined;
  }

  get hasQueuedInput(): boolean {
    return (
      this.latest !== undefined &&
      this.latest.revision !== this.settledRevision &&
      this.latest.revision !== this.inFlight?.revision
    );
  }

  get staleResults(): number {
    return this.staleResultTotal;
  }

  record(input: TerrainPlanningInput): boolean {
    if (this.disposed) return false;
    const signature = terrainPlanningInputSignature(input);
    if (this.latest?.signature === signature) return false;
    this.latest = {
      revision: ++this.nextRevision,
      signature,
      input,
    };
    this.dispatchLatest();
    return true;
  }

  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    if (!paused) this.dispatchLatest();
  }

  handleResult(result: TerrainPlanWorkerResult): TerrainPlanCompletion | undefined {
    if (
      this.disposed ||
      !this.inFlight ||
      result.requestId !== this.inFlight.requestId ||
      result.revision !== this.inFlight.revision
    ) {
      this.staleResultTotal += 1;
      return undefined;
    }

    const completed = this.inFlight;
    this.inFlight = undefined;
    if (this.latest?.revision !== completed.revision) {
      this.staleResultTotal += 1;
      this.dispatchLatest();
      return undefined;
    }

    this.settledRevision = completed.revision;
    if (result.type === "error") {
      return { input: completed.input, error: result.message };
    }
    return { input: completed.input, plan: result.plan };
  }

  reset(): void {
    if (this.disposed) return;
    this.latest = undefined;
    this.settledRevision = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.latest = undefined;
    this.inFlight = undefined;
  }

  private dispatchLatest(): void {
    const latest = this.latest;
    if (
      this.disposed ||
      this.paused ||
      this.inFlight ||
      !latest ||
      latest.revision === this.settledRevision
    ) {
      return;
    }
    const request: TerrainPlanWorkerRequest = {
      type: "plan",
      requestId: ++this.nextRequestId,
      revision: latest.revision,
      input: {
        ...latest.input,
        previousActiveKeys: [...this.previousActiveKeys()],
      },
    };
    this.inFlight = request;
    this.dispatch(request);
  }
}
