import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "@found-in-space/touch-os";
import { createGeantNavigation, formatScaleRatio, GEANT_ACTIONS, resolveGeantConfiguration } from "@found-in-space/pas-de-geant";
import { detectLocation } from "../integration/src/location.js";
import { panelAction, standardPanelRoot } from "../integration/src/standard-panel.js";

describe("standard experience location detection", () => {
  it("uses device coordinates without requesting an IP location", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const geolocation = { getCurrentPosition: vi.fn((success: PositionCallback) => success({ coords: { latitude: 52.1, longitude: 4.3 } } as GeolocationPosition)) };
    expect(await detectLocation({ geolocation, fetcher })).toEqual({ latitudeDegrees: 52.1, longitudeDegrees: 4.3, source: "device" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to an approximate IP location after permission denial", async () => {
    const geolocation = { getCurrentPosition: vi.fn((_success: PositionCallback, failure?: PositionErrorCallback | null) => failure?.({ code: 1 } as GeolocationPositionError)) };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ latitude: "51.5", longitude: "-0.1" }));
    expect(await detectLocation({ geolocation, fetcher })).toEqual({ latitudeDegrees: 51.5, longitudeDegrees: -0.1, source: "ip" });
  });

  it.each([{ latitude: "", longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 45, longitude: 181 }, {}])(
    "leaves the selected location available when the IP result is invalid: %j", async value => {
      expect(await detectLocation({ geolocation: null, fetcher: async () => Response.json(value) })).toBeUndefined();
    });

  it("leaves the selected location available when the location service is unavailable", async () => {
    expect(await detectLocation({ geolocation: null, fetcher: async () => { throw new Error("offline"); } })).toBeUndefined();
  });

  it("cancels a pending device request on disposal without starting IP detection", async () => {
    const abort = new AbortController(), fetcher = vi.fn<typeof fetch>();
    const pending = detectLocation({ geolocation: { getCurrentPosition() {} }, fetcher, signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("TouchOS standard experience", () => {
  it("moves the public Earth location through the map and redraws its marker", () => {
    const navigation = createGeantNavigation(resolveGeantConfiguration());
    const runtime = createRuntime({ root: standardPanelRoot(navigation.getSnapshot()), surface: { width: 480, height: 480 } });
    runtime.render();
    const bounds = runtime.getBounds("earth-map")!;
    const point = { surfaceX: bounds.x + bounds.width * 0.75, surfaceY: bounds.y + bounds.height * 0.25, pointerId: "mouse" };
    runtime.dispatchInput({ ...point, type: "pointer-down", timestamp: 1 });
    runtime.dispatchInput({ ...point, type: "pointer-up", timestamp: 2 });
    const action = runtime.takeOutputs().map(panelAction).find(value => value?.id === GEANT_ACTIONS.setLocation)!;
    navigation.dispatch(action.id, action.payload);
    expect(navigation.getSnapshot().locations.earth).toMatchObject({ latitudeDegrees: 45, longitudeDegrees: 90, altitudeM: 0 });
    runtime.setRoot(standardPanelRoot(navigation.getSnapshot()));
    const marker = runtime.render().commands.find(command => command.componentId === "earth-map" && command.type === "circle");
    expect(marker).toMatchObject({ cx: point.surfaceX, cy: point.surfaceY });
    runtime.dispose(); navigation.dispose();
  });

  it("routes the logarithmic slider through the public scale action and reflects external changes", () => {
    const navigation = createGeantNavigation(resolveGeantConfiguration());
    const runtime = createRuntime({ root: standardPanelRoot(navigation.getSnapshot()), surface: { width: 480, height: 480 } });
    const track = runtime.render().commands.find(command => command.role === "slider-track");
    if (track?.type !== "rect") throw new Error("Scale slider has no track.");
    const point = { surfaceX: track.rect.x + track.rect.width / 2, surfaceY: track.rect.y + track.rect.height / 2, pointerId: "mouse" };
    runtime.dispatchInput({ ...point, type: "pointer-down", timestamp: 1 });
    runtime.dispatchInput({ ...point, type: "pointer-up", timestamp: 2 });
    const action = runtime.takeOutputs().map(panelAction).find(value => value?.id === GEANT_ACTIONS.setScale)!;
    navigation.dispatch(action.id, action.payload);
    expect(navigation.scaleDenominator).toBeCloseTo(10 ** 4.5);
    navigation.dispatch(GEANT_ACTIONS.setScale, { scaleDenominator: 1e10 });
    runtime.setRoot(standardPanelRoot(navigation.getSnapshot()));
    expect(runtime.render().commands).toContainEqual(expect.objectContaining({ role: "slider-value", text: formatScaleRatio(navigation.scaleDenominator) }));
    runtime.dispose(); navigation.dispose();
  });
});
