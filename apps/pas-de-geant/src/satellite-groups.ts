export const SATELLITE_GROUP_IDS = [
  "visual",
  "stations",
  "science-education",
] as const;

export type SatelliteGroupId = typeof SATELLITE_GROUP_IDS[number];

export type SatelliteToolGroup =
  | "brightest"
  | "space_stations"
  | "science_education";

export interface SatelliteGroupConfiguration {
  readonly id: SatelliteGroupId;
  readonly toolGroup: SatelliteToolGroup;
  readonly label: string;
  readonly shortLabel: string;
  readonly color: number;
  readonly celestrakGroups: readonly string[];
}

export const SATELLITE_GROUPS: readonly SatelliteGroupConfiguration[] = [
  {
    id: "visual",
    toolGroup: "brightest",
    label: "100 brightest",
    shortLabel: "Brightest",
    color: 0xffe59a,
    celestrakGroups: ["visual"],
  },
  {
    id: "stations",
    toolGroup: "space_stations",
    label: "Space stations",
    shortLabel: "Stations",
    color: 0xff9f7a,
    celestrakGroups: ["stations"],
  },
  {
    id: "science-education",
    toolGroup: "science_education",
    label: "Science / education",
    shortLabel: "Science / education",
    color: 0xc5a2ff,
    celestrakGroups: ["science", "education"],
  },
];

const configurations = new Map(
  SATELLITE_GROUPS.map((configuration) => [configuration.id, configuration]),
);
const toolGroups = new Map(
  SATELLITE_GROUPS.map((configuration) => [
    configuration.toolGroup,
    configuration.id,
  ]),
);

export function isSatelliteGroupId(value: unknown): value is SatelliteGroupId {
  return SATELLITE_GROUP_IDS.includes(value as SatelliteGroupId);
}

export function satelliteGroupConfiguration(
  id: SatelliteGroupId,
): SatelliteGroupConfiguration {
  return configurations.get(id)!;
}

export function parseSatelliteVisibilityArguments(value: unknown): {
  group: SatelliteGroupId;
  enabled: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Satellite visibility arguments must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const group = toolGroups.get(candidate.group as SatelliteToolGroup);
  if (!group) {
    throw new Error(
      "Satellite group must be brightest, space_stations, or science_education.",
    );
  }
  if (typeof candidate.enabled !== "boolean") {
    throw new Error("Satellite visibility requires a boolean enabled value.");
  }
  return { group, enabled: candidate.enabled };
}
