import { beforeAll, describe, expect, it } from "vitest";
import {
  EclipseEngine,
  classifyCentralEclipse,
  ellipsoidResidualKm,
  haversineDistanceKm,
  toGeoJson,
  type CentralPathSurface,
  type EclipseScene,
  type EclipseSummary,
  type Position,
  type SurfacePoint,
  type TimedSurfacePoint,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";
import { clipForWebMercator } from "../apps/visualizer/src/web-mercator.js";

const provider = new AstronomyEngineProvider();
const engine = new EclipseEngine(astronomyEngineCapabilities(provider));
let event: EclipseSummary;
let path: CentralPathSurface;
let scene: EclipseScene;

// WGS 84 reference values from Fred Espenak's NASA GSFC path table:
// https://eclipse.gsfc.nasa.gov/SEpath/SEpath2001/SE2026Aug12Tpath.html
const checkpoints = {
  "17:40": {
    center: [-26.41, 68.2466667] as Position,
    limits: [
      [-22.9483333, 68.7266667],
      [-29.6316667, 67.7233333],
    ] as [Position, Position],
    durationSeconds: 137.9,
    altitudeDeg: 26,
    azimuthDeg: 244,
    widthKm: 289,
  },
  "18:00": {
    center: [-21.5733333, 58.2716667] as Position,
    limits: [
      [-18.9433333, 58.56],
      [-24.0766667, 57.945],
    ] as [Position, Position],
    durationSeconds: 135.3,
    altitudeDeg: 24,
    azimuthDeg: 258,
    widthKm: 307,
  },
  "18:20": {
    center: [-13.0483333, 48.2116667] as Position,
    limits: [
      [-10.2666667, 48.2083333],
      [-15.6383333, 48.1466667],
    ] as [Position, Position],
    durationSeconds: 121.2,
    altitudeDeg: 17,
    azimuthDeg: 273,
    widthKm: 319,
  },
  "18:30": {
    center: [-3.185, 41.8166667] as Position,
    limits: [
      [3.295, 40.665],
      [-7.2366667, 42.2633333],
    ] as [Position, Position],
    durationSeconds: 104.6,
    altitudeDeg: 8,
    azimuthDeg: 283,
    widthKm: 294,
  },
} as const;

function position(point: SurfacePoint): Position {
  return [
    point.geographic.longitudeDeg,
    point.geographic.latitudeDeg,
  ];
}

function nearest(
  points: SurfacePoint[],
  target: Position,
): number {
  return Math.min(
    ...points.map((point) =>
      haversineDistanceKm(position(point), target),
    ),
  );
}

function nearestAt(
  points: TimedSurfacePoint[],
  atUtc: string,
): TimedSurfacePoint {
  const timeMs = Date.parse(atUtc);
  return points.reduce((best, point) =>
    Math.abs(Date.parse(point.atUtc) - timeMs) <
    Math.abs(Date.parse(best.atUtc) - timeMs)
      ? point
      : best,
  );
}

beforeAll(() => {
  event = provider.searchGlobalEclipses({
    startUtc: "2026-08-01T00:00:00Z",
    endUtc: "2026-09-01T00:00:00Z",
  })[0]!;
  path = engine.calculateCentralPath(event);
  scene = {
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
    timeMarkers: engine.calculateTimeMarkers(event, path),
  };
}, 30_000);

describe("2026 planning-grade ECEF path", () => {
  it("builds the complete physical central surface", () => {
    expect(path.kind).toBe("total");
    expect(path.centralBeginUtc).toMatch(/^2026-08-12T16:59:5/);
    expect(path.centralEndUtc).toMatch(/^2026-08-12T18:32:0/);
    expect(path.centerline.points.length).toBeGreaterThan(1100);
    expect(path.limits.positiveCrossTrack.points.length).toBeGreaterThan(
      1000,
    );
    expect(path.limits.negativeCrossTrack.points.length).toBeGreaterThan(
      1000,
    );
  });

  it("matches interior NASA WGS 84 checkpoints within 25 km", () => {
    const positive = path.limits.positiveCrossTrack.points;
    const negative = path.limits.negativeCrossTrack.points;
    for (const checkpoint of Object.values(checkpoints)) {
      expect(nearest(path.centerline.points, checkpoint.center)).toBeLessThan(
        25,
      );
      const physicalLimits = [positive, negative];
      const direct =
        nearest(physicalLimits[0]!, checkpoint.limits[0]) +
        nearest(physicalLimits[1]!, checkpoint.limits[1]);
      const swapped =
        nearest(physicalLimits[0]!, checkpoint.limits[1]) +
        nearest(physicalLimits[1]!, checkpoint.limits[0]);
      expect(Math.min(direct, swapped)).toBeLessThan(50);
    }
  });

  it("keeps signed branch identity through the north-pole turn", () => {
    const positive = path.limits.positiveCrossTrack.points;
    const negative = path.limits.negativeCrossTrack.points;
    for (const time of ["17:02", "17:04", "17:06", "17:08", "17:10"]) {
      const utc = `2026-08-12T${time}:00Z`;
      const first = nearestAt(positive, utc);
      const second = nearestAt(negative, utc);
      expect(Math.abs(Date.parse(first.atUtc) - Date.parse(utc))).toBeLessThan(
        10_001,
      );
      expect(Math.abs(Date.parse(second.atUtc) - Date.parse(utc))).toBeLessThan(
        10_001,
      );
      expect(haversineDistanceKm(position(first), position(second))).toBeGreaterThan(
        50,
      );
    }
  });

  it("returns exact WGS 84 ECEF points", () => {
    const points = [
      ...path.centerline.points,
      ...path.limits.positiveCrossTrack.points,
      ...path.limits.negativeCrossTrack.points,
      ...path.boundary.points,
    ];
    expect(
      Math.max(
        ...points.map((point) =>
          Math.abs(ellipsoidResidualKm(point.ecefKm)),
        ),
      ),
    ).toBeLessThan(1e-3);
  });

  it("closes the physical boundary through explicit horizon caps", () => {
    expect(path.boundary.closed).toBe(true);
    expect(
      haversineDistanceKm(
        position(path.boundary.points[0]!),
        position(path.boundary.points.at(-1)!),
      ),
    ).toBeLessThan(1e-6);
    for (const cap of [path.startCap, path.endCap]) {
      expect(cap.edges[0].points.length).toBeGreaterThan(2);
      expect(cap.edges[1].points.length).toBeGreaterThan(2);
    }
  });

  it("serializes signed limits without leaking physical GeoJSON state", () => {
    const collection = toGeoJson(scene);
    expect(collection.metadata.schemaVersion).toBe("2.0.0");
    expect(
      collection.features.map(
        (feature) => feature.properties.feature_type,
      ),
    ).toEqual(
      expect.arrayContaining([
        "central_path",
        "centerline",
        "positive_cross_track_limit",
        "negative_cross_track_limit",
        "time_marker",
      ]),
    );
    expect("features" in path).toBe(false);
    const display = clipForWebMercator(collection);
    const latitudes = [
      ...JSON.stringify(display).matchAll(
        /\[(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g,
      ),
    ].map((match) => Math.abs(Number(match[2])));
    expect(Math.max(...latitudes)).toBeLessThanOrEqual(85.051128);
  });

  it("matches NASA centreline timing, duration, and solar angles", () => {
    for (const [time, checkpoint] of Object.entries(checkpoints)) {
      const observer = {
        latitudeDeg: checkpoint.center[1],
        longitudeDeg: checkpoint.center[0],
        elevationMeters: 0,
      };
      const local = engine.localCircumstances(event, observer)!;
      expect(
        Math.abs(
          new Date(local.peak.utc).getTime() -
            Date.parse(`2026-08-12T${time}:00Z`),
        ) / 1000,
      ).toBeLessThan(10);
      const duration =
        (new Date(local.centralEnd!.utc).getTime() -
          new Date(local.centralBegin!.utc).getTime()) /
        1000;
      expect(Math.abs(duration - checkpoint.durationSeconds)).toBeLessThan(3);
      const horizontal = provider.horizontalCoordinates(
        "sun",
        local.peak.utc,
        observer,
      );
      expect(
        Math.abs(horizontal.altitudeDeg - checkpoint.altitudeDeg),
      ).toBeLessThan(1);
      expect(
        Math.abs(horizontal.azimuthDeg - checkpoint.azimuthDeg),
      ).toBeLessThan(1);
    }
  });

  it("keeps swept surface widths in the published tolerance", () => {
    for (const [time, checkpoint] of Object.entries(checkpoints)) {
      const marker = scene.timeMarkers.find(
        (candidate) =>
          new Date(candidate.point.atUtc)
            .toISOString()
            .slice(11, 16) === time,
      );
      expect(marker).toBeDefined();
      expect(
        Math.abs(marker!.pathWidthKm - checkpoint.widthKm),
      ).toBeLessThan(25);
    }
  });

  it("detects hybrid tracks and rejects partial central paths", () => {
    const hybrid = provider.searchGlobalEclipses({
      startUtc: "2023-04-01T00:00:00Z",
      endUtc: "2023-05-01T00:00:00Z",
    })[0]!;
    expect(classifyCentralEclipse(provider, hybrid)).toBe("hybrid");
    const partial = provider
      .searchGlobalEclipses({
        startUtc: "2025-01-01T00:00:00Z",
        endUtc: "2026-01-01T00:00:00Z",
      })
      .find((candidate) => candidate.kind === "partial")!;
    expect(() => engine.calculateCentralPath(partial)).toThrow(
      /central track/,
    );
  });

  it("calculates annular tracks independently of observer services", () => {
    const annular = provider.searchGlobalEclipses({
      startUtc: "2026-02-01T00:00:00Z",
      endUtc: "2026-03-01T00:00:00Z",
    })[0]!;
    expect(
      engine.calculateCentralPath(annular, {
        sampleIntervalSeconds: 60,
      }).kind,
    ).toBe("annular");
  });

  it("uses path intervals only as maximum output spacing", () => {
    const coarseRequest = engine.calculateCentralPath(event, {
      sampleIntervalSeconds: 300,
    });
    expect(coarseRequest.centerline.points.length).toBe(
      path.centerline.points.length,
    );
    expect(
      coarseRequest.limits.positiveCrossTrack.points.length,
    ).toBe(path.limits.positiveCrossTrack.points.length);
    expect(
      Math.max(
        ...path.centerline.points.map((point, index) =>
          Math.hypot(
            point.ecefKm.x -
              coarseRequest.centerline.points[index]!.ecefKm.x,
            point.ecefKm.y -
              coarseRequest.centerline.points[index]!.ecefKm.y,
            point.ecefKm.z -
              coarseRequest.centerline.points[index]!.ecefKm.z,
          ),
        ),
      ),
    ).toBeLessThan(1e-9);
  });
});
