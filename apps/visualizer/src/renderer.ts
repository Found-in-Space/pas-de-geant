import type {
  EclipseScene,
  Observer,
} from "@found-in-space/shadowline";

export interface MapView {
  latitude: number;
  longitude: number;
  zoom: number;
}

export const ECLIPSE_LAYER_KEYS = [
  "centralPath",
  "partialExtent",
  "horizonLimits",
  "contacts",
  "localPenumbra",
  "localCentralShadow",
  "centerAndLimits",
  "timeMarkers",
] as const;

export type EclipseLayerKey = (typeof ECLIPSE_LAYER_KEYS)[number];

export type EclipseLayerVisibility = Record<EclipseLayerKey, boolean>;

export const DEFAULT_LAYER_VISIBILITY: EclipseLayerVisibility = {
  centralPath: true,
  partialExtent: true,
  horizonLimits: true,
  contacts: true,
  localPenumbra: true,
  localCentralShadow: true,
  centerAndLimits: true,
  timeMarkers: true,
};

export interface EclipseRenderer {
  readonly id: "mercator" | "globe" | "world";
  onLocation?: (observer: Observer) => void;
  showPath(scene: EclipseScene): void;
  showGlobalVisibility(
    scene: EclipseScene | null,
    anchorLongitude?: number,
  ): void;
  showPeak(
    latitudeDeg: number | undefined,
    longitudeDeg: number | undefined,
  ): void;
  showShadowOutline(scene: EclipseScene | null): void;
  clearShadowOutline(): void;
  clearGlobalVisibility(): void;
  clearPath(): void;
  fitPath(): void;
  fitGlobalVisibility(): void;
  setLocation(observer: Observer): void;
  setLayerVisibility(visibility: EclipseLayerVisibility): void;
}
