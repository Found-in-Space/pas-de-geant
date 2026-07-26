import {
  lineGeometry,
  polygonGeometry,
} from "./antimeridian.js";
import { round } from "./math.js";
import type {
  EclipseFeatureCollection,
  EclipseScene,
  Feature,
  GeoJsonOptions,
  Geometry,
  Position,
  SurfacePoint,
} from "./types.js";

function validateOptions(options: GeoJsonOptions): Required<GeoJsonOptions> {
  const latitudeClipDeg = options.latitudeClipDeg ?? 90;
  if (
    !Number.isFinite(latitudeClipDeg) ||
    latitudeClipDeg <= 0 ||
    latitudeClipDeg > 90
  ) {
    throw new RangeError(
      "GeoJSON latitude clip must be above 0 and at most 90 degrees.",
    );
  }
  return {
    seam: options.seam ?? "split",
    latitudeClipDeg,
  };
}

function position(
  point: SurfacePoint,
  latitudeClipDeg: number,
): Position {
  return [
    point.geographic.longitudeDeg,
    Math.max(
      -latitudeClipDeg,
      Math.min(latitudeClipDeg, point.geographic.latitudeDeg),
    ),
  ];
}

function line(
  points: SurfacePoint[],
  options: Required<GeoJsonOptions>,
): Geometry {
  const positions = points.map((point) =>
    position(point, options.latitudeClipDeg),
  );
  return options.seam === "split"
    ? lineGeometry(positions)
    : { type: "LineString", coordinates: positions };
}

function polygon(
  points: SurfacePoint[],
  options: Required<GeoJsonOptions>,
): Geometry {
  const positions = points.map((point) =>
    position(point, options.latitudeClipDeg),
  );
  return options.seam === "split"
    ? polygonGeometry(positions)
    : { type: "Polygon", coordinates: [positions] };
}

function commonProperties(scene: EclipseScene) {
  return {
    event_id: scene.event.id,
    eclipse_kind: scene.event.kind,
    peak_utc: scene.event.peakUtc,
    datum: "WGS 84",
    calculation_frame: "geocentric-earth-fixed",
    provider: scene.provider.id,
    provider_version: scene.provider.version,
  };
}

export function toGeoJson(
  scene: EclipseScene,
  requestedOptions: GeoJsonOptions = {},
): EclipseFeatureCollection {
  const options = validateOptions(requestedOptions);
  const common = commonProperties(scene);
  const features: Feature[] = [];
  const central = scene.centralPath;
  if (central) {
    features.push(
      {
        type: "Feature",
        id: `${scene.event.id}-central-path`,
        geometry: polygon(central.boundary.points, options),
        properties: {
          ...common,
          feature_type: "central_path",
          name: `Central eclipse path — ${scene.event.id}`,
        },
      },
      {
        type: "Feature",
        id: `${scene.event.id}-centerline`,
        geometry: line(central.centerline.points, options),
        properties: {
          ...common,
          feature_type: "centerline",
          name: "Centre line",
        },
      },
      {
        type: "Feature",
        id: `${scene.event.id}-positive-cross-track-limit`,
        geometry: line(
          central.limits.positiveCrossTrack.points,
          options,
        ),
        properties: {
          ...common,
          feature_type: "positive_cross_track_limit",
          name: "Positive cross-track central-eclipse limit",
        },
      },
      {
        type: "Feature",
        id: `${scene.event.id}-negative-cross-track-limit`,
        geometry: line(
          central.limits.negativeCrossTrack.points,
          options,
        ),
        properties: {
          ...common,
          feature_type: "negative_cross_track_limit",
          name: "Negative cross-track central-eclipse limit",
        },
      },
    );
  }
  scene.globalVisibility.extent.forEach((curve, index) => {
    features.push({
      type: "Feature",
      id: `${scene.event.id}-penumbra-extent-${index + 1}`,
      geometry: line(curve.points, options),
      properties: {
        ...common,
        feature_type: "penumbra_extent",
        name: `Partial-eclipse visibility limit ${index + 1}`,
      },
    });
  });
  scene.globalVisibility.horizon.forEach((curve, index) => {
    features.push({
      type: "Feature",
      id: `${scene.event.id}-penumbra-horizon-${index + 1}`,
      geometry: line(curve.points, options),
      properties: {
        ...common,
        feature_type: "penumbra_horizon",
        name: `Penumbral horizon limit ${index + 1}`,
      },
    });
  });
  for (const contact of scene.contacts) {
    features.push({
      type: "Feature",
      id: `${scene.event.id}-${contact.kind}`,
      geometry: {
        type: "Point",
        coordinates: position(
          contact.point,
          options.latitudeClipDeg,
        ),
      },
      properties: {
        ...common,
        feature_type: "penumbral_contact",
        contact: contact.kind,
        utc: contact.utc,
        name: `${contact.kind} — ${contact.utc}`,
      },
    });
  }
  for (const shadow of scene.instantaneousShadows) {
    shadow.penumbra.rings.forEach((ring, index) => {
      features.push({
        type: "Feature",
        id: `${scene.event.id}-${shadow.atUtc}-penumbra-${index + 1}`,
        geometry: polygon(ring.points, options),
        properties: {
          ...common,
          feature_type: "instantaneous_penumbra",
          shadow_kind: "penumbra",
          at_utc: shadow.atUtc,
          name: `Penumbra at ${shadow.atUtc}`,
        },
      });
    });
    shadow.central?.region.rings.forEach((ring, index) => {
      features.push({
        type: "Feature",
        id: `${scene.event.id}-${shadow.atUtc}-${shadow.central!.kind}-${index + 1}`,
        geometry: polygon(ring.points, options),
        properties: {
          ...common,
          feature_type: `instantaneous_${shadow.central!.kind}`,
          shadow_kind: shadow.central!.kind,
          at_utc: shadow.atUtc,
          name: `${
            shadow.central!.kind === "umbra"
              ? "Umbra"
              : "Antumbra"
          } at ${shadow.atUtc}`,
        },
      });
    });
  }
  for (const marker of scene.timeMarkers) {
    features.push({
      type: "Feature",
      id: `${scene.event.id}-${marker.point.atUtc}`,
      geometry: {
        type: "Point",
        coordinates: position(
          marker.point,
          options.latitudeClipDeg,
        ),
      },
      properties: {
        ...common,
        feature_type: "time_marker",
        name:
          new Date(marker.point.atUtc)
            .toISOString()
            .slice(11, 16) + " UTC",
        utc: marker.point.atUtc,
        sun_altitude_deg: round(marker.sunAltitudeDeg, 1),
        sun_azimuth_deg: round(marker.sunAzimuthDeg, 1),
        path_width_km: round(marker.pathWidthKm, 1),
        central_duration_seconds:
          marker.centralDurationSeconds ?? null,
        eclipse_kind: marker.eclipseKind,
      },
    });
  }
  return {
    type: "FeatureCollection",
    metadata: {
      schemaVersion: "2.0.0",
      eventId: scene.event.id,
      eventKind: scene.event.kind,
      peakUtc: scene.event.peakUtc,
      provider: scene.provider,
      datum: "WGS 84",
    },
    features,
  };
}
