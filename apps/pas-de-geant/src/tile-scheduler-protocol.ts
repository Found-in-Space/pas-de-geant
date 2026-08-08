import type { TileLayoutTarget } from "./tile-layout-source.js";
import type {
  SchedulerEvent,
  SchedulerSnapshot,
} from "./tile-transition-scheduler.js";
import type { TileIdentity } from "./tile-transition-planner.js";
import type { TileProviderResult } from "./tile-provider.js";

export type TileSchedulerCommand =
  | {
      readonly kind: "initialize";
      readonly target: TileLayoutTarget;
    }
  | { readonly kind: "target"; readonly target: TileLayoutTarget }
  | {
      readonly kind: "visibility-admission";
      readonly revision: number;
      readonly tiles: readonly TileIdentity[];
    }
  | { readonly kind: "retry" }
  | {
      readonly kind: "resource-result";
      readonly key: string;
      readonly requestId: number;
      readonly result: TileProviderResult<undefined>;
    };

export type TileSchedulerMessage =
  | {
      readonly kind: "snapshot";
      readonly snapshot: SchedulerSnapshot<TileLayoutTarget>;
      readonly event?: SchedulerEvent;
    }
  | { readonly kind: "event"; readonly event: SchedulerEvent }
  | { readonly kind: "target-applied"; readonly target: TileLayoutTarget }
  | {
      readonly kind: "resource-request";
      readonly tile: TileIdentity;
      readonly key: string;
      readonly requestId: number;
    }
  | {
      readonly kind: "resource-cancel";
      readonly key: string;
      readonly requestId: number;
    };
