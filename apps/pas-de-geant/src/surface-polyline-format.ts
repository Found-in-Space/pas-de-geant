import { Vector3 } from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  geodeticSurfaceEcefKm,
} from "@found-in-space/worlds/planet-state";

const HEADER_BYTES = 40;
const FORMAT_VERSION = 1;
const MAGIC = [0x50, 0x44, 0x47, 0x4c, 0x49, 0x4e, 0x45, 0] as const;
const point = new Vector3();

export interface SurfacePolylineData {
  readonly year: number;
  readonly pointCount: number;
  readonly bounds: readonly [number, number, number, number];
  /** Each view contains interleaved longitude/latitude pairs in degrees. */
  readonly lines: readonly Float32Array[];
}

function requireBytes(
  byteLength: number,
  offset: number,
  required: number,
  detail: string,
): void {
  if (required < 0 || offset < 0 || offset + required > byteLength) {
    throw new RangeError(`Truncated surface-polyline ${detail}.`);
  }
}

/** Decodes the compact output of scripts/build-amazon-forest-outlines.mjs. */
export function decodeSurfacePolylines(buffer: ArrayBuffer): SurfacePolylineData {
  requireBytes(buffer.byteLength, 0, HEADER_BYTES, "header");
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      throw new TypeError("Unrecognized surface-polyline file signature.");
    }
  }
  const view = new DataView(buffer);
  const version = view.getUint32(8, true);
  if (version !== FORMAT_VERSION) {
    throw new TypeError(`Unsupported surface-polyline format version ${version}.`);
  }

  const year = view.getInt32(12, true);
  const lineCount = view.getUint32(16, true);
  const expectedPointCount = view.getUint32(20, true);
  const bounds = [
    view.getFloat32(24, true),
    view.getFloat32(28, true),
    view.getFloat32(32, true),
    view.getFloat32(36, true),
  ] as const;
  const lines: Float32Array[] = [];
  let offset = HEADER_BYTES;
  let pointCount = 0;
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    requireBytes(buffer.byteLength, offset, 4, `line ${lineIndex} header`);
    const linePointCount = view.getUint32(offset, true);
    offset += 4;
    if (linePointCount < 2) {
      throw new RangeError(`Surface-polyline line ${lineIndex} has fewer than two points.`);
    }
    const coordinateBytes = linePointCount * 2 * Float32Array.BYTES_PER_ELEMENT;
    requireBytes(
      buffer.byteLength,
      offset,
      coordinateBytes,
      `line ${lineIndex} coordinates`,
    );
    lines.push(new Float32Array(buffer, offset, linePointCount * 2));
    offset += coordinateBytes;
    pointCount += linePointCount;
  }
  if (pointCount !== expectedPointCount) {
    throw new RangeError(
      `Surface-polyline header declares ${expectedPointCount} points but contains ${pointCount}.`,
    );
  }
  if (offset !== buffer.byteLength) {
    throw new RangeError("Surface-polyline file has unexpected trailing bytes.");
  }
  return { year, pointCount, bounds, lines };
}

function writeNormalizedPoint(
  output: Float32Array,
  outputOffset: number,
  longitudeDegrees: number,
  latitudeDegrees: number,
  normalizedRadialOffset: number,
): void {
  geodeticSurfaceEcefKm(latitudeDegrees, longitudeDegrees, point)
    .multiplyScalar(1 / EARTH_MEAN_RADIUS_KM);
  if (normalizedRadialOffset !== 0) {
    const latitude = latitudeDegrees * Math.PI / 180;
    const longitude = longitudeDegrees * Math.PI / 180;
    const cosineLatitude = Math.cos(latitude);
    point.x += cosineLatitude * Math.cos(longitude) * normalizedRadialOffset;
    point.y += Math.sin(latitude) * normalizedRadialOffset;
    point.z -= cosineLatitude * Math.sin(longitude) * normalizedRadialOffset;
  }
  output[outputOffset] = point.x;
  output[outputOffset + 1] = point.y;
  output[outputOffset + 2] = point.z;
}

/**
 * Expands longitude/latitude lines into normalized ECEF LineSegments positions.
 * Add the returned BufferAttribute to a LineSegments child of planetRoot.
 */
export function surfacePolylineLineSegmentPositions(
  data: SurfacePolylineData,
  normalizedRadialOffset = 0,
): Float32Array {
  const segmentCount = data.lines.reduce(
    (total, line) => total + Math.max(0, line.length / 2 - 1),
    0,
  );
  const positions = new Float32Array(segmentCount * 2 * 3);
  let outputOffset = 0;
  for (const line of data.lines) {
    for (let pointIndex = 0; pointIndex < line.length / 2 - 1; pointIndex += 1) {
      const coordinateOffset = pointIndex * 2;
      writeNormalizedPoint(
        positions,
        outputOffset,
        line[coordinateOffset] ?? 0,
        line[coordinateOffset + 1] ?? 0,
        normalizedRadialOffset,
      );
      writeNormalizedPoint(
        positions,
        outputOffset + 3,
        line[coordinateOffset + 2] ?? 0,
        line[coordinateOffset + 3] ?? 0,
        normalizedRadialOffset,
      );
      outputOffset += 6;
    }
  }
  return positions;
}
