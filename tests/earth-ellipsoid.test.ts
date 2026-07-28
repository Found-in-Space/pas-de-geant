import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  AU_KM,
  EARTH_MEAN_RADIUS_KM,
  EclipseEngine,
  WGS84_A_KM,
  WGS84_B_KM,
  coneResidualKm,
  magnitude,
  normalize,
  scale,
  subtract,
  type CartesianVector,
  type ShadowGeometryState,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";
import {
  WGS84_DISPLAY_EQUATORIAL_RADIUS,
  WGS84_DISPLAY_POLAR_RADIUS,
  createGeodeticEllipsoidGeometry,
  displayToEcefKm,
  ecefKmToDisplay,
  geodeticDisplayPosition,
  projectDirectionToWgs84Display,
  wgs84DisplayEquation,
  wgs84DisplayNormal,
} from "../apps/visualizer/src/earth-ellipsoid.js";

function expectVectorClose(
  actual: CartesianVector,
  expected: CartesianVector,
  digits = 9
): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

describe("Spacefarer WGS 84 display geometry", () => {
  it("round-trips ECEF kilometres without radial normalization", () => {
    const source = { x: 1234.5, y: -4567.8, z: 3456.7 };
    expectVectorClose(displayToEcefKm(ecefKmToDisplay(source)), source, 10);
  });

  it("uses exact WGS 84 equatorial and polar radii", () => {
    const equator = geodeticDisplayPosition(0, 0);
    const northPole = geodeticDisplayPosition(Math.PI / 2, 0);

    expect(equator.x).toBeCloseTo(WGS84_A_KM / EARTH_MEAN_RADIUS_KM, 12);
    expect(equator.y).toBeCloseTo(0, 12);
    expect(northPole.y).toBeCloseTo(WGS84_B_KM / EARTH_MEAN_RADIUS_KM, 12);
    expect(wgs84DisplayEquation(equator)).toBeCloseTo(1, 12);
    expect(wgs84DisplayEquation(northPole)).toBeCloseTo(1, 12);
  });

  it("builds geodetic UVs and ellipsoid-gradient normals", () => {
    const longitudeSegments = 16;
    const latitudeSegments = 8;
    const geometry = createGeodeticEllipsoidGeometry(
      longitudeSegments,
      latitudeSegments
    );
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    const uvs = geometry.getAttribute("uv");
    const equatorPrimeMeridian =
      (latitudeSegments / 2) * (longitudeSegments + 1) + longitudeSegments / 2;

    expect(uvs.getX(equatorPrimeMeridian)).toBeCloseTo(0.5, 12);
    expect(uvs.getY(equatorPrimeMeridian)).toBeCloseTo(0.5, 12);
    expect(positions.getX(equatorPrimeMeridian)).toBeCloseTo(
      WGS84_DISPLAY_EQUATORIAL_RADIUS,
      6
    );

    for (let index = 0; index < positions.count; index += 1) {
      const position = new Vector3(
        positions.getX(index),
        positions.getY(index),
        positions.getZ(index)
      );
      const normal = new Vector3(
        normals.getX(index),
        normals.getY(index),
        normals.getZ(index)
      );
      expect(
        Math.abs(wgs84DisplayEquation(position) - 1) * EARTH_MEAN_RADIUS_KM
      ).toBeLessThan(0.002);
      expect(normal.dot(wgs84DisplayNormal(position))).toBeGreaterThan(
        0.999999
      );
    }
  });

  it("places the atmosphere at geodetic altitude", () => {
    const latitude = Math.PI / 4;
    const longitude = Math.PI / 6;
    const surface = geodeticDisplayPosition(latitude, longitude);
    const atmosphere = geodeticDisplayPosition(latitude, longitude, 100);
    expect(atmosphere.distanceTo(surface) * EARTH_MEAN_RADIUS_KM).toBeCloseTo(
      100,
      8
    );
  });

  it("projects arbitrary directions back to WGS 84", () => {
    const projected = projectDirectionToWgs84Display(new Vector3(2, 3, -4));
    expect(wgs84DisplayEquation(projected)).toBeCloseTo(1, 12);
    expect(
      projected.clone().normalize().dot(new Vector3(2, 3, -4).normalize())
    ).toBeCloseTo(1, 12);
  });
});

describe("Spacefarer physical shadow alignment", () => {
  it("keeps peak and grazing outlines on WGS 84 and their cone arcs", () => {
    const provider = new AstronomyEngineProvider();
    const engine = new EclipseEngine(astronomyEngineCapabilities(provider));
    const event = engine
      .events({
        startUtc: "2026-08-12T00:00:00Z",
        endUtc: "2026-08-13T00:00:00Z",
      })
      .find((candidate) => candidate.id === "solar-2026-08-12-total");
    expect(event).toBeDefined();

    for (const atUtc of [event!.peakUtc, "2026-08-12T17:00:30Z"]) {
      const shadow = engine.calculateInstantaneousShadow(event!, atUtc, {
        angularIntervalDegrees: 3,
      });
      const kilometres = (body: "sun" | "moon") =>
        scale(
          provider.stateVector(body, shadow.atUtc, "geocentric-earth-fixed")
            .positionAu,
          AU_KM
        );
      const sunEcefKm = kilometres("sun");
      const moonEcefKm = kilometres("moon");
      const state: ShadowGeometryState = {
        atUtc: shadow.atUtc,
        sunEcefKm,
        moonEcefKm,
        direction: normalize(subtract(moonEcefKm, sunEcefKm)),
        sunDistanceKm: magnitude(sunEcefKm),
        sunMoonDistanceKm: magnitude(subtract(moonEcefKm, sunEcefKm)),
      };
      const regions = [
        { cone: "penumbra" as const, region: shadow.penumbra },
        ...(shadow.central
          ? [{ cone: "central" as const, region: shadow.central.region }]
          : []),
      ];

      for (const { cone, region } of regions) {
        for (const ring of region.rings) {
          for (const point of ring.points) {
            const displayed = ecefKmToDisplay(point.ecefKm);
            expect(
              Math.abs(wgs84DisplayEquation(displayed) - 1) *
                EARTH_MEAN_RADIUS_KM
            ).toBeLessThan(0.001);
          }
          for (const segment of ring.segments) {
            if (segment.kind !== "cone") continue;
            for (const point of segment.curve.points) {
              const restored = displayToEcefKm(ecefKmToDisplay(point.ecefKm));
              expect(
                Math.abs(coneResidualKm(state, restored, cone))
              ).toBeLessThan(0.001);
            }
          }
        }
      }
    }
  });
});
