import {
  normalizeLongitude,
  haversineDistanceKm,
  splitLineAtAntimeridian,
  splitPolygonAtAntimeridian,
  type Feature,
  type Geometry,
  type Position,
} from "@found-in-space/shadowline";
import earcut from "earcut";

function rotatePosition(
  point: Position,
  anchorLongitude: number,
): Position {
  return [
    normalizeLongitude(point[0] - anchorLongitude),
    point[1],
  ];
}

function placePosition(
  point: Position,
  anchorLongitude: number,
): Position {
  return [point[0] + anchorLongitude, point[1]];
}

const COORDINATE_EPSILON = 1e-9;
const MAX_GLOBE_TRIANGLE_EDGE_KM = 1_500;
const MAX_POLAR_TRIANGLE_EDGE_KM = 500;
const KILOMETRES_PER_DEGREE =
  (Math.PI * 6_371.0088) / 180;

function isCanonicalSeamPoint(point: Position): boolean {
  return Math.abs(Math.abs(point[0]) - 180) <= COORDINATE_EPSILON;
}

function sameCanonicalSeamPoint(
  left: Position,
  right: Position,
): boolean {
  return (
    isCanonicalSeamPoint(left) &&
    isCanonicalSeamPoint(right) &&
    Math.abs(left[1] - right[1]) <= COORDINATE_EPSILON
  );
}

function restoreCanonicalLines(lines: Position[][]): Position[][] {
  const restored: Position[][] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const active = restored[restored.length - 1];
    if (
      active &&
      sameCanonicalSeamPoint(active[active.length - 1]!, line[0]!)
    ) {
      // Retain one copy of the physical seam vertex. The following coordinate
      // still carries the longitude wrap needed by the new display seam.
      active.push(...line.slice(1));
    } else {
      restored.push(line.map((point) => [...point] as Position));
    }
  }
  return restored;
}

function displayLineParts(
  line: Position[],
  anchorLongitude: number,
): Position[][] {
  return splitLineAtAntimeridian(
    line.map((point) => rotatePosition(point, anchorLongitude)),
  ).map((part) =>
    part.map((point) => placePosition(point, anchorLongitude)),
  );
}

function lineGeometry(
  lines: Position[][],
  anchorLongitude: number,
): Geometry {
  const parts = restoreCanonicalLines(lines).flatMap((line) =>
    displayLineParts(line, anchorLongitude),
  );
  return parts.length === 1
    ? { type: "LineString", coordinates: parts[0]! }
    : { type: "MultiLineString", coordinates: parts };
}

function ringWithoutDuplicateEnd(ring: Position[]): Position[] {
  if (
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
  ) {
    return ring.slice(0, -1);
  }
  return ring.slice();
}

interface DirectedEdge {
  start: Position;
  end: Position;
}

function physicalPointKey(point: Position): string {
  const longitude = isCanonicalSeamPoint(point) ? 180 : point[0];
  return `${longitude.toFixed(9)},${point[1].toFixed(9)}`;
}

function directedEdgeKey(start: Position, end: Position): string {
  return `${physicalPointKey(start)}>${physicalPointKey(end)}`;
}

function restoreCanonicalPolygonRings(
  polygons: Position[][][],
): Position[][] {
  // RFC 7946 shards contain cut edges in opposite directions on the two
  // sides of the canonical antimeridian. Cancel those shared edges, then
  // stitch the surviving physical boundary back into projection-neutral
  // rings before choosing a display seam.
  const edgeBuckets = new Map<string, DirectedEdge[]>();
  for (const polygon of polygons) {
    const outerRing = polygon[0];
    if (!outerRing) continue;
    const vertices = ringWithoutDuplicateEnd(outerRing);
    for (let index = 0; index < vertices.length; index += 1) {
      const start = vertices[index]!;
      const end = vertices[(index + 1) % vertices.length]!;
      const reverseKey = directedEdgeKey(end, start);
      const reverse = edgeBuckets.get(reverseKey);
      if (reverse && reverse.length > 0) {
        reverse.pop();
        if (reverse.length === 0) edgeBuckets.delete(reverseKey);
        continue;
      }
      const key = directedEdgeKey(start, end);
      const bucket = edgeBuckets.get(key) ?? [];
      bucket.push({
        start: [...start] as Position,
        end: [...end] as Position,
      });
      edgeBuckets.set(key, bucket);
    }
  }

  const unused = [...edgeBuckets.values()].flat();
  const rings: Position[][] = [];
  while (unused.length > 0) {
    const first = unused.shift()!;
    const ring: Position[] = [first.start, first.end];
    const maximumEdges = unused.length + 1;
    let traversedEdges = 1;
    while (
      traversedEdges <= maximumEdges &&
      physicalPointKey(ring[ring.length - 1]!) !==
        physicalPointKey(ring[0]!)
    ) {
      const endKey = physicalPointKey(ring[ring.length - 1]!);
      const nextIndex = unused.findIndex(
        (edge) => physicalPointKey(edge.start) === endKey,
      );
      const reverseIndex =
        nextIndex >= 0
          ? -1
          : unused.findIndex(
              (edge) => physicalPointKey(edge.end) === endKey,
            );
      if (nextIndex >= 0) {
        const next = unused.splice(nextIndex, 1)[0]!;
        ring.push(next.end);
        traversedEdges += 1;
      } else if (reverseIndex >= 0) {
        const next = unused.splice(reverseIndex, 1)[0]!;
        ring.push(next.start);
        traversedEdges += 1;
      } else {
        break;
      }
    }
    if (
      ring.length >= 3 &&
      physicalPointKey(ring[ring.length - 1]!) ===
        physicalPointKey(ring[0]!)
    ) {
      ring.pop();
      ring.push([...ring[0]!] as Position);
      rings.push(ring);
    }
  }
  return rings;
}

function withoutSyntheticPoleClosure(ring: Position[]): Position[] {
  const poleVertices = ring.filter(
    (point) => Math.abs(Math.abs(point[1]) - 90) <= COORDINATE_EPSILON,
  );
  if (
    poleVertices.length < 2 ||
    !poleVertices.every(
      (point) =>
        Math.sign(point[1]) === Math.sign(poleVertices[0]![1]),
    )
  ) {
    return ring.map((point) => [...point] as Position);
  }
  const physical = ringWithoutDuplicateEnd(ring)
    .filter(
      (point) =>
        Math.abs(Math.abs(point[1]) - 90) > COORDINATE_EPSILON,
    )
    .map((point) => [...point] as Position);
  if (physical.length >= 3) {
    physical.push([...physical[0]!] as Position);
  }
  return physical;
}

/**
 * Reconstructs projection-neutral polygon boundaries for the 3D globe.
 *
 * Canonical GeoJSON remains split at ±180° for interchange and flat-map use.
 * Those shards can include a synthetic pole route used only to close an RFC
 * 7946 ring. A globe needs the original physical boundary instead.
 */
export function geometryForGlobe(geometry: Geometry): Geometry {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
    return geometry;
  }
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.coordinates;
  const rings = restoreCanonicalPolygonRings(polygons)
    .map(withoutSyntheticPoleClosure)
    .filter((ring) => ring.length >= 4);
  return rings.length === 1
    ? { type: "Polygon", coordinates: [rings[0]!] }
    : {
        type: "MultiPolygon",
        coordinates: rings.map((ring) => [ring]),
      };
}

function unwrapPhysicalRing(ring: Position[]): Position[] {
  const source = ringWithoutDuplicateEnd(ring);
  if (source.length === 0) return [];
  const output: Position[] = [[...source[0]!] as Position];
  for (const point of source.slice(1)) {
    let longitude = point[0];
    const previousLongitude = output[output.length - 1]![0];
    while (longitude - previousLongitude > 180) longitude -= 360;
    while (longitude - previousLongitude < -180) longitude += 360;
    output.push([longitude, point[1]]);
  }
  return output;
}

function triangleEdgeLengthKm(
  first: Position,
  second: Position,
): number {
  return haversineDistanceKm(first, second);
}

function surfaceMidpoint(
  first: Position,
  second: Position,
): Position {
  const toVector = ([longitudeDeg, latitudeDeg]: Position) => {
    const longitude = (longitudeDeg * Math.PI) / 180;
    const latitude = (latitudeDeg * Math.PI) / 180;
    return {
      x: Math.cos(latitude) * Math.cos(longitude),
      y: Math.cos(latitude) * Math.sin(longitude),
      z: Math.sin(latitude),
    };
  };
  const firstVector = toVector(first);
  const secondVector = toVector(second);
  const x = firstVector.x + secondVector.x;
  const y = firstVector.y + secondVector.y;
  const z = firstVector.z + secondVector.z;
  const length = Math.hypot(x, y, z);
  if (length < 1e-12) {
    return [
      (first[0] + second[0]) / 2,
      (first[1] + second[1]) / 2,
    ];
  }
  let longitude = (Math.atan2(y, x) * 180) / Math.PI;
  const referenceLongitude = (first[0] + second[0]) / 2;
  while (longitude - referenceLongitude > 180) longitude -= 360;
  while (longitude - referenceLongitude < -180) longitude += 360;
  return [
    longitude,
    (Math.asin(z / length) * 180) / Math.PI,
  ];
}

interface TriangulationPlane {
  coordinates: number[];
  edgeLengthKm(first: Position, second: Position): number;
  midpoint(first: Position, second: Position): Position;
  maximumEdgeKm: number;
}

function polarPlanePoint(
  [longitudeDeg, latitudeDeg]: Position,
  pole: -1 | 1,
): [number, number] {
  const longitude = (longitudeDeg * Math.PI) / 180;
  const radius = 90 - pole * latitudeDeg;
  return [
    radius * Math.sin(longitude),
    -pole * radius * Math.cos(longitude),
  ];
}

function polarPlaneMidpoint(
  first: Position,
  second: Position,
  pole: -1 | 1,
): Position {
  const firstPlane = polarPlanePoint(first, pole);
  const secondPlane = polarPlanePoint(second, pole);
  const x = (firstPlane[0] + secondPlane[0]) / 2;
  const y = (firstPlane[1] + secondPlane[1]) / 2;
  let longitude =
    (Math.atan2(x, -pole * y) * 180) / Math.PI;
  const referenceLongitude = (first[0] + second[0]) / 2;
  while (longitude - referenceLongitude > 180) longitude -= 360;
  while (longitude - referenceLongitude < -180) longitude += 360;
  return [
    longitude,
    pole * (90 - Math.hypot(x, y)),
  ];
}

function triangulationPlane(ring: Position[]): TriangulationPlane {
  const polarLatitude = ring.reduce(
    (maximum, point) =>
      Math.abs(point[1]) > Math.abs(maximum) ? point[1] : maximum,
    0,
  );
  if (Math.abs(polarLatitude) < 80) {
    return {
      coordinates: ring.flatMap((point) => point),
      edgeLengthKm: triangleEdgeLengthKm,
      midpoint: surfaceMidpoint,
      maximumEdgeKm: MAX_GLOBE_TRIANGLE_EDGE_KM,
    };
  }
  const pole = Math.sign(polarLatitude) as -1 | 1;
  return {
    coordinates: ring.flatMap((point) =>
      polarPlanePoint(point, pole),
    ),
    edgeLengthKm: (first, second) => {
      const firstPlane = polarPlanePoint(first, pole);
      const secondPlane = polarPlanePoint(second, pole);
      const projectedLengthKm =
        Math.hypot(
          secondPlane[0] - firstPlane[0],
          secondPlane[1] - firstPlane[1],
        ) * KILOMETRES_PER_DEGREE;
      return projectedLengthKm;
    },
    midpoint: (first, second) =>
      polarPlaneMidpoint(first, second, pole),
    maximumEdgeKm: MAX_POLAR_TRIANGLE_EDGE_KM,
  };
}

function subdivideGlobeTriangle(
  triangle: [Position, Position, Position],
  plane: TriangulationPlane,
  output: Position[][],
  depth = 0,
): void {
  const edges = [
    {
      first: 0 as const,
      second: 1 as const,
      opposite: 2 as const,
      lengthKm: plane.edgeLengthKm(triangle[0], triangle[1]),
    },
    {
      first: 1 as const,
      second: 2 as const,
      opposite: 0 as const,
      lengthKm: plane.edgeLengthKm(triangle[1], triangle[2]),
    },
    {
      first: 2 as const,
      second: 0 as const,
      opposite: 1 as const,
      lengthKm: plane.edgeLengthKm(triangle[2], triangle[0]),
    },
  ].sort((left, right) => right.lengthKm - left.lengthKm);
  const longest = edges[0]!;
  if (
    longest.lengthKm <= plane.maximumEdgeKm ||
    depth >= 12
  ) {
    const averageLongitude =
      (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3;
    const world = Math.floor((averageLongitude + 180) / 360);
    const shifted = triangle.map(
      ([longitude, latitude]) =>
        [longitude - world * 360, latitude] as Position,
    );
    shifted.push([...shifted[0]!] as Position);
    output.push(shifted);
    return;
  }

  const first = triangle[longest.first];
  const second = triangle[longest.second];
  const opposite = triangle[longest.opposite];
  const middle = plane.midpoint(first, second);
  subdivideGlobeTriangle(
    [first, middle, opposite],
    plane,
    output,
    depth + 1,
  );
  subdivideGlobeTriangle(
    [middle, second, opposite],
    plane,
    output,
    depth + 1,
  );
}

function globeFillTriangles(ring: Position[]): Position[][] {
  const unwrapped = unwrapPhysicalRing(ring);
  if (unwrapped.length < 3) return [];
  const plane = triangulationPlane(unwrapped);
  const indices = earcut(plane.coordinates);
  const triangles: Position[][] = [];
  for (let index = 0; index < indices.length; index += 3) {
    const first = unwrapped[indices[index]!]!;
    const second = unwrapped[indices[index + 1]!]!;
    const third = unwrapped[indices[index + 2]!]!;
    subdivideGlobeTriangle(
      [first, second, third],
      plane,
      triangles,
    );
  }
  return triangles;
}

/**
 * Partitions globe fills into small lon/lat triangles before MapLibre
 * triangulates them. This preserves a concave physical boundary near a pole
 * without allowing one projected triangle to span across the ribbon.
 */
export function geometryForGlobeFill(geometry: Geometry): Geometry {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
    return geometry;
  }
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.coordinates;
  const triangles = restoreCanonicalPolygonRings(polygons).flatMap(
    globeFillTriangles,
  );
  return triangles.length === 1
    ? { type: "Polygon", coordinates: [triangles[0]!] }
    : {
        type: "MultiPolygon",
        coordinates: triangles.map((ring) => [ring]),
      };
}

function displayPolygons(
  polygons: Position[][][],
  anchorLongitude: number,
): Position[][][] {
  return restoreCanonicalPolygonRings(polygons).flatMap((outerRing) => {
    return splitPolygonAtAntimeridian(
      outerRing.map((point) =>
        rotatePosition(point, anchorLongitude),
      ),
    ).map((splitPolygon) =>
      splitPolygon.map((ring) =>
        ring.map((point) =>
          placePosition(point, anchorLongitude),
        ),
      ),
    );
  });
}

export function geometryForLeaflet(
  geometry: Geometry,
  anchorLongitude: number,
): Geometry {
  switch (geometry.type) {
    case "Point":
      return {
        type: "Point",
        coordinates: placePosition(
          rotatePosition(geometry.coordinates, anchorLongitude),
          anchorLongitude,
        ),
      };
    case "LineString":
      return lineGeometry([geometry.coordinates], anchorLongitude);
    case "MultiLineString":
      return lineGeometry(geometry.coordinates, anchorLongitude);
    case "Polygon": {
      const polygons = displayPolygons(
        [geometry.coordinates],
        anchorLongitude,
      );
      return polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0]! }
        : { type: "MultiPolygon", coordinates: polygons };
    }
    case "MultiPolygon": {
      const polygons = displayPolygons(
        geometry.coordinates,
        anchorLongitude,
      );
      return polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0]! }
        : { type: "MultiPolygon", coordinates: polygons };
    }
  }
}

export function collectionForLeaflet<
  T extends { features: Feature[] },
>(
  collection: T,
  anchorLongitude: number,
): Omit<T, "features"> & { features: Feature[] } {
  return {
    ...collection,
    features: collection.features.map((feature) => ({
      ...feature,
      geometry: geometryForLeaflet(
        feature.geometry,
        anchorLongitude,
      ),
    })),
  };
}
