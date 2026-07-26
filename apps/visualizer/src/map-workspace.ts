import type {
  EclipseScene,
  Observer,
} from "@found-in-space/shadowline";
import {
  LeafletEquirectangularRenderer,
  LeafletMercatorRenderer,
} from "./leaflet-renderer.js";
import { MapLibreGlobeRenderer } from "./maplibre-renderer.js";
import {
  type EclipseLayerVisibility,
  type MapView,
} from "./renderer.js";
import { EclipseRendererCoordinator } from "./renderer-coordinator.js";

interface MapWorkspaceElements {
  mercator: HTMLElement;
  globe: HTMLElement;
  world: HTMLElement;
}

export class EclipseMapWorkspace {
  readonly mercator: LeafletMercatorRenderer;
  readonly globe: MapLibreGlobeRenderer;
  readonly world: LeafletEquirectangularRenderer;
  private readonly coordinator: EclipseRendererCoordinator;
  onLocation?: (observer: Observer) => void;
  onViewChanged?: (view: MapView) => void;

  constructor(elements: MapWorkspaceElements, initialView: MapView) {
    this.mercator = new LeafletMercatorRenderer(
      elements.mercator,
      initialView,
    );
    this.globe = new MapLibreGlobeRenderer(elements.globe);
    this.world = new LeafletEquirectangularRenderer(elements.world);
    this.coordinator = new EclipseRendererCoordinator([
      this.mercator,
      this.globe,
      this.world,
    ]);
    this.coordinator.onLocation = (observer) => {
      this.onLocation?.(observer);
    };
    this.mercator.onViewChanged = (view) => {
      this.onViewChanged?.(view);
    };
  }

  showPath(scene: EclipseScene): void {
    this.coordinator.showPath(scene);
  }

  showGlobalVisibility(
    scene: EclipseScene | null,
    anchorLongitude?: number,
  ): void {
    this.coordinator.showGlobalVisibility(scene, anchorLongitude);
  }

  showPeak(
    latitudeDeg: number | undefined,
    longitudeDeg: number | undefined,
  ): void {
    this.coordinator.showPeak(latitudeDeg, longitudeDeg);
  }

  showShadowOutline(scene: EclipseScene | null): void {
    this.coordinator.showShadowOutline(scene);
  }

  clearShadowOutline(): void {
    this.coordinator.clearShadowOutline();
  }

  clearGlobalVisibility(): void {
    this.coordinator.clearGlobalVisibility();
  }

  clearPath(): void {
    this.coordinator.clearPath();
  }

  fitPath(): void {
    this.coordinator.fitPath();
  }

  fitGlobalVisibility(): void {
    this.coordinator.fitGlobalVisibility();
  }

  setLocation(observer: Observer): void {
    this.coordinator.setLocation(observer);
  }

  setLayerVisibility(visibility: EclipseLayerVisibility): void {
    this.coordinator.setLayerVisibility(visibility);
  }

  getView(): MapView {
    return this.mercator.getView();
  }
}
