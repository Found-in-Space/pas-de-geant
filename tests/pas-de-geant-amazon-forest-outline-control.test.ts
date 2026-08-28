import { describe, expect, it } from "vitest";
import {
  amazonForestOutlineYearsWithVisibility,
  normalizeAmazonForestOutlineYears,
  parseAmazonForestOutlineVisibilityArguments,
} from "../apps/pas-de-geant/src/amazon-forest-outline-control.js";
import { AmazonForestOutlineStore } from "../apps/pas-de-geant/src/amazon-forest-outline-state.js";

describe("Amazon forest outline controls", () => {
  const availableYears = [1986, 2000, 2023];

  it("independently enables and disables years in manifest order", () => {
    const twoYears = amazonForestOutlineYearsWithVisibility(
      [2023],
      availableYears,
      1986,
      true,
    );
    expect(twoYears).toEqual([1986, 2023]);
    expect(amazonForestOutlineYearsWithVisibility(
      twoYears,
      availableYears,
      2023,
      false,
    )).toEqual([1986]);
  });

  it("rejects unavailable years and malformed voice arguments", () => {
    expect(() => normalizeAmazonForestOutlineYears([1999], availableYears))
      .toThrow("1999 is unavailable");
    expect(() => parseAmazonForestOutlineVisibilityArguments({
      year: 2023.5,
      visible: true,
    })).toThrow(/integer/i);
    expect(() => parseAmazonForestOutlineVisibilityArguments({
      year: 2023,
      visible: "yes",
    })).toThrow(/boolean/i);
  });

  it("serializes mutations and publishes one canonical state", async () => {
    const appliedYears: number[][] = [];
    const store = new AmazonForestOutlineStore({
      async availableYears() {
        return availableYears;
      },
      async setYears(years) {
        appliedYears.push([...years]);
      },
    });
    const states: Array<{ availableYears: readonly number[]; visibleYears: readonly number[] }> = [];
    const unsubscribe = store.subscribe((state) => states.push(state));

    await store.load();
    await Promise.all([
      store.setYearVisibility(2023, true),
      store.setYearVisibility(1986, true),
    ]);
    unsubscribe();

    expect(appliedYears).toEqual([[2023], [1986, 2023]]);
    expect(store.snapshot()).toEqual({
      availableYears,
      visibleYears: [1986, 2023],
    });
    expect(states.at(-1)?.visibleYears).toEqual([1986, 2023]);
  });
});
