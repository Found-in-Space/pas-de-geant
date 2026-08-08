import {
  demandedPayloadTiles,
  eligiblePayloadTiles,
} from "./tile-debug-controls.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";
import { tileDemandForAdmission } from "./tile-movement-admission.js";
import {
  classifyHotAndForecastResidency,
  classifyWarmResidency,
  hotResidencySignature,
  sameResidencyKeys,
  warmResidencySignature,
  type MercatorForecastDisplacement,
  type ViewResidencyInput,
} from "./view-residency.js";

export interface TileResidencyPolicyInput {
  readonly committedTiles: readonly TileIdentity[];
  readonly requestedTiles: readonly TileIdentity[];
  /** Exact transition resources; these always bypass speculative admission. */
  readonly requirements: readonly { readonly tile: TileIdentity }[];
  readonly targetZoom: number;
  readonly revision: number;
  readonly view: ViewResidencyInput;
  readonly overheadPercent: number;
  readonly viewDistanceEnabled: boolean;
  readonly deltaZoomCap: number | null;
  readonly deferSpeculativeWarm: boolean;
  readonly forecastDisplacement?: MercatorForecastDisplacement;
  readonly forecastSignature: number;
  isResidentOrInFlight(tile: TileIdentity): boolean;
}

export interface TileResidencyPolicyResult {
  readonly priorityTiles: readonly TileIdentity[];
  /** Undefined means only provider priority changed; demand is unchanged. */
  readonly demandedTiles?: readonly TileIdentity[];
  readonly fullDemandedTileCount: number;
  readonly deferredTileCount: number;
}

export interface TileResidencyPolicyMetrics {
  readonly hotTileCount: number;
  readonly forecastTileCount: number;
  readonly warmTileCount: number;
  readonly classificationTotal: number;
  readonly hotClassificationTotal: number;
  readonly warmClassificationTotal: number;
  readonly deferredTileOccurrenceTotal: number;
  readonly deferredTileCount: number;
}

/**
 * Shared event-driven residency and admission policy for terrain and imagery.
 * It owns classification memoization so both payload paths make identical
 * decisions without adding another render-frame cut scan.
 */
export class TileResidencyPolicy {
  private hotKeysValue = new Set<string>();
  private forecastKeysValue = new Set<string>();
  private warmKeysValue = new Set<string>();
  private requirementKeysValue = new Set<string>();
  private hotViewSignature = -1;
  private hotRevision = -2;
  private warmViewSignature = -1;
  private warmRevision = -2;
  private committedTilesReference: readonly TileIdentity[] | undefined;
  private requestedTilesReference: readonly TileIdentity[] | undefined;
  private requirementsReference:
    | readonly { readonly tile: TileIdentity }[]
    | undefined;
  private admissionDeferred: boolean | undefined;
  private classificationTotal = 0;
  private hotClassificationTotal = 0;
  private warmClassificationTotal = 0;
  private deferredTileOccurrenceTotal = 0;
  private deferredTileCount = 0;
  private fullDemandedTileCount = 0;

  get hotKeys(): ReadonlySet<string> {
    return this.hotKeysValue;
  }

  get forecastKeys(): ReadonlySet<string> {
    return this.forecastKeysValue;
  }

  get warmKeys(): ReadonlySet<string> {
    return this.warmKeysValue;
  }

  get metrics(): TileResidencyPolicyMetrics {
    return {
      hotTileCount: this.hotKeysValue.size,
      forecastTileCount: this.forecastKeysValue.size,
      warmTileCount: this.warmKeysValue.size,
      classificationTotal: this.classificationTotal,
      hotClassificationTotal: this.hotClassificationTotal,
      warmClassificationTotal: this.warmClassificationTotal,
      deferredTileOccurrenceTotal: this.deferredTileOccurrenceTotal,
      deferredTileCount: this.deferredTileCount,
    };
  }

  invalidate(): void {
    this.hotViewSignature = -1;
    this.hotRevision = -2;
    this.warmViewSignature = -1;
    this.warmRevision = -2;
    this.committedTilesReference = undefined;
    this.requestedTilesReference = undefined;
    this.requirementsReference = undefined;
    this.admissionDeferred = undefined;
  }

  update(input: TileResidencyPolicyInput): TileResidencyPolicyResult | undefined {
    const visibleSignature = hotResidencySignature(input.targetZoom, input.view);
    const hotSignature = Math.imul(
      visibleSignature ^ input.forecastSignature,
      16_777_619,
    ) >>> 0;
    const warmSignature = warmResidencySignature(
      input.targetZoom,
      input.view,
      input.overheadPercent,
    );
    // Scheduler plan revision identifies the target, not every atomic swap.
    // Immutable snapshot-array identity catches same-revision cut and
    // requirement changes without scanning the cut on rendered frames.
    const workingSetChanged =
      input.committedTiles !== this.committedTilesReference ||
      input.requestedTiles !== this.requestedTilesReference ||
      input.requirements !== this.requirementsReference;
    const hotNeedsClassification =
      hotSignature !== this.hotViewSignature ||
      input.revision !== this.hotRevision ||
      workingSetChanged;
    const warmNeedsClassification =
      warmSignature !== this.warmViewSignature ||
      input.revision !== this.warmRevision ||
      workingSetChanged;
    const admissionDeferralChanged =
      input.deferSpeculativeWarm !== this.admissionDeferred;
    if (
      !hotNeedsClassification &&
      !warmNeedsClassification &&
      !admissionDeferralChanged
    ) return undefined;

    this.hotViewSignature = hotSignature;
    this.hotRevision = input.revision;
    this.warmViewSignature = warmSignature;
    this.warmRevision = input.revision;
    this.committedTilesReference = input.committedTiles;
    this.requestedTilesReference = input.requestedTiles;
    this.requirementsReference = input.requirements;
    this.admissionDeferred = input.deferSpeculativeWarm;
    this.classificationTotal += 1;
    if (hotNeedsClassification) this.hotClassificationTotal += 1;
    if (warmNeedsClassification) this.warmClassificationTotal += 1;

    const requirementTiles = input.requirements.map(({ tile }) => tile);
    const requirementKeys = new Set(requirementTiles.map(tileIdentityKey));
    const requirementsChanged = !sameResidencyKeys(
      this.requirementKeysValue,
      requirementKeys,
    );
    this.requirementKeysValue = requirementKeys;
    const tiles = tileWorkingSet(
      input.committedTiles,
      input.requestedTiles,
      requirementTiles,
    );

    if (hotNeedsClassification) {
      const classified = classifyHotAndForecastResidency(
        tiles,
        input.view,
        input.forecastDisplacement,
      );
      this.hotKeysValue = new Set(classified.hot);
      this.forecastKeysValue = new Set(classified.forecast);
    }

    const eligible = eligiblePayloadTiles(
      tiles,
      input.targetZoom,
      input.deltaZoomCap,
    );
    let warmChanged = false;
    if (warmNeedsClassification) {
      const warm = input.viewDistanceEnabled
        ? classifyWarmResidency(
            eligible,
            input.view,
            this.warmKeysValue,
            input.overheadPercent,
          )
        : new Set(eligible.map((tile) => tileIdentityKey(tile)));
      warmChanged = !sameResidencyKeys(this.warmKeysValue, warm);
      this.warmKeysValue = new Set(warm);
    }

    const priorityTiles = priorityPayloadTiles(
      eligible,
      requirementTiles,
      this.hotKeysValue,
      this.forecastKeysValue,
    );
    if (
      !warmChanged &&
      !requirementsChanged &&
      !admissionDeferralChanged &&
      !(input.deferSpeculativeWarm && hotNeedsClassification)
    ) {
      return {
        priorityTiles,
        fullDemandedTileCount: this.fullDemandedTileCount,
        deferredTileCount: this.deferredTileCount,
      };
    }

    const ordinaryDemanded = demandedPayloadTiles(
      tiles,
      input.targetZoom,
      input.deltaZoomCap,
      input.viewDistanceEnabled,
      this.warmKeysValue,
    );
    const admittedTiles = tileDemandForAdmission(
      ordinaryDemanded,
      this.hotKeysValue,
      this.forecastKeysValue,
      input.deferSpeculativeWarm,
      input.isResidentOrInFlight,
    );
    // A transition requirement is correctness-critical, not speculative warm
    // work. It must remain admitted even when debug LOD filters or motion
    // admission exclude it from the ordinary working set.
    const demandedTiles = uniqueTiles(
      admittedTiles,
      requirementTiles,
    );
    const fullDemanded = uniqueTiles(ordinaryDemanded, requirementTiles);
    this.fullDemandedTileCount = fullDemanded.length;
    this.deferredTileCount = fullDemanded.length - demandedTiles.length;
    this.deferredTileOccurrenceTotal += this.deferredTileCount;
    return {
      priorityTiles,
      demandedTiles,
      fullDemandedTileCount: this.fullDemandedTileCount,
      deferredTileCount: this.deferredTileCount,
    };
  }
}

/** Deduplicated union used by both residency policies. */
export function tileWorkingSet(
  committed: readonly TileIdentity[],
  requested: readonly TileIdentity[],
  requirements: readonly TileIdentity[] = [],
): readonly TileIdentity[] {
  return uniqueTiles(committed, requested, requirements);
}

function uniqueTiles(
  ...groups: readonly (readonly TileIdentity[])[]
): TileIdentity[] {
  const unique = new Map<string, TileIdentity>();
  for (const group of groups) {
    for (const tile of group) unique.set(tileIdentityKey(tile), tile);
  }
  return [...unique.values()];
}

/**
 * Work allowed to bypass speculative warm ramping, in priority order.
 * Ordinary warm demand is deliberately absent: including it here would mark
 * every queued miss as hot and defeat provider burst protection.
 */
function priorityPayloadTiles(
  eligible: readonly TileIdentity[],
  requirementTiles: readonly TileIdentity[],
  hotKeys: ReadonlySet<string>,
  forecastKeys: ReadonlySet<string>,
): TileIdentity[] {
  const hot = eligible.filter((tile) => hotKeys.has(tileIdentityKey(tile)));
  const forecast = eligible.filter((tile) =>
    forecastKeys.has(tileIdentityKey(tile))
  );
  return uniqueTiles(hot, requirementTiles, forecast);
}
