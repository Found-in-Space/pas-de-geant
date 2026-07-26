import type { EclipseLayerKey } from "./renderer.js";
import type { Feature } from "@found-in-space/shadowline";

export const ECLIPSE_COLORS = {
  ink: "#1d1a24",
  centralPath: "#8f56aa",
  limits: "#d04f9c",
  extent: "#2d9b59",
  horizon: "#b5b72b",
  contact: "#e3342f",
  penumbraLine: "#d89b24",
  penumbraFill: "#f0bd43",
  centralShadowLine: "#46205d",
  centralShadowFill: "#5c2a75",
  observer: "#256d67",
} as const;

export function layerKeyForFeature(
  feature: Feature,
): EclipseLayerKey | null {
  switch (feature.properties.feature_type) {
    case "central_path":
      return "centralPath";
    case "penumbra_extent":
      return "partialExtent";
    case "penumbra_horizon":
      return "horizonLimits";
    case "penumbral_contact":
      return "contacts";
    case "instantaneous_penumbra":
      return "localPenumbra";
    case "instantaneous_umbra":
    case "instantaneous_antumbra":
      return "localCentralShadow";
    case "centerline":
    case "positive_cross_track_limit":
    case "negative_cross_track_limit":
      return "centerAndLimits";
    case "time_marker":
      return "timeMarkers";
    default:
      return null;
  }
}

export function popupForFeature(feature: Feature): string {
  const properties = feature.properties;
  if (properties.feature_type === "time_marker") {
    return `<strong>${String(properties.name)}</strong>
      <dl class="popup-data">
        <div><dt>Sun altitude</dt><dd>${String(properties.sun_altitude_deg)}°</dd></div>
        <div><dt>Sun azimuth</dt><dd>${String(properties.sun_azimuth_deg)}°</dd></div>
        <div><dt>Path width</dt><dd>${String(properties.path_width_km)} km</dd></div>
        <div><dt>Centre duration</dt><dd>${String(properties.central_duration_seconds ?? "—")} s</dd></div>
      </dl>`;
  }
  return `<strong>${String(properties.name ?? "Eclipse feature")}</strong>`;
}
