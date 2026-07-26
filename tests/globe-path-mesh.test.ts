import { beforeAll, describe, expect, it } from "vitest";
import {
  EclipseEngine,
  haversineDistanceKm,
  normalizeLongitude,
  type CentralPathSurface,
  type Position,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";
import {
  densifyGlobeLine,
  globePathTriangles,
  GLOBE_PATH_FILL_ELEVATION_METRES,
  GLOBE_PATH_MESH_STEP_KM,
  type GlobePathTriangle,
} from "../apps/visualizer/src/globe-path-mesh.js";

const provider = new AstronomyEngineProvider();
let path: CentralPathSurface;
let triangles: GlobePathTriangle[];

function vector([longitudeDeg, latitudeDeg]: Position) {
  const longitude = (longitudeDeg * Math.PI) / 180;
  const latitude = (latitudeDeg * Math.PI) / 180;
  const cosine = Math.cos(latitude);
  return {
    x: cosine * Math.cos(longitude),
    y: cosine * Math.sin(longitude),
    z: Math.sin(latitude),
  };
}

function areaSignal(triangle: GlobePathTriangle): number {
  const [first, second, third] = triangle.map(vector);
  const firstEdge = {
    x: second!.x - first!.x,
    y: second!.y - first!.y,
    z: second!.z - first!.z,
  };
  const secondEdge = {
    x: third!.x - first!.x,
    y: third!.y - first!.y,
    z: third!.z - first!.z,
  };
  return Math.hypot(
    firstEdge.y * secondEdge.z - firstEdge.z * secondEdge.y,
    firstEdge.z * secondEdge.x - firstEdge.x * secondEdge.z,
    firstEdge.x * secondEdge.y - firstEdge.y * secondEdge.x,
  );
}

function pointKey([longitude, latitude]: Position): string {
  const canonicalLongitude =
    Math.abs(Math.abs(longitude) - 180) < 1e-8
      ? 180
      : normalizeLongitude(longitude);
  return `${canonicalLongitude.toFixed(8)},${latitude.toFixed(8)}`;
}

function northPolarPoint(
  [longitudeDeg, latitudeDeg]: Position,
): [number, number] {
  const longitude = (longitudeDeg * Math.PI) / 180;
  const radius = 90 - latitudeDeg;
  return [
    radius * Math.sin(longitude),
    -radius * Math.cos(longitude),
  ];
}

function signedArea(points: Array<[number, number]>): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current[0] * next[1] - next[0] * current[1];
  }
  return twiceArea / 2;
}

function pointInRing(
  point: [number, number],
  ring: Array<[number, number]>,
): boolean {
  let inside = false;
  for (
    let index = 0, previousIndex = ring.length - 1;
    index < ring.length;
    previousIndex = index, index += 1
  ) {
    const current = ring[index]!;
    const previous = ring[previousIndex]!;
    const crosses =
      current[1] > point[1] !== previous[1] > point[1] &&
      point[0] <
        ((previous[0] - current[0]) * (point[1] - current[1])) /
          (previous[1] - current[1]) +
          current[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToRing(
  point: [number, number],
  ring: Array<[number, number]>,
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index]!;
    const end = ring[(index + 1) % ring.length]!;
    const deltaX = end[0] - start[0];
    const deltaY = end[1] - start[1];
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const fraction =
      lengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((point[0] - start[0]) * deltaX +
                (point[1] - start[1]) * deltaY) /
                lengthSquared,
            ),
          );
    nearest = Math.min(
      nearest,
      Math.hypot(
        point[0] - (start[0] + fraction * deltaX),
        point[1] - (start[1] + fraction * deltaY),
      ),
    );
  }
  return nearest;
}

beforeAll(() => {
  const event = provider.searchGlobalEclipses({
    startUtc: "2026-08-01T00:00:00Z",
    endUtc: "2026-09-01T00:00:00Z",
  })[0]!;
  path = new EclipseEngine(
    astronomyEngineCapabilities(provider),
  ).calculateCentralPath(event);
  triangles = globePathTriangles(path);
});

describe("structured globe path mesh", () => {
  it("densifies physical globe lines without changing their route", () => {
    const source = path.limits.negativeCrossTrack.points.map(
      (sample) => [
        sample.geographic.longitudeDeg,
        sample.geographic.latitudeDeg,
      ] as Position,
    );
    const dense = densifyGlobeLine(source);
    const denseKeys = new Set(dense.map(pointKey));
    for (const point of source) {
      expect(denseKeys.has(pointKey(point))).toBe(true);
    }
    for (let index = 1; index < dense.length; index += 1) {
      expect(
        haversineDistanceKm(dense[index - 1]!, dense[index]!),
      ).toBeLessThanOrEqual(GLOBE_PATH_MESH_STEP_KM + 1e-6);
    }
  });

  it("uses only bounded, non-degenerate local surface facets", () => {
    expect(triangles.length).toBeGreaterThan(500);
    expect(triangles.length).toBeLessThan(100_000);
    let maximumEdgeKm = 0;
    for (const triangle of triangles) {
      expect(areaSignal(triangle)).toBeGreaterThan(1e-13);
      for (let index = 0; index < 3; index += 1) {
        const edgeKm = haversineDistanceKm(
          triangle[index]!,
          triangle[(index + 1) % 3]!,
        );
        expect(Number.isFinite(edgeKm)).toBe(true);
        maximumEdgeKm = Math.max(maximumEdgeKm, edgeKm);
      }
    }
    expect(maximumEdgeKm).toBeLessThanOrEqual(
      2 * GLOBE_PATH_MESH_STEP_KM + 1e-6,
    );

    const displayRadiusKm = 6_371;
    const maximumAngle = maximumEdgeKm / displayRadiusKm;
    const maximumSagittaKm =
      displayRadiusKm * (1 - Math.cos(maximumAngle / 2));
    expect(GLOBE_PATH_FILL_ELEVATION_METRES / 1_000).toBeGreaterThan(
      4 * maximumSagittaKm,
    );
  });

  it("contains every calculated physical boundary vertex", () => {
    const meshVertices = new Set(
      triangles.flat().map(pointKey),
    );
    for (const boundaryPoint of path.boundary.points.slice(0, -1)) {
      expect(meshVertices.has(pointKey([
        boundaryPoint.geographic.longitudeDeg,
        boundaryPoint.geographic.latitudeDeg,
      ]))).toBe(true);
    }
  });

  it("covers the physical polar polygon without folds or remote facets", () => {
    const physicalRing = path.boundary.points
      .slice(0, -1)
      .map((point) =>
        northPolarPoint([
          point.geographic.longitudeDeg,
          point.geographic.latitudeDeg,
        ]),
      );
    const physicalArea = Math.abs(signedArea(physicalRing));
    let meshArea = 0;
    let maximumExteriorDistanceDegrees = 0;
    for (const triangle of triangles) {
      const projected = triangle.map(northPolarPoint) as [
        [number, number],
        [number, number],
        [number, number],
      ];
      meshArea += Math.abs(signedArea(projected));
      const centroid: [number, number] = [
        (projected[0][0] + projected[1][0] + projected[2][0]) / 3,
        (projected[0][1] + projected[1][1] + projected[2][1]) / 3,
      ];
      if (!pointInRing(centroid, physicalRing)) {
        maximumExteriorDistanceDegrees = Math.max(
          maximumExteriorDistanceDegrees,
          distanceToRing(centroid, physicalRing),
        );
      }
    }
    const areaRatio = meshArea / physicalArea;
    expect(areaRatio).toBeGreaterThan(0.995);
    expect(areaRatio).toBeLessThan(1.005);
    expect(maximumExteriorDistanceDegrees).toBeLessThan(
      GLOBE_PATH_MESH_STEP_KM / 110,
    );
  });
});
