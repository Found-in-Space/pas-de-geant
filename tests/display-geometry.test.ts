import { describe, expect, it } from "vitest";
import {
  collectionForLeaflet,
  geometryForGlobe,
  geometryForGlobeFill,
  geometryForLeaflet,
} from "../apps/visualizer/src/display-geometry.js";
import {
  haversineDistanceKm,
  polygonGeometry,
} from "@found-in-space/shadowline";
import { clipForWebMercator } from "../apps/visualizer/src/web-mercator.js";
import type {
  EclipseFeatureCollection,
  Geometry,
  Position,
} from "@found-in-space/shadowline";

function lineParts(geometry: Geometry): Position[][] {
  switch (geometry.type) {
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
      return geometry.coordinates;
    default:
      return [];
  }
}

function polygonRings(geometry: Geometry): Position[][] {
  switch (geometry.type) {
    case "Polygon":
      return geometry.coordinates;
    case "MultiPolygon":
      return geometry.coordinates.flat();
    default:
      return [];
  }
}

function expectNoDisplaySeams(parts: Position[][]): void {
  for (const part of parts) {
    for (let index = 1; index < part.length; index += 1) {
      expect(
        Math.abs(part[index]![0] - part[index - 1]![0]),
      ).toBeLessThanOrEqual(180);
    }
  }
}

describe("Leaflet display-coordinate adapter", () => {
  const anchorLongitude = -25;

  it("re-splits a 2026-style closed horizon line at the display seam", () => {
    const geometry: Geometry = {
      type: "MultiLineString",
      coordinates: [
        [
          [-166, 56],
          [-180, 66],
        ],
        [
          [180, 66],
          [170, 64],
          [155, 60],
          [140, 56],
          [-80, 20],
          [140, 48],
          [170, 50],
          [180, 51],
        ],
        [
          [-180, 51],
          [-166, 56],
        ],
      ],
    };
    const display = geometryForLeaflet(geometry, anchorLongitude);
    const parts = lineParts(display);

    expect(parts.length).toBeGreaterThan(3);
    expectNoDisplaySeams(parts);
    for (const point of parts.flat()) {
      expect(point[0]).toBeGreaterThanOrEqual(anchorLongitude - 180);
      expect(point[0]).toBeLessThanOrEqual(anchorLongitude + 180);
    }
  });

  it("places equivalent -180 and +180 coordinates in one Leaflet world", () => {
    const west = geometryForLeaflet(
      { type: "Point", coordinates: [-180, 60] },
      anchorLongitude,
    );
    const east = geometryForLeaflet(
      { type: "Point", coordinates: [180, 60] },
      anchorLongitude,
    );
    expect(west).toEqual(east);
  });

  it("re-splits polygons instead of drawing a chord across the map", () => {
    const geometry: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [145, 70],
          [165, 70],
          [165, 80],
          [145, 80],
          [145, 70],
        ],
      ],
    };
    const display = geometryForLeaflet(geometry, anchorLongitude);
    expect(display.type).toBe("MultiPolygon");
    expectNoDisplaySeams(polygonRings(display));
  });

  it("moves polar-ring closure to the Mercator latitude cap", () => {
    const canonical = polygonGeometry([
      [150, 80],
      [80, 74],
      [0, 72],
      [-80, 74],
      [-170, 80],
      [170, 81],
      [150, 80],
    ]);
    const transformed = geometryForLeaflet(
      canonical,
      anchorLongitude,
    );
    const clipped = clipForWebMercator({
      features: [
        {
          type: "Feature" as const,
          geometry: transformed,
          properties: {},
        },
      ],
    }).features[0]!.geometry;

    for (const ring of polygonRings(clipped)) {
      for (let index = 1; index < ring.length; index += 1) {
        const previous = ring[index - 1]!;
        const current = ring[index]!;
        if (Math.abs(current[0] - previous[0]) > 180) {
          expect(Math.abs(previous[1])).toBeCloseTo(85.051128, 5);
          expect(Math.abs(current[1])).toBeCloseTo(85.051128, 5);
        }
        const isLongHorizontalEdge =
          Math.abs(current[0] - previous[0]) > 30 &&
          Math.abs(current[1] - previous[1]) < 1e-9;
        if (isLongHorizontalEdge) {
          expect(Math.abs(current[1])).toBeCloseTo(85.051128, 5);
        }
      }
    }
  });

  it("uses the same transformation for every feature in a collection", () => {
    const collection: EclipseFeatureCollection = {
      type: "FeatureCollection",
      metadata: {
        schemaVersion: "2.0.0",
        eventId: "test",
        eventKind: "total",
        peakUtc: "2026-08-12T17:45:46Z",
        provider: {
          id: "test",
          name: "Test",
          version: "1",
          model: "test",
          accuracy: "planning",
        },
        datum: "WGS 84",
      },
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [180, 60] },
          properties: { feature_type: "penumbral_contact" },
        },
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [180, 60],
              [170, 55],
            ],
          },
          properties: { feature_type: "penumbra_horizon" },
        },
      ],
    };
    const display = collectionForLeaflet(
      collection,
      anchorLongitude,
    );
    const point = display.features[0]!.geometry;
    const line = display.features[1]!.geometry;
    expect(point.type).toBe("Point");
    expect(line.type).toBe("LineString");
    if (point.type === "Point" && line.type === "LineString") {
      expect(point.coordinates).toEqual(line.coordinates[0]);
    }
  });

  it("does not mutate the canonical pole and antimeridian geometry", () => {
    const canonical: EclipseFeatureCollection = {
      type: "FeatureCollection",
      metadata: {
        schemaVersion: "2.0.0",
        eventId: "canonical",
        eventKind: "total",
        peakUtc: "2026-08-12T17:45:46Z",
        provider: {
          id: "test",
          name: "Test",
          version: "1",
          model: "test",
          accuracy: "planning",
        },
        datum: "WGS 84",
      },
      features: [
        {
          type: "Feature",
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [180, 90],
                [170, 80],
              ],
              [
                [-180, 90],
                [-170, 80],
              ],
            ],
          },
          properties: { feature_type: "penumbra_horizon" },
        },
      ],
    };
    const before = structuredClone(canonical);

    collectionForLeaflet(canonical, -25);

    expect(canonical).toEqual(before);
    expect(canonical.features[0]!.geometry).toEqual(
      before.features[0]!.geometry,
    );
  });
});

describe("globe display-coordinate adapter", () => {
  it("removes RFC-only pole closure vertices from a physical polar ring", () => {
    const physical: Position[] = [
      [150, 80],
      [80, 74],
      [0, 72],
      [-80, 74],
      [-170, 80],
      [170, 81],
      [150, 80],
    ];
    const globe = geometryForGlobe(polygonGeometry(physical));
    const rings = polygonRings(globe);

    expect(rings).toHaveLength(1);
    expect(
      rings[0]!.some((point) => Math.abs(point[1]) === 90),
    ).toBe(false);
    for (const expected of physical.slice(0, -1)) {
      expect(
        rings[0]!.some(
          (point) =>
            Math.abs(point[0] - expected[0]) < 1e-9 &&
            Math.abs(point[1] - expected[1]) < 1e-9,
        ),
      ).toBe(true);
    }
  });

  it("leaves non-polygon globe geometry unchanged", () => {
    const line: Geometry = {
      type: "MultiLineString",
      coordinates: [
        [
          [170, 10],
          [180, 11],
        ],
        [
          [-180, 11],
          [-170, 12],
        ],
      ],
    };
    expect(geometryForGlobe(line)).toBe(line);
  });

  it("partitions a concave polar fill into projection-safe triangles", () => {
    const concavePolarRibbon = polygonGeometry([
      [118, 75],
      [122, 82],
      [118, 87],
      [92, 89],
      [72, 87],
      [101, 83],
      [108, 75],
      [118, 75],
    ]);
    const fill = geometryForGlobeFill(concavePolarRibbon);
    const triangles = polygonRings(fill);

    expect(fill.type).toBe("MultiPolygon");
    expect(triangles.length).toBeGreaterThan(10);
    for (const triangle of triangles) {
      expect(triangle).toHaveLength(4);
      for (let index = 1; index < triangle.length; index += 1) {
        expect(
          haversineDistanceKm(
            triangle[index - 1]!,
            triangle[index]!,
          ),
        ).toBeLessThanOrEqual(1_500.001);
      }
    }
  });
});
