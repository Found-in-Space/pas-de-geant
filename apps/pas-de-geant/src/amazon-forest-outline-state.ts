import {
  amazonForestOutlineYearsWithVisibility,
  type AmazonForestOutlineControlState,
} from "./amazon-forest-outline-control.js";

export interface AmazonForestOutlineStateTarget {
  availableYears(): Promise<readonly number[]>;
  setYears(years: readonly number[]): Promise<void>;
}

export type AmazonForestOutlineStateListener = (
  state: AmazonForestOutlineControlState,
) => void;

/** Canonical state and mutation boundary shared by UI and agent adapters. */
export class AmazonForestOutlineStore {
  private availableYears: readonly number[] = [];
  private visibleYears: readonly number[] = [];
  private readonly listeners = new Set<AmazonForestOutlineStateListener>();
  private loadRequest: Promise<AmazonForestOutlineControlState> | undefined;
  private mutationQueue = Promise.resolve();

  constructor(private readonly target: AmazonForestOutlineStateTarget) {}

  snapshot(): AmazonForestOutlineControlState {
    return {
      availableYears: [...this.availableYears],
      visibleYears: [...this.visibleYears],
    };
  }

  load(): Promise<AmazonForestOutlineControlState> {
    this.loadRequest ??= this.target.availableYears().then((years) => {
      const availableYears = years.map((year) => {
        if (!Number.isInteger(year)) {
          throw new Error("Amazon forest outline years must be integers.");
        }
        return year;
      });
      if (new Set(availableYears).size !== availableYears.length) {
        throw new Error("Amazon forest outline years must be unique.");
      }
      this.availableYears = availableYears;
      this.emit();
      return this.snapshot();
    });
    return this.loadRequest;
  }

  setYearVisibility(
    year: number,
    visible: boolean,
  ): Promise<AmazonForestOutlineControlState> {
    const mutation = this.mutationQueue.then(async () => {
      await this.load();
      const nextYears = amazonForestOutlineYearsWithVisibility(
        this.visibleYears,
        this.availableYears,
        year,
        visible,
      );
      await this.target.setYears(nextYears);
      this.visibleYears = nextYears;
      this.emit();
      return this.snapshot();
    });
    this.mutationQueue = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  subscribe(listener: AmazonForestOutlineStateListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}
