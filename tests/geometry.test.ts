import { describe, expect, it } from "vitest";
import {
  lineGeometry,
  polygonGeometry,
  splitLineAtAntimeridian,
} from "@found-in-space/shadowline";
import { clipForWebMercator } from "../apps/visualizer/src/web-mercator.js";

describe("antimeridian-safe geometry", () => {
  it("splits lines without world-spanning segments", () => {
    const parts = splitLineAtAntimeridian([
      [170, 10],
      [-170, 12],
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.at(-1)![0]).toBe(180);
    expect(parts[1]![0]![0]).toBe(-180);
    for (const part of parts) {
      for (let index = 1; index < part.length; index += 1) {
        expect(Math.abs(part[index]![0] - part[index - 1]![0])).toBeLessThanOrEqual(
          180,
        );
      }
    }
    expect(lineGeometry([[170, 0], [-170, 0]]).type).toBe(
      "MultiLineString",
    );
  });

  it("preserves the approached side of an exact 180-degree vertex", () => {
    const parts = splitLineAtAntimeridian([
      [-165, 60],
      [180, 58],
      [165, 56],
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.at(-1)![0]).toBe(-180);
    expect(parts[1]![0]![0]).toBe(180);
    for (const part of parts) {
      for (let index = 1; index < part.length; index += 1) {
        expect(
          Math.abs(part[index]![0] - part[index - 1]![0]),
        ).toBeLessThanOrEqual(180);
      }
    }
  });

  it("splits polygons into RFC 7946 worlds", () => {
    const geometry = polygonGeometry([
      [170, -10],
      [-170, -10],
      [-170, 10],
      [170, 10],
      [170, -10],
    ]);
    expect(geometry.type).toBe("MultiPolygon");
    if (geometry.type === "MultiPolygon") {
      expect(geometry.coordinates).toHaveLength(2);
      expect(
        geometry.coordinates
          .flat(2)
          .every(([longitude]) => longitude >= -180 && longitude <= 180),
      ).toBe(true);
      for (const ring of geometry.coordinates.flat()) {
        for (let index = 1; index < ring.length; index += 1) {
          expect(
            Math.abs(ring[index]![0] - ring[index - 1]![0]),
          ).toBeLessThanOrEqual(180);
        }
      }
      expect(geometry.coordinates[1]![0]![0]![0]).toBe(-180);
    }
  });

  it("closes longitude-winding polygons through the enclosed pole", () => {
    const geometry = polygonGeometry([
      [150, 80],
      [80, 74],
      [0, 72],
      [-80, 74],
      [-170, 80],
      [170, 81],
      [150, 80],
    ]);
    expect(geometry.type).toBe("MultiPolygon");
    if (geometry.type === "MultiPolygon") {
      const positions = geometry.coordinates.flat(2);
      expect(Math.max(...positions.map((point) => point[1]))).toBe(90);
      expect(
        positions.every(
          ([longitude, latitude]) =>
            longitude >= -180 &&
            longitude <= 180 &&
            latitude >= -90 &&
            latitude <= 90,
        ),
      ).toBe(true);
    }
  });
});

describe("Web Mercator display clipping", () => {
  it("splits polar lines instead of drawing along the projection edge", () => {
    const display = clipForWebMercator({
      features: [
        {
          type: "Feature" as const,
          geometry: {
            type: "LineString" as const,
            coordinates: [
              [0, 80],
              [10, 89],
              [20, 80],
            ] as [number, number][],
          },
          properties: {},
        },
      ],
    });
    const geometry = display.features[0]!.geometry;
    expect(geometry.type).toBe("MultiLineString");
    if (geometry.type === "MultiLineString") {
      expect(geometry.coordinates).toHaveLength(2);
      expect(
        geometry.coordinates.every((line) =>
          line.every((coordinate) => Math.abs(coordinate[1]) <= 85.051128),
        ),
      ).toBe(true);
    }
  });
});
