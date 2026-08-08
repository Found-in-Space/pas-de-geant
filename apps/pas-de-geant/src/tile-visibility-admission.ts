import {
  tileIdentityKey,
  type ReplacementGroup,
  type TileIdentity,
} from "./tile-transition-planner.js";
import {
  classifyVisibleTiles,
  sameTileKeys,
  type ViewVisibilityInput,
} from "./view-visibility.js";

export interface TileVisibilityAdmissionInput {
  readonly revision: number;
  readonly committedTiles: readonly TileIdentity[];
  readonly replacementGroups: readonly ReplacementGroup[];
  readonly view: ViewVisibilityInput;
}

export interface TileVisibilityAdmissionMetrics {
  readonly visibleTileCount: number;
  readonly classificationTotal: number;
}

/**
 * Returns the complete set the visibility layer is allowed to inspect.
 * Requested cuts and scheduler requirements are deliberately absent: the
 * planner's replacement groups remain the sole authority for future work.
 */
export function plannerVisibilityCandidates(
  committedTiles: readonly TileIdentity[],
  replacementGroups: readonly ReplacementGroup[],
): readonly TileIdentity[] {
  const candidates = new Map<string, TileIdentity>();
  for (const tile of committedTiles) {
    candidates.set(tileIdentityKey(tile), tile);
  }
  for (const group of replacementGroups) {
    for (const tile of group.after) {
      candidates.set(tileIdentityKey(tile), tile);
    }
  }
  return [...candidates.values()];
}

/**
 * Selects only planner-owned tiles intersecting the current footprint.
 * Every update is classified exactly; the cached result is used only to avoid
 * sending an unchanged admission set back to the scheduler.
 */
export class TileVisibilityAdmission {
  private visibleKeysValue = new Set<string>();
  private revisionValue: number | undefined;
  private classificationTotal = 0;
  private notificationRequired = false;

  get visibleKeys(): ReadonlySet<string> {
    return this.visibleKeysValue;
  }

  get metrics(): TileVisibilityAdmissionMetrics {
    return {
      visibleTileCount: this.visibleKeysValue.size,
      classificationTotal: this.classificationTotal,
    };
  }

  invalidate(): void {
    this.notificationRequired = true;
  }

  update(
    input: TileVisibilityAdmissionInput,
  ): readonly TileIdentity[] | undefined {
    const candidates = plannerVisibilityCandidates(
      input.committedTiles,
      input.replacementGroups,
    );
    const visibleKeys = classifyVisibleTiles(candidates, input.view);
    this.classificationTotal += 1;
    if (
      !this.notificationRequired &&
      this.revisionValue === input.revision &&
      sameTileKeys(this.visibleKeysValue, visibleKeys)
    ) {
      return undefined;
    }
    this.notificationRequired = false;
    this.revisionValue = input.revision;
    this.visibleKeysValue = new Set(visibleKeys);
    return candidates.filter((tile) => visibleKeys.has(tileIdentityKey(tile)));
  }
}
