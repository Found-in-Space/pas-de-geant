import { describe, expect, it } from "vitest";
import {
  GeoJsonExporter,
  KmlExporter,
  geodeticToEcef,
  type EclipseScene,
  type SurfacePoint,
} from "@found-in-space/shadowline";

function point(
  longitudeDeg: number,
  latitudeDeg: number,
): SurfacePoint {
  const geographic = { longitudeDeg, latitudeDeg };
  return {
    geographic,
    ecefKm: geodeticToEcef(geographic),
  };
}

const scene: EclipseScene = {
  event: {
    id: "solar-2025-03-29-partial",
    kind: "partial",
    peakUtc: "2025-03-29T10:47:25.889Z",
    shadowAxisDistanceKm: 6637,
  },
  provider: {
    id: "test",
    name: "Test",
    version: "1",
    model: "Fixture",
    accuracy: "planning",
  },
  centralPath: null,
  globalVisibility: {
    datum: "WGS 84",
    calculationFrame: "geocentric-earth-fixed",
    extent: [
      {
        points: [
          { ...point(-21.123456789, 58.987654321), atUtc: "2025-03-29T10:00:00Z" },
          { ...point(-20, 57), atUtc: "2025-03-29T11:00:00Z" },
        ],
      },
    ],
    horizon: [],
  },
  instantaneousShadows: [
    {
      datum: "WGS 84",
      calculationFrame: "geocentric-earth-fixed",
      atUtc: "2025-03-29T10:47:25.889Z",
      penumbra: {
        rings: [
          {
            points: [
              point(-20, 55),
              point(-15, 55),
              point(-17, 60),
              point(-20, 55),
            ],
            closed: true,
            segments: [],
          },
        ],
      },
      central: null,
    },
  ],
  contacts: [],
  timeMarkers: [],
};

describe("portable scene exporters", () => {
  it("produces deterministic six-decimal GeoJSON", () => {
    const exporter = new GeoJsonExporter();
    const first = exporter.export(scene);
    const second = exporter.export(scene);
    expect(first).toEqual(second);
    expect(first.filename).toBe("solar-2025-03-29-partial.geojson");
    expect(first.mimeType).toBe("application/geo+json");
    expect(String(first.contents)).toContain("-21.123457");
    const parsed = JSON.parse(String(first.contents));
    expect(parsed.type).toBe("FeatureCollection");
    expect(parsed.metadata.schemaVersion).toBe("2.0.0");
  });

  it("produces parseable deterministic KML metadata", () => {
    const exported = new KmlExporter().export(scene);
    expect(exported.filename).toBe("solar-2025-03-29-partial.kml");
    expect(exported.mimeType).toBe(
      "application/vnd.google-earth.kml+xml",
    );
    expect(String(exported.contents)).toContain(
      'xmlns="http://www.opengis.net/kml/2.2"',
    );
    expect(String(exported.contents)).toContain(
      "Partial-eclipse visibility limit",
    );
  });

  it("exports partial-only instantaneous geometry in both formats", () => {
    expect(String(new GeoJsonExporter().export(scene).contents)).toContain(
      "instantaneous_penumbra",
    );
    expect(String(new KmlExporter().export(scene).contents)).toContain(
      "Penumbra at",
    );
  });
});
