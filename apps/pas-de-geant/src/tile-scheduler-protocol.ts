import type { TileTarget } from "./tile-layout-source.js";
import type {
  SchedulerEvent,
  SchedulerSnapshot,
} from "./tile-transition-scheduler.js";
import type { TileIdentity } from "./tile-transition-planner.js";
import type { TileProviderResult } from "./tile-provider.js";

export type TileSchedulerCommand =
  | {
      readonly kind: "initialize";
      readonly target: TileTarget;
      readonly hydrateInitialResources: boolean;
    }
  | { readonly kind: "target"; readonly target: TileTarget }
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
      readonly snapshot: SchedulerSnapshot<TileTarget>;
      readonly event?: SchedulerEvent;
    }
  | { readonly kind: "event"; readonly event: SchedulerEvent }
  | { readonly kind: "target-applied" }
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
