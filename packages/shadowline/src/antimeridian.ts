import type { Geometry, Position } from "./types.js";
import { normalizeLongitude } from "./math.js";

function interpolateBoundary(
  a: Position,
  b: Position,
  boundaryLongitude: number,
): Position {
  const fraction = (boundaryLongitude - a[0]) / (b[0] - a[0]);
  return [boundaryLongitude, a[1] + fraction * (b[1] - a[1])];
}

export function splitLineAtAntimeridian(line: Position[]): Position[][] {
  if (line.length < 2) {
    return line.length === 0 ? [] : [line];
  }

  const parts: Position[][] = [[[normalizeLongitude(line[0]![0]), line[0]![1]]]];
  for (let index = 1; index < line.length; index += 1) {
    const current = line[index]!;
    const active = parts[parts.length - 1]!;
    const previous = active[active.length - 1]!;
    const previousLongitude = previous[0];
    let currentLongitude = normalizeLongitude(current[0]);
    let adjustedCurrent = currentLongitude;
    const delta = currentLongitude - previousLongitude;

    if (delta > 180) {
      adjustedCurrent -= 360;
    } else if (delta < -180) {
      adjustedCurrent += 360;
    }

    if (adjustedCurrent > 180 || adjustedCurrent < -180) {
      const boundary = adjustedCurrent > 180 ? 180 : -180;
      const crossing = interpolateBoundary(
        previous,
        [adjustedCurrent, current[1]],
        boundary,
      );
      active.push(crossing);
      const opposite = boundary === 180 ? -180 : 180;
      parts.push([
        [opposite, crossing[1]],
        [currentLongitude, current[1]],
      ]);
    } else {
      active.push([adjustedCurrent, current[1]]);
    }
  }
  return parts.filter((part) => part.length >= 2);
}

function clipVertical(
  ring: Position[],
  boundary: number,
  keepGreater: boolean,
): Position[] {
  const output: Position[] = [];
  if (ring.length === 0) {
    return output;
  }
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!;
    const previous = ring[(index + ring.length - 1) % ring.length]!;
    const currentInside = keepGreater
      ? current[0] >= boundary
      : current[0] <= boundary;
    const previousInside = keepGreater
      ? previous[0] >= boundary
      : previous[0] <= boundary;
    if (currentInside !== previousInside) {
      output.push(interpolateBoundary(previous, current, boundary));
    }
    if (currentInside) {
      output.push(current);
    }
  }
  return output;
}

function unwrapRing(ring: Position[]): Position[] {
  if (ring.length === 0) {
    return [];
  }
  const source =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.slice(0, -1)
      : ring;
  const output: Position[] = [
    [normalizeLongitude(source[0]![0]), source[0]![1]],
  ];
  for (let index = 1; index < source.length; index += 1) {
    const coordinate = source[index]!;
    let longitude = normalizeLongitude(coordinate[0]);
    const previous = output[output.length - 1]![0];
    while (longitude - previous > 180) longitude -= 360;
    while (longitude - previous < -180) longitude += 360;
    output.push([longitude, coordinate[1]]);
  }

  const first = output[0]!;
  const last = output[output.length - 1]!;
  let closingLongitude = first[0];
  while (closingLongitude - last[0] > 180) closingLongitude -= 360;
  while (closingLongitude - last[0] < -180) closingLongitude += 360;
  output.push([closingLongitude, first[1]]);

  const windingWorlds = Math.round(
    (closingLongitude - first[0]) / 360,
  );
  if (windingWorlds !== 0) {
    // A longitude winding denotes a ring that contains a geographic pole.
    // Closing it directly in lon/lat draws a false chord across the map.
    // Route the synthetic closure through the enclosed pole instead; a
    // renderer can then clip that cap cleanly for its chosen projection.
    const averageLatitude =
      source.reduce((sum, point) => sum + point[1], 0) / source.length;
    const poleLatitude = averageLatitude >= 0 ? 90 : -90;
    output.push(
      [closingLongitude, poleLatitude],
      [first[0], poleLatitude],
      [...first] as Position,
    );
  } else if (
    output[output.length - 1]![0] !== first[0] ||
    output[output.length - 1]![1] !== first[1]
  ) {
    output.push([...first] as Position);
  }
  return output;
}

export function splitPolygonAtAntimeridian(
  outerRing: Position[],
): Position[][][] {
  const unwrapped = unwrapRing(outerRing);
  if (unwrapped.length < 4) {
    return [];
  }
  const longitudes = unwrapped.map((coordinate) => coordinate[0]);
  const minimum = Math.min(...longitudes);
  const maximum = Math.max(...longitudes);
  const firstWorld = Math.floor((minimum + 180) / 360);
  const lastWorld = Math.floor((maximum + 180) / 360);
  const polygons: Position[][][] = [];

  for (let world = firstWorld; world <= lastWorld; world += 1) {
    const west = -180 + world * 360;
    const east = 180 + world * 360;
    let clipped = clipVertical(unwrapped, west, true);
    clipped = clipVertical(clipped, east, false);
    if (clipped.length < 3) {
      continue;
    }
    const shifted = clipped.map(([longitude, latitude]) => {
      // Preserve which side of the antimeridian a clipping boundary belongs
      // to. normalizeLongitude maps -180 to +180, which reconnects a split
      // polygon across the entire rendered world.
      const shiftedLongitude = longitude - world * 360;
      return [
        Math.max(-180, Math.min(180, shiftedLongitude)),
        latitude,
      ] as Position;
    });
    if (
      shifted[0]![0] !== shifted[shifted.length - 1]![0] ||
      shifted[0]![1] !== shifted[shifted.length - 1]![1]
    ) {
      shifted.push([...shifted[0]!] as Position);
    }
    if (shifted.length >= 4) {
      polygons.push([shifted]);
    }
  }
  return polygons;
}

export function lineGeometry(line: Position[]): Geometry {
  const parts = splitLineAtAntimeridian(line);
  return parts.length === 1
    ? { type: "LineString", coordinates: parts[0]! }
    : { type: "MultiLineString", coordinates: parts };
}

export function polygonGeometry(ring: Position[]): Geometry {
  const polygons = splitPolygonAtAntimeridian(ring);
  return polygons.length === 1
    ? { type: "Polygon", coordinates: polygons[0]! }
    : { type: "MultiPolygon", coordinates: polygons };
}
