import type { TileIdentity } from "./tile-transition-planner.js";
import type { TileRequestCircuitDiagnostics } from "./tile-request-circuit.js";

export type TileProviderResult<Resource> =
  | { readonly phase: "in-flight" }
  | { readonly phase: "response"; readonly resource: Resource }
  | {
      readonly phase: "failure";
      readonly reason: string;
      readonly status?: number;
      readonly retryAfterMs?: number;
      readonly retryable?: boolean;
    };

export interface TileRequestHandle {
  readonly requestId: number;
  cancel(): void;
}

/** Minimal scheduler/provider protocol; it assigns no semantics to Resource. */
export interface TileProvider<Resource> {
  readonly retryDiagnostics?: TileRequestCircuitDiagnostics;
  request(
    tile: TileIdentity,
    observer: (result: TileProviderResult<Resource>) => void,
  ): TileRequestHandle;
  /** Reorders queued work without cancelling or restarting active requests. */
  updatePriority?(tiles: Iterable<TileIdentity>): void;
}
