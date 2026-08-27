import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  greatCircleDistanceKm,
  LocationPinStore,
  locationPinAngularHeightDegrees,
  parseLocationPin,
  worldHeightForAngularSize,
  type LocationPin,
} from "../apps/pas-de-geant/src/location-pin.js";
import {
  locationPinHudDirection,
  locationPinIsAboveHorizon,
  locationPinNormalizedAnchor,
} from "../apps/pas-de-geant/src/location-pin-layer.js";

const florence: LocationPin = {
  pinId: "florence",
  label: "Florence",
  latitudeDegrees: 43.7696,
  longitudeDegrees: 11.2558,
};

describe("Pas de Géant location pins", () => {
  it("measures Pisa to Florence and gives the farther pin a smaller angular size", () => {
    const distanceKm = greatCircleDistanceKm(
      43.7228,
      10.4017,
      florence.latitudeDegrees,
      florence.longitudeDegrees,
    );
    expect(distanceKm).toBeGreaterThan(68);
    expect(distanceKm).toBeLessThan(70);
    expect(locationPinAngularHeightDegrees(distanceKm)).toBeCloseTo(1.835, 2);
    expect(locationPinAngularHeightDegrees(500)).toBeLessThan(
      locationPinAngularHeightDegrees(distanceKm),
    );
    expect(locationPinAngularHeightDegrees(0)).toBe(2.5);
  });

  it("converts angular size into camera-distance-aware world height", () => {
    const near = worldHeightForAngularSize(2, 1.8);
    const far = worldHeightForAngularSize(20, 1.8);
    expect(far).toBeCloseTo(near * 10);
    expect(() => worldHeightForAngularSize(2, 0)).toThrow(/angular/i);
  });

  it("validates pins and maintains independent guidance for multiple locations", () => {
    const store = new LocationPinStore();
    expect(store.set(florence)).toEqual({
      pins: [florence],
      guidedPinIds: [],
    });
    const pisa = parseLocationPin({
      pinId: "pisa",
      label: "  Pisa  ",
      latitudeDegrees: 43.7228,
      longitudeDegrees: 10.4017,
    });
    expect(pisa.label).toBe("Pisa");
    store.set(pisa);
    store.setGuidance("florence", true);
    store.setGuidance("pisa", true);
    expect(store.snapshot().guidedPinIds).toEqual(["florence", "pisa"]);
    store.setVisibility("florence", false);
    expect(store.snapshot()).toEqual({ pins: [pisa], guidedPinIds: ["pisa"] });
    expect(store.catalogSnapshot()).toEqual({
      pins: [florence, pisa],
      visiblePinIds: ["pisa"],
      guidedPinIds: ["pisa"],
    });
    store.rename("florence", "Stop 1");
    expect(store.catalogSnapshot()).toMatchObject({
      pins: [{ ...florence, label: "Stop 1" }, pisa],
      visiblePinIds: ["pisa"],
      guidedPinIds: ["pisa"],
    });
    store.setVisibility("florence", true);
    store.setGuidance("florence", false);
    expect(store.snapshot().guidedPinIds).toEqual(["pisa"]);
    store.remove("florence");
    expect(store.snapshot()).toEqual({ pins: [pisa], guidedPinIds: ["pisa"] });
    expect(() => store.setGuidance("missing", true)).toThrow(/does not exist/i);
    expect(store.clear()).toEqual({ pins: [], guidedPinIds: [] });
  });

  it("places pins on the scaled terrain anchor and classifies the globe horizon", () => {
    const seaLevel = locationPinNormalizedAnchor(florence, 0, 1);
    const elevated = locationPinNormalizedAnchor(florence, 1_000, 2);
    expect(elevated.length()).toBeGreaterThan(seaLevel.length());

    const normal = seaLevel.clone().normalize();
    expect(locationPinIsAboveHorizon(
      normal.clone().multiplyScalar(1.2),
      seaLevel,
      normal,
    )).toBe(true);
    expect(locationPinIsAboveHorizon(
      normal.clone().multiplyScalar(-1.2),
      seaLevel,
      normal,
    )).toBe(false);
    expect(seaLevel).toBeInstanceOf(Vector3);
  });

  it("keeps target elevation downward while guiding toward a pin behind the user", () => {
    const behindAndBelow = locationPinHudDirection(new Vector3(0, -1, 1));
    expect(behindAndBelow.x).toBe(1);
    expect(behindAndBelow.y).toBeLessThan(0);

    const behindRightAndBelow = locationPinHudDirection(new Vector3(1, -1, 1));
    expect(behindRightAndBelow.x).toBeGreaterThan(0);
    expect(behindRightAndBelow.y).toBeLessThan(0);

    const behindAndAbove = locationPinHudDirection(new Vector3(0, 1, 1));
    expect(behindAndAbove.y).toBeGreaterThan(0);
  });

  it("rejects unsafe pin input without imposing a label-length ceiling", () => {
    expect(parseLocationPin({
      ...florence,
      label: "F".repeat(10_000),
    }).label).toHaveLength(10_000);
    expect(() => parseLocationPin({ ...florence, label: " " })).toThrow(/label/i);
    expect(() => parseLocationPin({
      ...florence,
      latitudeDegrees: 91,
    })).toThrow(/latitude/i);
  });
});
