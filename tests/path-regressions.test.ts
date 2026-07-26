import { beforeAll, describe, expect, it } from "vitest";
import {
  EclipseEngine,
  chordDistanceKm,
  haversineDistanceKm,
  toGeoJson,
  type CentralPathSurface,
  type EclipseScene,
  type EclipseSummary,
  type Position,
  type SurfacePoint,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";

const provider = new AstronomyEngineProvider();
const engine = new EclipseEngine(astronomyEngineCapabilities(provider));

function eventOn(date: string): EclipseSummary {
  return provider.searchGlobalEclipses({
    startUtc: `${date}T00:00:00Z`,
    endUtc: `${date}T23:59:59Z`,
  })[0]!;
}

function position(point: SurfacePoint): Position {
  return [
    point.geographic.longitudeDeg,
    point.geographic.latitudeDeg,
  ];
}

function sceneFor(
  event: EclipseSummary,
  path: CentralPathSurface,
): EclipseScene {
  return {
    event: { ...event, kind: path.kind },
    provider: provider.metadata,
    centralPath: path,
    globalVisibility: {
      datum: "WGS 84",
      calculationFrame: "geocentric-earth-fixed",
      extent: [],
      horizon: [],
    },
    instantaneousShadows: [],
    contacts: [],
    timeMarkers: [],
  };
}

describe("central-path regression cases", () => {
  const paths = new Map<string, CentralPathSurface>();
  const events = new Map<string, EclipseSummary>();

  beforeAll(
    () => {
      for (const date of [
        "1973-06-30",
        "2016-03-09",
        "2027-02-06",
        "2027-08-02",
      ]) {
        const event = eventOn(date);
        events.set(date, event);
        paths.set(
          date,
          engine.calculateCentralPath(event, {
            sampleIntervalSeconds: 30,
          }),
        );
      }
    },
    30_000,
  );

  it("keeps the 1973 limits smooth through near-zenith maximum", () => {
    const path = paths.get("1973-06-30")!;
    // WGS 84 reference values from Fred Espenak's NASA GSFC path table:
    // https://eclipse.gsfc.nasa.gov/SEpath/SEpath1951/SE1973Jun30Tpath.html
    const checkpoints = [
      {
        center: [-0.4583333, 20.055] as Position,
        limits: [
          [-0.2683333, 21.1966667],
          [-0.65, 18.9133333],
        ] as [Position, Position],
      },
      {
        center: [5.6483333, 18.8333333] as Position,
        limits: [
          [5.9783333, 19.9483333],
          [5.3233333, 17.7166667],
        ] as [Position, Position],
      },
      {
        center: [12.8416667, 16.3516667] as Position,
        limits: [
          [13.3133333, 17.4066667],
          [12.38, 15.2916667],
        ] as [Position, Position],
      },
    ];
    const nearest = (points: SurfacePoint[], target: Position) =>
      Math.min(
        ...points.map((point) =>
          haversineDistanceKm(position(point), target),
        ),
      );
    for (const checkpoint of checkpoints) {
      expect(
        nearest(path.centerline.points, checkpoint.center),
      ).toBeLessThan(5);
      const positive = path.limits.positiveCrossTrack.points;
      const negative = path.limits.negativeCrossTrack.points;
      const direct =
        nearest(positive, checkpoint.limits[0]) +
        nearest(negative, checkpoint.limits[1]);
      const swapped =
        nearest(positive, checkpoint.limits[1]) +
        nearest(negative, checkpoint.limits[0]);
      expect(Math.min(direct, swapped)).toBeLessThan(10);
    }
  });

  it.each(["2027-02-06", "2027-08-02"])(
    "retains usable tracks through horizon singularities on %s",
    (date) => {
      expect(paths.get(date)!.centerline.points.length).toBeGreaterThan(50);
      expect(
        paths.get(date)!.limits.positiveCrossTrack.points.length,
      ).toBeGreaterThan(40);
      expect(
        paths.get(date)!.limits.negativeCrossTrack.points.length,
      ).toBeGreaterThan(40);
    },
  );

  it("keeps every ECEF curve physically continuous", () => {
    for (const path of paths.values()) {
      for (const points of [
        path.centerline.points,
        path.limits.positiveCrossTrack.points,
        path.limits.negativeCrossTrack.points,
        path.boundary.points,
      ]) {
        expect(
          Math.max(
            ...points.slice(1).map((point, index) =>
              chordDistanceKm(points[index]!.ecefKm, point.ecefKm),
            ),
          ),
        ).toBeLessThan(800);
      }
    }
  });

  it("serializes the 2016 path without reconnecting worlds", () => {
    const date = "2016-03-09";
    const collection = toGeoJson(
      sceneFor(events.get(date)!, paths.get(date)!),
    );
    for (const feature of collection.features) {
      const lines =
        feature.geometry.type === "LineString"
          ? [feature.geometry.coordinates]
          : feature.geometry.type === "MultiLineString"
            ? feature.geometry.coordinates
            : feature.geometry.type === "Polygon"
              ? feature.geometry.coordinates
              : feature.geometry.type === "MultiPolygon"
                ? feature.geometry.coordinates.flat()
                : [];
      for (const line of lines) {
        for (let index = 1; index < line.length; index += 1) {
          expect(
            Math.abs(line[index]![0] - line[index - 1]![0]),
          ).toBeLessThanOrEqual(180);
        }
      }
    }
  });

  it("does not swap signed branches on historical polar tracks", () => {
    const cases = [
      ["1815-07-06", "north"],
      ["1917-12-14", "south"],
      ["2923-06-05", "north"],
    ] as const;
    for (const [date, hemisphere] of cases) {
      const event = eventOn(date);
      const path = engine.calculateCentralPath(event, {
        sampleIntervalSeconds: 60,
      });
      for (const curve of [
        path.limits.positiveCrossTrack,
        path.limits.negativeCrossTrack,
      ]) {
        expect(
          Math.max(
            ...curve.points.slice(1).map((point, index) =>
              chordDistanceKm(
                curve.points[index]!.ecefKm,
                point.ecefKm,
              ),
            ),
          ),
        ).toBeLessThan(800);
      }
      const extreme = hemisphere === "north"
        ? Math.max(
            ...path.centerline.points.map(
              (point) => point.geographic.latitudeDeg,
            ),
          )
        : Math.min(
            ...path.centerline.points.map(
              (point) => point.geographic.latitudeDeg,
            ),
          );
      expect(
        hemisphere === "north" ? extreme : -extreme,
      ).toBeGreaterThan(70);
    }
  }, 30_000);
});
