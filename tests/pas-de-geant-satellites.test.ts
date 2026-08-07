import { describe, expect, it, vi } from "vitest";
import { InstancedMesh, Matrix4, Vector3 } from "three";
import {
  createSatelliteGroupLoader,
} from "../apps/pas-de-geant/src/satellite-feed-server.js";
import {
  parseSatelliteGroupPayload,
} from "../apps/pas-de-geant/src/satellite-feed.js";
import {
  parseSatelliteVisibilityArguments,
} from "../apps/pas-de-geant/src/satellite-groups.js";
import {
  SatelliteLayer,
  satelliteNormalizedPosition,
} from "../apps/pas-de-geant/src/satellite-layer.js";
import { EARTH_MEAN_RADIUS_KM } from "../apps/pas-de-geant/src/planet-state.js";

type OmmSatellite = Parameters<SatelliteLayer["setSatellites"]>[1][number];

function omm(
  catalogId: number,
  name = `SAT ${catalogId}`,
): OmmSatellite {
  return {
    OBJECT_NAME: name,
    OBJECT_ID: "1998-067A",
    EPOCH: "2026-08-07T00:00:00.000000",
    MEAN_MOTION: 15.5,
    ECCENTRICITY: 0.0001,
    INCLINATION: 51.6,
    RA_OF_ASC_NODE: 120,
    ARG_OF_PERICENTER: 80,
    MEAN_ANOMALY: 20,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: "U",
    NORAD_CAT_ID: catalogId,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 1,
    BSTAR: 0.0001,
    MEAN_MOTION_DOT: 0,
    MEAN_MOTION_DDOT: 0,
  };
}

describe("Pas de Géant satellite layers", () => {
  it("maps each voice group independently", () => {
    expect(parseSatelliteVisibilityArguments({
      group: "brightest",
      enabled: true,
    })).toEqual({ group: "visual", enabled: true });
    expect(parseSatelliteVisibilityArguments({
      group: "space_stations",
      enabled: false,
    })).toEqual({ group: "stations", enabled: false });
    expect(parseSatelliteVisibilityArguments({
      group: "science_education",
      enabled: true,
    })).toEqual({ group: "science-education", enabled: true });
    expect(() => parseSatelliteVisibilityArguments({
      group: "all",
      enabled: true,
    })).toThrow("Satellite group");
  });

  it("applies the same radial multiplier to orbital altitude", () => {
    const surface = satelliteNormalizedPosition({
      latitude: 0,
      longitude: 0,
      height: 400,
    }, 0);
    const trueScale = satelliteNormalizedPosition({
      latitude: 0,
      longitude: 0,
      height: 400,
    }, 1);
    const exaggerated = satelliteNormalizedPosition({
      latitude: 0,
      longitude: 0,
      height: 400,
    }, 3);

    expect(trueScale.length() - surface.length()).toBeCloseTo(
      400 / EARTH_MEAN_RADIUS_KM,
      10,
    );
    expect(exaggerated.length() - surface.length()).toBeCloseTo(
      1_200 / EARTH_MEAN_RADIUS_KM,
      10,
    );
  });

  it("propagates OMM elements into a visible Earth-fixed marker", () => {
    const layer = new SatelliteLayer();
    expect(layer.setSatellites("stations", [omm(25544, "ISS")])).toBe(1);
    layer.setGroupVisible("stations", true);
    layer.update(Date.parse("2026-08-07T00:05:00Z"), 64, 1);

    const mesh = layer.group.getObjectByName(
      "satellites-stations",
    ) as InstancedMesh;
    expect(mesh.count).toBe(1);
    const matrix = new Matrix4();
    mesh.getMatrixAt(0, matrix);
    const position = new Vector3().setFromMatrixPosition(matrix);
    expect(position.length()).toBeGreaterThan(1);
  });

  it("merges science and education while caching each upstream catalog", async () => {
    let nowMs = 1_000;
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const group = new URL(String(input)).searchParams.get("GROUP");
      return new Response(JSON.stringify(
        group === "SCIENCE"
          ? [omm(1, "SCIENCE ONE"), omm(2, "SHARED")]
          : [omm(2, "SHARED"), omm(3, "EDUCATION THREE")],
      ));
    });
    const load = createSatelliteGroupLoader(
      fetchImplementation,
      () => nowMs,
    );

    const first = await load("science-education");
    const second = await load("science-education");
    expect(first.satellites.map(({ NORAD_CAT_ID }) => NORAD_CAT_ID)).toEqual([
      1,
      2,
      3,
    ]);
    expect(second).toEqual(first);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);

    nowMs += 2 * 60 * 60 * 1_000 + 1;
    await load("science-education");
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });

  it("filters malformed orbital elements from the local feed", () => {
    const payload = parseSatelliteGroupPayload({
      group: "stations",
      fetchedAtMs: 123,
      satellites: [omm(25544, "ISS"), { OBJECT_NAME: "BROKEN" }],
    }, "stations");
    expect(payload.satellites).toHaveLength(1);
    expect(payload.satellites[0]?.OBJECT_NAME).toBe("ISS");
  });
});
