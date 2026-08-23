import { describe, expect, it } from "vitest";
import {
  bodyPositionJ2000M,
  celestialBody,
  SOLAR_SYSTEM_BODIES,
  subtractVector3d,
  vector3dLength,
} from "../apps/pas-de-geant/src/solar-system.js";
import {
  displayRadiusForRoomScale,
  relativeJ2000MetresToRender,
  roomScaleForDisplayRadius,
  spaceTravelSpeedRoomMPerSecond,
  translatedObserverJ2000M,
  withNavigationTarget,
  type WorldNavigationState,
} from "../apps/pas-de-geant/src/world-navigation.js";

describe("solar-system coordinate foundation", () => {
  it("uses one scale for every body", () => {
    const scale = roomScaleForDisplayRadius("earth", 100);
    expect(displayRadiusForRoomScale("earth", scale)).toBeCloseTo(100, 12);
    expect(displayRadiusForRoomScale("moon", scale)).toBeCloseTo(
      100 * 1_737_400 / 6_371_008.8,
      12,
    );
  });

  it("places the Moon at a physical Earth-relative distance", () => {
    const at = new Date("2026-08-12T17:42:00Z");
    const distance = vector3dLength(subtractVector3d(
      bodyPositionJ2000M("moon", at),
      bodyPositionJ2000M("earth", at),
    ));
    expect(distance).toBeGreaterThan(350_000_000);
    expect(distance).toBeLessThan(410_000_000);
  });

  it("rebases Neptune-distance coordinates before render scaling", () => {
    const origin = { x: 4.5e12, y: -2.1e12, z: 7.2e11 };
    const point = { x: origin.x + 12.5, y: origin.y - 3.25, z: origin.z + 8 };
    expect(relativeJ2000MetresToRender(
      subtractVector3d(point, origin),
      0.1,
    )).toEqual({ x: 1.25, y: 0.8, z: 0.325 });
  });

  it("round-trips head-relative 3D travel through the render-axis mapping", () => {
    const origin = { x: 4.5e12, y: -2.1e12, z: 7.2e11 };
    const moved = translatedObserverJ2000M(
      origin,
      { x: 2, y: -3, z: 4 },
      0.25,
    );
    expect(relativeJ2000MetresToRender(
      subtractVector3d(moved, origin),
      0.25,
    )).toEqual({ x: 2, y: -3, z: 4 });
  });

  it("scales space travel to remain visible without breaking toy scales", () => {
    expect(spaceTravelSpeedRoomMPerSecond("orbit", 100, 300, false)).toBe(50);
    expect(spaceTravelSpeedRoomMPerSecond("free", 100, 1_000, false)).toBe(150);
    expect(spaceTravelSpeedRoomMPerSecond("orbit", 1, 3, false)).toBe(1.35);
    expect(spaceTravelSpeedRoomMPerSecond("orbit", 100, 300, true)).toBe(200);
  });

  it("registers all major planets and rejects surface mode without a surface", () => {
    expect(SOLAR_SYSTEM_BODIES.map(({ id }) => id)).toEqual([
      "sun", "mercury", "venus", "earth", "moon", "mars",
      "jupiter", "saturn", "uranus", "neptune",
    ]);
    const state = {
      mode: "free",
      focusBodyId: "earth",
      roomMetresPerPhysicalMetre: 1 / celestialBody("earth").referenceRadiusM,
      surfaceLocations: {},
      observerSystemPositionM: { x: 0, y: 0, z: 0 },
    } satisfies WorldNavigationState;
    expect(() => withNavigationTarget(state, "jupiter", "surface")).toThrow(
      "Jupiter has no surface experience",
    );
    expect(withNavigationTarget(state, "moon", "surface").focusBodyId).toBe("moon");
  });
});
