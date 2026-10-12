import type { InitialLocation } from "./initial-location.js";
import { APOLLO_STUDY_SITES } from "./lunar-sites.js";

export interface WorldLaunch {
  readonly body: "earth" | "moon";
  readonly location?: InitialLocation;
  readonly scaleDenominator?: number;
  readonly lunarPreview: boolean;
  readonly label?: string;
}

export function worldLaunchFromQuery(parameters: URLSearchParams): WorldLaunch {
  const body = parameters.get("world") === "moon" ? "moon" : "earth";
  const apollo = body === "moon" && parameters.get("site") === "apollo11"
    ? APOLLO_STUDY_SITES.find((site) => site.mission === 11)! : undefined;
  const scale = Number(parameters.get("scale"));
  return {
    body,
    ...(apollo ? { location: { latitudeDegrees: apollo.latitude, longitudeDegrees: apollo.longitude, source: "preset" as const }, label: "Apollo 11 · Tranquility Base" } : {}),
    ...(Number.isFinite(scale) && scale > 0 ? { scaleDenominator: scale } : apollo ? { scaleDenominator: 50 } : {}),
    lunarPreview: body === "moon" && (parameters.get("imagery") === "apollo11-preview" || Boolean(apollo) && parameters.get("imagery") !== "global"),
  };
}

export const APOLLO11_VR_ENTRY = "/?world=moon&site=apollo11&scale=50&imagery=apollo11-preview";
