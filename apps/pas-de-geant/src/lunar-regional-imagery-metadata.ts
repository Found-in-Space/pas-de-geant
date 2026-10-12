import apollo11 from "./data/apollo11-regional.json" with { type: "json" };
import apollo12 from "./data/apollo12-regional.json" with { type: "json" };
import apollo14 from "./data/apollo14-regional.json" with { type: "json" };
import apollo15 from "./data/apollo15-regional.json" with { type: "json" };
import apollo16 from "./data/apollo16-regional.json" with { type: "json" };
import apollo17 from "./data/apollo17-regional.json" with { type: "json" };
import apollo11Fine from "./data/apollo11-fine.json" with { type: "json" };

export type LunarRegionalImagery = Omit<typeof apollo11, "inputs"> & {
  readonly inputs: readonly {
    readonly url: string;
    readonly sha256?: string;
    readonly byteRange?: string;
    readonly headerMetadataSha256?: string;
    readonly method?: string;
  }[];
};
export const APOLLO_REGIONAL_IMAGERY: Readonly<Record<number, LunarRegionalImagery>> = {
  11: apollo11, 12: apollo12, 14: apollo14, 15: apollo15, 16: apollo16, 17: apollo17,
};

export const LUNAR_ARCHIVE_IMAGERY: readonly LunarRegionalImagery[] = [
  ...Object.values(APOLLO_REGIONAL_IMAGERY), apollo11Fine,
];
