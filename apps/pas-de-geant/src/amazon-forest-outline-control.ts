export interface AmazonForestOutlineControlState {
  readonly availableYears: readonly number[];
  readonly visibleYears: readonly number[];
}

const OUTLINE_COLORS = [
  "#ffc857",
  "#32ef9a",
  "#5aa9ff",
  "#d779ff",
  "#ff7968",
] as const;

function integerYear(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("Amazon forest outline year must be an integer.");
  }
  return value;
}

export function normalizeAmazonForestOutlineYears(
  years: readonly number[],
  availableYears: readonly number[],
): readonly number[] {
  const available = new Set(availableYears);
  const normalized = [...new Set(years.map(integerYear))];
  for (const year of normalized) {
    if (!available.has(year)) {
      throw new Error(`Amazon forest outline ${year} is unavailable.`);
    }
  }
  return availableYears.filter((year) => normalized.includes(year));
}

export function amazonForestOutlineYearsWithVisibility(
  visibleYears: readonly number[],
  availableYears: readonly number[],
  yearValue: unknown,
  visible: boolean,
): readonly number[] {
  const year = integerYear(yearValue);
  const selected = new Set(
    normalizeAmazonForestOutlineYears(visibleYears, availableYears),
  );
  if (!availableYears.includes(year)) {
    throw new Error(`Amazon forest outline ${year} is unavailable.`);
  }
  if (visible) selected.add(year);
  else selected.delete(year);
  return availableYears.filter((candidate) => selected.has(candidate));
}

export function parseAmazonForestOutlineVisibilityArguments(value: unknown): {
  readonly year: number;
  readonly visible: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Amazon forest outline arguments are required.");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.visible !== "boolean") {
    throw new Error("Amazon forest outline visibility must be boolean.");
  }
  return { year: integerYear(candidate.year), visible: candidate.visible };
}

export function amazonForestOutlineColor(
  year: number,
  availableYears: readonly number[],
): string {
  const index = availableYears.indexOf(year);
  const paletteIndex = index < 0 ? Math.abs(year) : index;
  return OUTLINE_COLORS[paletteIndex % OUTLINE_COLORS.length]!;
}
