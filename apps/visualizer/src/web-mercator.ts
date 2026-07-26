import type {
  Feature,
  Geometry,
  Position,
} from "@found-in-space/shadowline";

export const WEB_MERCATOR_MAX_LATITUDE = 85.051128;

function clampPosition(position: Position, latitudeLimit: number): Position {
  return [
    position[0],
    Math.max(-latitudeLimit, Math.min(latitudeLimit, position[1])),
  ];
}

function interpolatePosition(
  start: Position,
  end: Position,
  fraction: number,
): Position {
  return [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
  ];
}

function clippedSegment(
  start: Position,
  end: Position,
  latitudeLimit: number,
): [Position, Position] | null {
  const deltaLatitude = end[1] - start[1];
  if (deltaLatitude === 0) {
    return Math.abs(start[1]) <= latitudeLimit ? [start, end] : null;
  }
  const intersections = [
    (-latitudeLimit - start[1]) / deltaLatitude,
    (latitudeLimit - start[1]) / deltaLatitude,
  ].sort((left, right) => left - right);
  const first = Math.max(0, intersections[0]!);
  const last = Math.min(1, intersections[1]!);
  if (first > last) {
    return null;
  }
  return [
    interpolatePosition(start, end, first),
    interpolatePosition(start, end, last),
  ];
}

function samePosition(left: Position, right: Position): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function clipLine(
  line: Position[],
  latitudeLimit: number,
): Position[][] {
  const parts: Position[][] = [];
  let active: Position[] | null = null;
  for (let index = 1; index < line.length; index += 1) {
    const clipped = clippedSegment(
      line[index - 1]!,
      line[index]!,
      latitudeLimit,
    );
    if (!clipped) {
      active = null;
      continue;
    }
    if (!active || !samePosition(active[active.length - 1]!, clipped[0])) {
      active = [clipped[0]];
      parts.push(active);
    }
    if (!samePosition(active[active.length - 1]!, clipped[1])) {
      active.push(clipped[1]);
    }
    if (!samePosition(clipped[1], line[index]!)) {
      active = null;
    }
  }
  return parts.filter((part) => part.length >= 2);
}

function clippedLineGeometry(
  lines: Position[][],
  latitudeLimit: number,
): Geometry {
  const parts = lines.flatMap((line) => clipLine(line, latitudeLimit));
  return parts.length <= 1
    ? { type: "LineString", coordinates: parts[0] ?? [] }
    : { type: "MultiLineString", coordinates: parts };
}

function clipRingAtLatitude(
  ring: Position[],
  boundary: number,
  keepGreater: boolean,
): Position[] {
  const output: Position[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!;
    const previous = ring[(index + ring.length - 1) % ring.length]!;
    const currentInside = keepGreater
      ? current[1] >= boundary
      : current[1] <= boundary;
    const previousInside = keepGreater
      ? previous[1] >= boundary
      : previous[1] <= boundary;
    if (currentInside !== previousInside) {
      const fraction =
        (boundary - previous[1]) / (current[1] - previous[1]);
      output.push(interpolatePosition(previous, current, fraction));
    }
    if (currentInside) {
      output.push(current);
    }
  }
  return output;
}

function clipRing(
  ring: Position[],
  latitudeLimit: number,
): Position[] {
  let clipped = clipRingAtLatitude(ring, -latitudeLimit, true);
  clipped = clipRingAtLatitude(clipped, latitudeLimit, false);
  if (
    clipped.length >= 3 &&
    !samePosition(clipped[0]!, clipped[clipped.length - 1]!)
  ) {
    clipped.push([...clipped[0]!] as Position);
  }
  return clipped;
}

function clipGeometry(geometry: Geometry, latitudeLimit: number): Geometry {
  switch (geometry.type) {
    case "Point":
      return {
        type: "Point",
        coordinates: clampPosition(geometry.coordinates, latitudeLimit),
      };
    case "LineString":
      return clippedLineGeometry([geometry.coordinates], latitudeLimit);
    case "MultiLineString":
      return clippedLineGeometry(geometry.coordinates, latitudeLimit);
    case "Polygon":
      return {
        type: "Polygon",
        coordinates: geometry.coordinates
          .map((ring) => clipRing(ring, latitudeLimit))
          .filter((ring) => ring.length >= 4),
      };
    case "MultiPolygon":
      return {
        type: "MultiPolygon",
        coordinates: geometry.coordinates
          .map((polygon) =>
            polygon
              .map((ring) => clipRing(ring, latitudeLimit))
              .filter((ring) => ring.length >= 4),
          )
          .filter((polygon) => polygon.length > 0),
      };
  }
}

export function clipForWebMercator<
  T extends { features: Feature[] },
>(
  collection: T,
  latitudeLimit = WEB_MERCATOR_MAX_LATITUDE,
): Omit<T, "features"> & { features: Feature[] } {
  return {
    ...collection,
    features: collection.features.map(
      (feature): Feature => ({
        ...feature,
        geometry: clipGeometry(feature.geometry, latitudeLimit),
      }),
    ),
  };
}
