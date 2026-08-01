import type { TileIdentity } from "./tile-transition-planner.js";

export type TileProviderResult<Resource> =
  | { readonly phase: "in-flight" }
  | { readonly phase: "response"; readonly resource: Resource }
  | { readonly phase: "failure"; readonly reason: string };

export interface TileRequestHandle {
  readonly requestId: number;
  cancel(): void;
}

/** Minimal scheduler/provider protocol; it assigns no semantics to Resource. */
export interface TileProvider<Resource> {
  request(
    tile: TileIdentity,
    observer: (result: TileProviderResult<Resource>) => void,
  ): TileRequestHandle;
}
