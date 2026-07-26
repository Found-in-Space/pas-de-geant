import type {
  EclipseScene,
  Observer,
} from "@found-in-space/shadowline";
import {
  DEFAULT_LAYER_VISIBILITY,
  type EclipseLayerVisibility,
  type EclipseRenderer,
} from "./renderer.js";

export class EclipseRendererCoordinator {
  onLocation?: (observer: Observer) => void;

  constructor(private readonly renderers: EclipseRenderer[]) {
    for (const renderer of renderers) {
      renderer.onLocation = (observer) => {
        this.setLocation(observer);
        this.onLocation?.(observer);
      };
      renderer.setLayerVisibility(DEFAULT_LAYER_VISIBILITY);
    }
  }

  showPath(scene: EclipseScene): void {
    for (const renderer of this.renderers) renderer.showPath(scene);
  }

  showGlobalVisibility(
    scene: EclipseScene | null,
    anchorLongitude?: number,
  ): void {
    for (const renderer of this.renderers) {
      renderer.showGlobalVisibility(scene, anchorLongitude);
    }
  }

  showPeak(
    latitudeDeg: number | undefined,
    longitudeDeg: number | undefined,
  ): void {
    for (const renderer of this.renderers) {
      renderer.showPeak(latitudeDeg, longitudeDeg);
    }
  }

  showShadowOutline(scene: EclipseScene | null): void {
    for (const renderer of this.renderers) {
      renderer.showShadowOutline(scene);
    }
  }

  clearShadowOutline(): void {
    for (const renderer of this.renderers) renderer.clearShadowOutline();
  }

  clearGlobalVisibility(): void {
    for (const renderer of this.renderers) renderer.clearGlobalVisibility();
  }

  clearPath(): void {
    for (const renderer of this.renderers) renderer.clearPath();
  }

  fitPath(): void {
    for (const renderer of this.renderers) renderer.fitPath();
  }

  fitGlobalVisibility(): void {
    for (const renderer of this.renderers) {
      renderer.fitGlobalVisibility();
    }
  }

  setLocation(observer: Observer): void {
    for (const renderer of this.renderers) renderer.setLocation(observer);
  }

  setLayerVisibility(visibility: EclipseLayerVisibility): void {
    for (const renderer of this.renderers) {
      renderer.setLayerVisibility(visibility);
    }
  }
}
