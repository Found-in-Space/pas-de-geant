import { describe, expect, it, vi } from "vitest";
import type {
  EclipseScene,
  Observer,
} from "@found-in-space/shadowline";
import { EclipseRendererCoordinator } from "../apps/visualizer/src/renderer-coordinator.js";
import {
  DEFAULT_LAYER_VISIBILITY,
  type EclipseLayerVisibility,
  type EclipseRenderer,
} from "../apps/visualizer/src/renderer.js";

function fakeRenderer(
  id: EclipseRenderer["id"],
): EclipseRenderer & Record<string, unknown> {
  return {
    id,
    showPath: vi.fn(),
    showGlobalVisibility: vi.fn(),
    showPeak: vi.fn(),
    showShadowOutline: vi.fn(),
    clearShadowOutline: vi.fn(),
    clearGlobalVisibility: vi.fn(),
    clearPath: vi.fn(),
    fitPath: vi.fn(),
    fitGlobalVisibility: vi.fn(),
    setLocation: vi.fn(),
    setLayerVisibility: vi.fn(),
  };
}

describe("eclipse renderer coordinator", () => {
  it("broadcasts identical calculated objects to every renderer", () => {
    const renderers = [
      fakeRenderer("mercator"),
      fakeRenderer("globe"),
      fakeRenderer("world"),
    ];
    const coordinator = new EclipseRendererCoordinator(renderers);
    const path = Object.freeze({ marker: "path" }) as unknown as EclipseScene;
    const visibility = Object.freeze({
      marker: "visibility",
    }) as unknown as EclipseScene;
    const shadow = Object.freeze({ marker: "shadow" }) as unknown as
      EclipseScene;

    coordinator.showPath(path);
    coordinator.showGlobalVisibility(visibility, -25);
    coordinator.showShadowOutline(shadow);

    for (const renderer of renderers) {
      expect(renderer.showPath).toHaveBeenCalledWith(path);
      expect(renderer.showGlobalVisibility).toHaveBeenCalledWith(
        visibility,
        -25,
      );
      expect(renderer.showShadowOutline).toHaveBeenCalledWith(shadow);
    }
  });

  it("turns one renderer click into one callback and synchronized markers", () => {
    const renderers = [
      fakeRenderer("mercator"),
      fakeRenderer("globe"),
      fakeRenderer("world"),
    ];
    const coordinator = new EclipseRendererCoordinator(renderers);
    const observer: Observer = {
      latitudeDeg: 65.2,
      longitudeDeg: -25.3,
      elevationMeters: 0,
    };
    const onLocation = vi.fn();
    coordinator.onLocation = onLocation;

    renderers[1]!.onLocation?.(observer);

    expect(onLocation).toHaveBeenCalledOnce();
    expect(onLocation).toHaveBeenCalledWith(observer);
    for (const renderer of renderers) {
      expect(renderer.setLocation).toHaveBeenCalledOnce();
      expect(renderer.setLocation).toHaveBeenCalledWith(observer);
    }
  });

  it("initializes and updates one shared layer state", () => {
    const renderers = [
      fakeRenderer("mercator"),
      fakeRenderer("globe"),
      fakeRenderer("world"),
    ];
    const coordinator = new EclipseRendererCoordinator(renderers);
    const visibility: EclipseLayerVisibility = {
      ...DEFAULT_LAYER_VISIBILITY,
      centralPath: false,
      contacts: false,
    };

    for (const renderer of renderers) {
      expect(renderer.setLayerVisibility).toHaveBeenCalledWith(
        DEFAULT_LAYER_VISIBILITY,
      );
    }
    coordinator.setLayerVisibility(visibility);
    for (const renderer of renderers) {
      expect(renderer.setLayerVisibility).toHaveBeenLastCalledWith(
        visibility,
      );
    }
  });
});
