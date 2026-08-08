import {
  compareTileIdentities,
  planTransition,
  tileIdentityKey,
  type ReplacementGroup,
  type TileIdentity,
  type TransitionBatch,
  type TransitionGraph,
} from "./tile-transition-planner.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "./tile-provider.js";

export interface LayoutSource<Target> {
  calculate(target: Readonly<Target>): readonly TileIdentity[];
}

export type TileRequirementState =
  | "requested"
  | "in-flight"
  | "ready"
  | "failed";

export interface TileRequirementSnapshot {
  readonly tile: TileIdentity;
  readonly state: TileRequirementState;
  readonly requestId: number;
  readonly reason?: string;
}

export interface SchedulerSnapshot<Target> {
  readonly revision: number;
  readonly target: Readonly<Target>;
  readonly committedCut: readonly TileIdentity[];
  readonly requestedCut: readonly TileIdentity[];
  readonly graph: TransitionGraph;
  readonly requirements: readonly TileRequirementSnapshot[];
}

export type SchedulerEventKind =
  | "request"
  | "in-flight"
  | "response"
  | "failure"
  | "cancellation"
  | "discard"
  | "atomic-swap";

export interface SchedulerEvent {
  readonly sequence: number;
  readonly revision: number;
  readonly kind: SchedulerEventKind;
  readonly tile?: TileIdentity;
  readonly requestId?: number;
  readonly reason?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;
  readonly scope?: "tile" | "provider";
  readonly batchId?: string;
  readonly groupIds?: readonly string[];
  readonly before?: readonly TileIdentity[];
  readonly after?: readonly TileIdentity[];
}

interface Requirement<Resource> {
  readonly tile: TileIdentity;
  kind: "committed" | "replacement";
  state: TileRequirementState;
  requestId: number;
  handle: TileRequestHandle;
  resource?: Resource;
  reason?: string;
}

function immutableTile(tile: TileIdentity): TileIdentity {
  return Object.freeze({ z: tile.z, x: tile.x, y: tile.y });
}

function sortedTiles(tiles: Iterable<TileIdentity>): readonly TileIdentity[] {
  return Object.freeze([...tiles].sort(compareTileIdentities));
}

function immutableTarget<Target>(target: Target): Readonly<Target> {
  if (typeof target === "object" && target !== null) {
    return Object.freeze({ ...target });
  }
  return target;
}

/**
 * Owns transition time and resource state. Layout calculation and transition
 * topology are injected, and resources exist only while committed or required
 * by the current transition.
 */
export class TileTransitionScheduler<Target, Resource> {
  private readonly listeners = new Set<
    (snapshot: SchedulerSnapshot<Target>, event?: SchedulerEvent) => void
  >();
  private readonly requirements = new Map<string, Requirement<Resource>>();
  private readonly committedResources = new Map<string, Resource | undefined>();
  private readonly hydratedCommitted = new Set<string>();
  private visiblePlannerCandidates = new Set<string>();
  private committed = new Map<string, TileIdentity>();
  private requested = new Map<string, TileIdentity>();
  private targetValue: Readonly<Target>;
  private graphValue: TransitionGraph;
  private revisionValue = 0;
  private nextEventSequence = 1;
  private changing = false;

  constructor(
    initialTarget: Target,
    private readonly layoutSource: LayoutSource<Target>,
    private readonly provider: TileProvider<Resource>,
  ) {
    this.targetValue = immutableTarget(initialTarget);
    const initialCut = layoutSource.calculate(this.targetValue);
    this.committed = this.indexCut(initialCut);
    this.requested = this.indexCut(initialCut);
    for (const key of this.committed.keys()) {
      this.committedResources.set(key, undefined);
    }
    this.graphValue = planTransition(this.committed.values(), this.requested.values());
  }

  get snapshot(): SchedulerSnapshot<Target> {
    const requirements = [...this.requirements.values()]
      .sort((first, second) => compareTileIdentities(first.tile, second.tile))
      .map((requirement) =>
        Object.freeze({
          tile: requirement.tile,
          state: requirement.state,
          requestId: requirement.requestId,
          ...(requirement.reason === undefined
            ? {}
            : { reason: requirement.reason }),
        }),
      );
    return Object.freeze({
      revision: this.revisionValue,
      target: this.targetValue,
      committedCut: sortedTiles(this.committed.values()),
      requestedCut: sortedTiles(this.requested.values()),
      graph: this.graphValue,
      requirements: Object.freeze(requirements),
    });
  }

  subscribe(
    listener: (snapshot: SchedulerSnapshot<Target>, event?: SchedulerEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  committedResource(tile: TileIdentity): Resource | undefined {
    return this.committedResources.get(tileIdentityKey(tile));
  }

  dispose(): void {
    for (const requirement of this.requirements.values()) {
      if (requirement.state === "requested" || requirement.state === "in-flight") {
        requirement.handle.cancel();
      }
    }
    this.requirements.clear();
    this.committedResources.clear();
    this.hydratedCommitted.clear();
    this.listeners.clear();
  }

  private indexCut(cut: readonly TileIdentity[]): Map<string, TileIdentity> {
    return new Map(
      cut.map((tile) => {
        const copy = immutableTile(tile);
        return [tileIdentityKey(copy), copy] as const;
      }),
    );
  }

  private notify(
    kind: SchedulerEventKind,
    detail: Omit<SchedulerEvent, "sequence" | "revision" | "kind"> = {},
  ): void {
    const event = Object.freeze({
      sequence: this.nextEventSequence,
      revision: this.revisionValue,
      kind,
      ...detail,
    });
    this.nextEventSequence += 1;
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot, event);
  }

  /**
   * Applies a target only when it produces a different requested cut.
   *
   * Observers move within a layout's coverage far more often than they cross a
   * layout boundary. Updating only the target in that case avoids a graph
   * rebuild, revision advance, and topology snapshot with no visible effect.
   * Returns whether the requested cut changed.
   */
  updateTarget(target: Target): boolean {
    const nextTarget = immutableTarget(target);
    const nextRequested = this.indexCut(this.layoutSource.calculate(nextTarget));
    if (this.cutsEqual(this.requested, nextRequested)) {
      this.targetValue = nextTarget;
      return false;
    }

    this.targetValue = nextTarget;
    this.requested = nextRequested;
    this.revisionValue += 1;
    this.replan();
    return true;
  }

  /**
   * Restricts resource work to the visible subset of planner-owned topology.
   *
   * Candidate keys do not themselves create work. A visible committed tile may
   * be hydrated, and a visible transition group activates its planner-authored
   * batch plus the batch dependencies already declared by the planner.
   */
  updateVisibilityAdmission(
    visibleTiles: Iterable<TileIdentity>,
    revision = this.revisionValue,
  ): boolean {
    if (revision !== this.revisionValue) return false;
    const plannerCandidates = this.plannerCandidateKeys();
    const visible = new Set(
      [...visibleTiles]
        .map(tileIdentityKey)
        .filter((key) => plannerCandidates.has(key)),
    );
    if (this.keysEqual(this.visiblePlannerCandidates, visible)) return false;
    this.visiblePlannerCandidates = visible;
    this.reconcileAdmission();
    return true;
  }

  private cutsEqual(
    first: ReadonlyMap<string, TileIdentity>,
    second: ReadonlyMap<string, TileIdentity>,
  ): boolean {
    if (first.size !== second.size) return false;
    for (const key of first.keys()) {
      if (!second.has(key)) return false;
    }
    return true;
  }

  private keysEqual(
    first: ReadonlySet<string>,
    second: ReadonlySet<string>,
  ): boolean {
    if (first.size !== second.size) return false;
    for (const key of first) {
      if (!second.has(key)) return false;
    }
    return true;
  }

  retryFailed(tile?: TileIdentity): void {
    const selectedKey = tile ? tileIdentityKey(tile) : undefined;
    const failed = [...this.requirements.entries()].filter(
      ([key, requirement]) =>
        requirement.state === "failed" &&
        (selectedKey === undefined || key === selectedKey),
    );
    for (const [key, requirement] of failed) {
      this.requirements.delete(key);
      this.requestTile(requirement.tile, requirement.kind);
    }
  }

  private replan(): void {
    this.graphValue = planTransition(this.committed.values(), this.requested.values());
    // Admission was classified against the previous planner revision. Even
    // overlapping tile keys must remain deferred until the current revision
    // is classified and admitted explicitly.
    this.visiblePlannerCandidates.clear();
    this.reconcileAdmission();
  }

  private plannerCandidateKeys(): ReadonlySet<string> {
    const keys = new Set(this.committed.keys());
    for (const group of this.graphValue.groups) {
      for (const tile of group.before) keys.add(tileIdentityKey(tile));
      for (const tile of group.after) keys.add(tileIdentityKey(tile));
    }
    return keys;
  }

  private restrictVisibilityToCurrentPlan(): void {
    const plannerCandidates = this.plannerCandidateKeys();
    this.visiblePlannerCandidates = new Set(
      [...this.visiblePlannerCandidates].filter((key) =>
        plannerCandidates.has(key)
      ),
    );
  }

  private admittedBatchIds(): ReadonlySet<string> {
    const groupsById = new Map(
      this.graphValue.groups.map((group) => [group.id, group] as const),
    );
    const batchesById = new Map(
      this.graphValue.batches.map((batch) => [batch.id, batch] as const),
    );
    const admitted = new Set<string>();
    const admit = (batchId: string): void => {
      if (admitted.has(batchId)) return;
      const batch = batchesById.get(batchId);
      if (!batch) return;
      admitted.add(batchId);
      for (const dependency of batch.dependsOn) admit(dependency);
    };
    for (const batch of this.graphValue.batches) {
      const visible = batch.groupIds.some((groupId) => {
        const group = groupsById.get(groupId);
        return group !== undefined && [...group.before, ...group.after].some(
          (tile) => this.visiblePlannerCandidates.has(tileIdentityKey(tile)),
        );
      });
      if (visible) admit(batch.id);
    }
    return admitted;
  }

  private reconcileAdmission(): void {
    const needed = new Map<
      string,
      { readonly tile: TileIdentity; readonly kind: Requirement<Resource>["kind"] }
    >();
    for (const [key, tile] of this.committed) {
      if (
        this.visiblePlannerCandidates.has(key) &&
        !this.hydratedCommitted.has(key)
      ) {
        needed.set(key, { tile, kind: "committed" });
      }
    }
    const admittedBatchIds = this.admittedBatchIds();
    for (const batch of this.graphValue.batches) {
      if (!admittedBatchIds.has(batch.id)) continue;
      for (const groupId of batch.groupIds) {
        const group = this.groupById(groupId);
        for (const tile of group.after) {
          const key = tileIdentityKey(tile);
          if (!this.committed.has(key)) {
            needed.set(key, { tile, kind: "replacement" });
          }
        }
      }
    }

    for (const [key, requirement] of [...this.requirements]) {
      const stillNeeded = needed.get(key);
      if (stillNeeded) {
        requirement.kind = stillNeeded.kind;
        continue;
      }
      if (requirement.state === "requested" || requirement.state === "in-flight") {
        requirement.handle.cancel();
        this.notify("cancellation", {
          tile: requirement.tile,
          requestId: requirement.requestId,
          reason: "No longer required by the latest transition",
        });
      } else {
        this.notify("discard", {
          tile: requirement.tile,
          requestId: requirement.requestId,
          reason: "Staged resource is obsolete",
        });
      }
      this.requirements.delete(key);
    }

    for (const [key, { tile, kind }] of needed) {
      if (!this.requirements.has(key)) this.requestTile(tile, kind);
    }
    this.attemptCommits();
  }

  private requestTile(
    tile: TileIdentity,
    kind: Requirement<Resource>["kind"] = "replacement",
  ): void {
    const key = tileIdentityKey(tile);
    let requestId = -1;
    const handle = this.provider.request(tile, (result) => {
      this.handleProviderResult(key, requestId, result);
    });
    requestId = handle.requestId;
    const requirement: Requirement<Resource> = {
      tile: immutableTile(tile),
      kind,
      state: "requested",
      requestId,
      handle,
    };
    this.requirements.set(key, requirement);
    this.notify("request", { tile: requirement.tile, requestId });
  }

  private handleProviderResult(
    key: string,
    requestId: number,
    result: TileProviderResult<Resource>,
  ): void {
    const requirement = this.requirements.get(key);
    if (!requirement || requirement.requestId !== requestId) return;
    if (result.phase === "in-flight") {
      requirement.state = "in-flight";
      this.notify("in-flight", { tile: requirement.tile, requestId });
      return;
    }
    if (result.phase === "failure") {
      requirement.state = "failed";
      requirement.reason = result.reason;
      this.notify("failure", {
        tile: requirement.tile,
        requestId,
        reason: result.reason,
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: result.retryAfterMs }),
        ...(result.retryable === undefined
          ? {}
          : { retryable: result.retryable }),
        ...(result.scope === undefined ? {} : { scope: result.scope }),
      });
      return;
    }
    requirement.state = "ready";
    requirement.resource = result.resource;
    delete requirement.reason;
    if (requirement.kind === "committed" && this.committed.has(key)) {
      this.committedResources.set(key, result.resource);
      this.hydratedCommitted.add(key);
      this.requirements.delete(key);
      this.notify("response", { tile: requirement.tile, requestId });
      return;
    }
    this.notify("response", { tile: requirement.tile, requestId });
    this.attemptCommits();
  }

  private groupById(id: string): ReplacementGroup {
    const group = this.graphValue.groups.find((candidate) => candidate.id === id);
    if (!group) throw new Error(`Transition graph references missing group ${id}.`);
    return group;
  }

  private batchReady(batch: TransitionBatch): boolean {
    if (batch.dependsOn.length > 0) return false;
    return batch.groupIds.every((groupId) =>
      this.groupById(groupId).after.every((tile) => {
        const key = tileIdentityKey(tile);
        return this.requirements.get(key)?.state === "ready";
      }),
    );
  }

  private attemptCommits(): void {
    if (this.changing) return;
    this.changing = true;
    try {
      while (true) {
        const batch = this.graphValue.batches.find((candidate) =>
          this.batchReady(candidate),
        );
        if (!batch) break;
        const event = this.commitBatch(batch);
        this.reconcileAfterCommit();
        // Publish only after the next progressive stage's exact requirements
        // exist, so main-thread admission cannot see a transient empty set.
        this.notify("atomic-swap", event);
      }
    } finally {
      this.changing = false;
    }
  }

  private commitBatch(
    batch: TransitionBatch,
  ): Omit<SchedulerEvent, "sequence" | "revision" | "kind"> {
    const groups = batch.groupIds.map((id) => this.groupById(id));
    const before = sortedTiles(groups.flatMap((group) => [...group.before]));
    const after = sortedTiles(groups.flatMap((group) => [...group.after]));

    for (const tile of before) {
      const key = tileIdentityKey(tile);
      this.committed.delete(key);
      this.committedResources.delete(key);
      this.hydratedCommitted.delete(key);
    }
    for (const tile of after) {
      const key = tileIdentityKey(tile);
      this.committed.set(key, tile);
      const requirement = this.requirements.get(key);
      this.committedResources.set(key, requirement?.resource);
      this.hydratedCommitted.add(key);
      if (requirement) this.requirements.delete(key);
    }
    // Replan against the topology that now exists so the subsequent atomic
    // snapshot cannot expose the just-consumed graph.
    this.graphValue = planTransition(
      this.committed.values(),
      this.requested.values(),
    );
    return {
      batchId: batch.id,
      groupIds: batch.groupIds,
      before,
      after,
    };
  }

  private reconcileAfterCommit(): void {
    this.restrictVisibilityToCurrentPlan();
    this.reconcileAdmission();
  }
}
