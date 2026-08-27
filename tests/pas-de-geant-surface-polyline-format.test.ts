import { describe, expect, it } from "vitest";
import {
  decodeSurfacePolylines,
  surfacePolylineLineSegmentPositions,
} from "../apps/pas-de-geant/src/surface-polyline-format.js";

function encodedLine(): ArrayBuffer {
  const coordinates = [-60, -5, -59, -4, -58, -3];
  const buffer = new ArrayBuffer(40 + 4 + coordinates.length * 4);
  const bytes = new Uint8Array(buffer);
  bytes.set([0x50, 0x44, 0x47, 0x4c, 0x49, 0x4e, 0x45, 0]);
  const view = new DataView(buffer);
  view.setUint32(8, 1, true);
  view.setInt32(12, 2005, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 3, true);
  [-60, -5, -58, -3].forEach((value, index) => {
    view.setFloat32(24 + index * 4, value, true);
  });
  view.setUint32(40, 3, true);
  coordinates.forEach((value, index) => {
    view.setFloat32(44 + index * 4, value, true);
  });
  return buffer;
}

describe("surface polyline format", () => {
  it("decodes line records and expands their shared vertices into segments", () => {
    const decoded = decodeSurfacePolylines(encodedLine());
    expect(decoded.year).toBe(2005);
    expect(decoded.pointCount).toBe(3);
    expect(decoded.bounds).toEqual([-60, -5, -58, -3]);
    expect([...decoded.lines[0]!]).toEqual([-60, -5, -59, -4, -58, -3]);

    const positions = surfacePolylineLineSegmentPositions(decoded);
    expect(positions).toHaveLength(12);
    expect([...positions.slice(3, 6)]).toEqual([...positions.slice(6, 9)]);
  });

  it("rejects a line record whose declared coordinates are truncated", () => {
    const truncated = encodedLine().slice(0, -4);
    expect(() => decodeSurfacePolylines(truncated)).toThrow(
      "Truncated surface-polyline line 0 coordinates",
    );
  });
});
