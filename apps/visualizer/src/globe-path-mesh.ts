import {
  haversineDistanceKm,
  normalizeLongitude,
  type CentralPathStrip,
  type CentralPathSurface,
  type Position,
  type TimedSurfacePoint,
} from "@found-in-space/shadowline";

/**
 * Boundary curves and ruled rows are sampled no farther apart than this.
 * Consequently a cell diagonal is bounded by two such steps (100 km by the
 * triangle inequality), independent of the cell's aspect ratio.
 */
export const GLOBE_PATH_MESH_STEP_KM = 50;

/**
 * A 100 km chord sags less than 200 m below a 6,371 km sphere. The structured
 * mesh bounds every triangle edge by 100 km, so 1 km is a conservative,
 * derived depth offset rather than a substitute for valid topology.
 */
export const GLOBE_PATH_FILL_ELEVATION_METRES = 1_000;

export type GlobePathTriangle = [Position, Position, Position];

interface Vector {
  x: number;
  y: number;
  z: number;
}

interface Sample {
  timeMs: number;
  point: Position;
}

function vectorFromPosition([longitudeDeg, latitudeDeg]: Position): Vector {
  const longitude = (longitudeDeg * Math.PI) / 180;
  const latitude = (latitudeDeg * Math.PI) / 180;
  const cosineLatitude = Math.cos(latitude);
  return {
    x: cosineLatitude * Math.cos(longitude),
    y: cosineLatitude * Math.sin(longitude),
    z: Math.sin(latitude),
  };
}

function normalized(vector: Vector): Vector {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(length) || length < 1e-15) {
    throw new Error("Cannot normalize a zero-length globe-mesh vector.");
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function cross(first: Vector, second: Vector): Vector {
  return {
    x: first.y * second.z - first.z * second.y,
    y: first.z * second.x - first.x * second.z,
    z: first.x * second.y - first.y * second.x,
  };
}

function dot(first: Vector, second: Vector): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

function positionFromVector(vector: Vector, referenceLongitude: number): Position {
  const unit = normalized(vector);
  let longitude = (Math.atan2(unit.y, unit.x) * 180) / Math.PI;
  while (longitude - referenceLongitude > 180) longitude -= 360;
  while (longitude - referenceLongitude < -180) longitude += 360;
  return [
    longitude,
    (Math.asin(Math.max(-1, Math.min(1, unit.z))) * 180) / Math.PI,
  ];
}

/**
 * Interpolates along the shortest great-circle arc. The antipodal fallback
 * chooses a deterministic perpendicular, so the adapter remains finite even
 * for a valid but ambiguous 180-degree input edge.
 */
export function interpolateGlobePosition(
  first: Position,
  second: Position,
  fraction: number,
): Position {
  if (fraction <= 0) return [...first] as Position;
  if (fraction >= 1) return [...second] as Position;
  const firstVector = vectorFromPosition(first);
  const secondVector = vectorFromPosition(second);
  const cosine = Math.max(-1, Math.min(1, dot(firstVector, secondVector)));
  const referenceLongitude =
    first[0] +
    fraction *
      (() => {
        let delta = second[0] - first[0];
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        return delta;
      })();

  if (cosine > 1 - 1e-12) {
    return positionFromVector(
      {
        x: firstVector.x + fraction * (secondVector.x - firstVector.x),
        y: firstVector.y + fraction * (secondVector.y - firstVector.y),
        z: firstVector.z + fraction * (secondVector.z - firstVector.z),
      },
      referenceLongitude,
    );
  }

  if (cosine < -1 + 1e-12) {
    const reference =
      Math.abs(firstVector.z) < 0.8
        ? { x: 0, y: 0, z: 1 }
        : { x: 1, y: 0, z: 0 };
    const perpendicular = normalized(cross(reference, firstVector));
    const angle = Math.PI * fraction;
    return positionFromVector(
      {
        x: Math.cos(angle) * firstVector.x + Math.sin(angle) * perpendicular.x,
        y: Math.cos(angle) * firstVector.y + Math.sin(angle) * perpendicular.y,
        z: Math.cos(angle) * firstVector.z + Math.sin(angle) * perpendicular.z,
      },
      referenceLongitude,
    );
  }

  const angle = Math.acos(cosine);
  const sine = Math.sin(angle);
  const firstWeight = Math.sin((1 - fraction) * angle) / sine;
  const secondWeight = Math.sin(fraction * angle) / sine;
  return positionFromVector(
    {
      x: firstWeight * firstVector.x + secondWeight * secondVector.x,
      y: firstWeight * firstVector.y + secondWeight * secondVector.y,
      z: firstWeight * firstVector.z + secondWeight * secondVector.z,
    },
    referenceLongitude,
  );
}

export function densifyGlobeLine(
  points: Position[],
  maximumStepKm = GLOBE_PATH_MESH_STEP_KM,
): Position[] {
  if (!Number.isFinite(maximumStepKm) || maximumStepKm <= 0) {
    throw new RangeError("Globe-line step must be a positive distance.");
  }
  if (points.length < 2) {
    return points.map((point) => [...point] as Position);
  }
  const output: Position[] = [[...points[0]!] as Position];
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1]!;
    const second = points[index]!;
    const divisions = Math.max(
      1,
      Math.ceil(haversineDistanceKm(first, second) / maximumStepKm),
    );
    for (let division = 1; division <= divisions; division += 1) {
      output.push(
        interpolateGlobePosition(first, second, division / divisions),
      );
    }
  }
  return output;
}

function samples(edge: TimedSurfacePoint[]): Sample[] {
  const output: Sample[] = [];
  for (const sample of edge) {
    const timeMs = Date.parse(sample.atUtc);
    const {
      longitudeDeg: longitude,
      latitudeDeg: latitude,
    } = sample.geographic;
    if (
      !Number.isFinite(timeMs) ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw new RangeError("Invalid physical eclipse-path surface sample.");
    }
    if (output.length > 0 && timeMs < output[output.length - 1]!.timeMs) {
      throw new RangeError("Eclipse-path surface samples must be time ordered.");
    }
    const copy = {
      timeMs,
      point: [longitude, latitude] as Position,
    };
    if (output.at(-1)?.timeMs === timeMs) {
      output[output.length - 1] = copy;
    } else {
      output.push(copy);
    }
  }
  return output;
}

function sampleAt(edge: Sample[], timeMs: number): Position {
  if (timeMs <= edge[0]!.timeMs) return [...edge[0]!.point] as Position;
  if (timeMs >= edge.at(-1)!.timeMs) {
    return [...edge.at(-1)!.point] as Position;
  }
  let low = 0;
  let high = edge.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (edge[middle]!.timeMs <= timeMs) low = middle;
    else high = middle;
  }
  const first = edge[low]!;
  const second = edge[high]!;
  const fraction =
    (timeMs - first.timeMs) / (second.timeMs - first.timeMs);
  return interpolateGlobePosition(first.point, second.point, fraction);
}

function stripRows(strip: CentralPathStrip): Array<[Position, Position]> {
  const first = samples(strip.edges[0].points);
  const second = samples(strip.edges[1].points);
  if (first.length < 2 || second.length < 2) return [];
  const firstDuration = first.at(-1)!.timeMs - first[0]!.timeMs;
  const secondDuration = second.at(-1)!.timeMs - second[0]!.timeMs;
  if (firstDuration <= 0 || secondDuration <= 0) return [];

  // Use normalized physical time so both complete boundaries, including their
  // exact cap/limit junctions, remain in the mesh if their sampled time ranges
  // differ by a small root-refinement amount.
  const parameters = new Set<number>([0, 1]);
  for (const sample of first) {
    parameters.add((sample.timeMs - first[0]!.timeMs) / firstDuration);
  }
  for (const sample of second) {
    parameters.add((sample.timeMs - second[0]!.timeMs) / secondDuration);
  }
  const baseRows = [...parameters]
    .filter((parameter) => parameter >= 0 && parameter <= 1)
    .sort((left, right) => left - right)
    .map(
      (parameter): [Position, Position] => [
        sampleAt(first, first[0]!.timeMs + parameter * firstDuration),
        sampleAt(second, second[0]!.timeMs + parameter * secondDuration),
      ],
    );

  const denseRows: Array<[Position, Position]> = [baseRows[0]!];
  for (let index = 1; index < baseRows.length; index += 1) {
    const previous = baseRows[index - 1]!;
    const current = baseRows[index]!;
    const divisions = Math.max(
      1,
      Math.ceil(
        Math.max(
          haversineDistanceKm(previous[0], current[0]),
          haversineDistanceKm(previous[1], current[1]),
        ) / GLOBE_PATH_MESH_STEP_KM,
      ),
    );
    for (let division = 1; division <= divisions; division += 1) {
      const fraction = division / divisions;
      denseRows.push([
        interpolateGlobePosition(previous[0], current[0], fraction),
        interpolateGlobePosition(previous[1], current[1], fraction),
      ]);
    }
  }
  return denseRows;
}

function triangleAreaSignal(triangle: GlobePathTriangle): number {
  const [first, second, third] = triangle.map(vectorFromPosition) as [
    Vector,
    Vector,
    Vector,
  ];
  const firstEdge = {
    x: second.x - first.x,
    y: second.y - first.y,
    z: second.z - first.z,
  };
  const secondEdge = {
    x: third.x - first.x,
    y: third.y - first.y,
    z: third.z - first.z,
  };
  const area = cross(firstEdge, secondEdge);
  return Math.hypot(area.x, area.y, area.z);
}

function placeTriangleInOneWorld(
  triangle: GlobePathTriangle,
): GlobePathTriangle {
  const firstLongitude = normalizeLongitude(triangle[0][0]);
  const placed = triangle.map(([longitude, latitude], index) => {
    let value = index === 0 ? firstLongitude : longitude;
    while (value - firstLongitude > 180) value -= 360;
    while (value - firstLongitude < -180) value += 360;
    return [value, latitude] as Position;
  }) as GlobePathTriangle;
  const average =
    (placed[0][0] + placed[1][0] + placed[2][0]) / 3;
  const world = Math.floor((average + 180) / 360);
  return placed.map(
    ([longitude, latitude]) =>
      [longitude - world * 360, latitude] as Position,
  ) as GlobePathTriangle;
}

function meshStrip(strip: CentralPathStrip): GlobePathTriangle[] {
  const rows = stripRows(strip);
  if (rows.length < 2) return [];
  const acrossDivisions = Math.max(
    1,
    ...rows.map((row) =>
      Math.ceil(
        haversineDistanceKm(row[0], row[1]) /
          GLOBE_PATH_MESH_STEP_KM,
      ),
    ),
  );
  const grid = rows.map((row) =>
    Array.from({ length: acrossDivisions + 1 }, (_, index) =>
      interpolateGlobePosition(
        row[0],
        row[1],
        index / acrossDivisions,
      ),
    ),
  );
  const output: GlobePathTriangle[] = [];
  const append = (triangle: GlobePathTriangle) => {
    if (triangleAreaSignal(triangle) > 1e-13) {
      output.push(placeTriangleInOneWorld(triangle));
    }
  };
  for (let row = 1; row < grid.length; row += 1) {
    const previous = grid[row - 1]!;
    const current = grid[row]!;
    for (let column = 1; column < previous.length; column += 1) {
      const southwest = previous[column - 1]!;
      const southeast = previous[column]!;
      const northwest = current[column - 1]!;
      const northeast = current[column]!;
      append([southwest, northeast, northwest]);
      append([southwest, southeast, northeast]);
    }
  }
  return output;
}

/**
 * Builds the central path from its three physical ruled surfaces: the signed
 * cross-track strip and its two horizon caps. No GeoJSON shard, synthetic
 * pole closure, planar polygon triangulation, or inferred long-range diagonal
 * is involved.
 */
export function globePathTriangles(
  surface: CentralPathSurface,
): GlobePathTriangle[] {
  const main: CentralPathStrip = {
    edges: [
      surface.limits.positiveCrossTrack,
      surface.limits.negativeCrossTrack,
    ],
  };
  return [
    ...meshStrip(main),
    ...meshStrip(surface.startCap),
    ...meshStrip(surface.endCap),
  ];
}
