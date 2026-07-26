import maplibregl, {
  type GeoJSONSource,
  type Map as MapLibreMap,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  normalizeLongitude,
  splitLineAtAntimeridian,
  toGeoJson,
  type EclipseScene,
  type Feature,
  type Geometry,
  type Observer,
  type Position,
} from "@found-in-space/shadowline";
import {
  ECLIPSE_COLORS,
  layerKeyForFeature,
  popupForFeature,
} from "./feature-presentation.js";
import {
  DEFAULT_LAYER_VISIBILITY,
  ECLIPSE_LAYER_KEYS,
  type EclipseLayerKey,
  type EclipseLayerVisibility,
  type EclipseRenderer,
} from "./renderer.js";
import {
  geometryForGlobe,
} from "./display-geometry.js";
import { GlobeFillLayer } from "./globe-fill-layer.js";
import {
  densifyGlobeLine,
  GLOBE_PATH_FILL_ELEVATION_METRES,
} from "./globe-path-mesh.js";
import {
  GlobeLineLayer,
  GlobePointLayer,
} from "./globe-vector-layer.js";
import { WEB_MERCATOR_MAX_LATITUDE } from "./web-mercator.js";

const EMPTY_COLLECTION = {
  type: "FeatureCollection" as const,
  features: [] as Feature[],
};

const SOURCE_IDS: Record<EclipseLayerKey, string> = {
  centralPath: "eclipse-central-path",
  partialExtent: "eclipse-partial-extent",
  horizonLimits: "eclipse-horizon-limits",
  contacts: "eclipse-contacts",
  localPenumbra: "eclipse-local-penumbra",
  localCentralShadow: "eclipse-local-central-shadow",
  centerAndLimits: "eclipse-centre-and-limits",
  timeMarkers: "eclipse-time-markers",
};

const LAYER_IDS: Record<EclipseLayerKey, string[]> = {
  centralPath: ["central-path-outline"],
  partialExtent: ["partial-extent-line"],
  horizonLimits: ["horizon-limits-line"],
  contacts: ["contacts-circle"],
  localPenumbra: ["local-penumbra-outline"],
  localCentralShadow: [
    "local-central-shadow-outline",
  ],
  centerAndLimits: ["centre-line", "limit-lines"],
  timeMarkers: ["time-markers-circle"],
};

export const GLOBE_STYLE: StyleSpecification = {
  version: 8,
  projection: { type: "globe" },
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    {
      id: "osm",
      type: "raster",
      source: "osm",
    },
  ],
  sky: {
    "sky-color": "#171521",
    "horizon-color": "#d8d4dd",
    "fog-color": "#e8e4eb",
    "sky-horizon-blend": 0.55,
    "horizon-fog-blend": 0.25,
    "fog-ground-blend": 0.1,
  },
};

function collection(features: Feature[]) {
  return {
    type: "FeatureCollection" as const,
    features,
  };
}

function featureGroups(features: Feature[]): Map<EclipseLayerKey, Feature[]> {
  const groups = new Map<EclipseLayerKey, Feature[]>();
  for (const feature of features) {
    const key = layerKeyForFeature(feature);
    if (!key) continue;
    const current = groups.get(key) ?? [];
    current.push(feature);
    groups.set(key, current);
  }
  return groups;
}

function globeLine(points: Position[]): Feature["geometry"] {
  const parts = splitLineAtAntimeridian(densifyGlobeLine(points));
  return parts.length === 1
    ? { type: "LineString", coordinates: parts[0]! }
    : { type: "MultiLineString", coordinates: parts };
}

function geometryLines(geometry: Geometry): Position[][] {
  switch (geometry.type) {
    case "Point":
      return [];
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
      return geometry.coordinates;
    case "Polygon":
      return geometry.coordinates;
    case "MultiPolygon":
      return geometry.coordinates.flat();
  }
}

function linesForFeatures(features: Feature[]): Position[][] {
  return features.flatMap((feature) =>
    geometryLines(feature.geometry)
      .filter((line) => line.length >= 2)
      .map((line) => densifyGlobeLine(line)),
  );
}

function pointsForFeatures(features: Feature[]): Position[] {
  return features.flatMap((feature) =>
    feature.geometry.type === "Point"
      ? [feature.geometry.coordinates]
      : [],
  );
}

function pathFeaturesForGlobe(scene: EclipseScene): Feature[] {
  const surface = scene.centralPath;
  if (!surface) return [];
  return toGeoJson(scene).features
    .filter((feature) => {
      const key = layerKeyForFeature(feature);
      return (
        key === "centralPath" ||
        key === "centerAndLimits" ||
        key === "timeMarkers"
      );
    })
    .map((feature) => {
    switch (feature.properties.feature_type) {
      case "central_path":
        return {
          ...feature,
          geometry: globeLine(
            surface.boundary.points.map((point) => [
              point.geographic.longitudeDeg,
              point.geographic.latitudeDeg,
            ]),
          ),
        };
      case "centerline":
        return {
          ...feature,
          geometry: globeLine(
            surface.centerline.points.map((point) => [
              point.geographic.longitudeDeg,
              point.geographic.latitudeDeg,
            ]),
          ),
        };
      case "positive_cross_track_limit":
        return {
          ...feature,
          geometry: globeLine(
            surface.limits.positiveCrossTrack.points.map((point) => [
              point.geographic.longitudeDeg,
              point.geographic.latitudeDeg,
            ]),
          ),
        };
      case "negative_cross_track_limit":
        return {
          ...feature,
          geometry: globeLine(
            surface.limits.negativeCrossTrack.points.map((point) => [
              point.geographic.longitudeDeg,
              point.geographic.latitudeDeg,
            ]),
          ),
        };
      default:
        return feature;
    }
  });
}

export class MapLibreGlobeRenderer implements EclipseRenderer {
  readonly id = "globe" as const;
  readonly map: MapLibreMap | null;
  private readonly container: HTMLElement;
  private readonly features: Record<EclipseLayerKey, Feature[]> = {
    centralPath: [],
    partialExtent: [],
    horizonLimits: [],
    contacts: [],
    localPenumbra: [],
    localCentralShadow: [],
    centerAndLimits: [],
    timeMarkers: [],
  };
  private readonly visibility: EclipseLayerVisibility = {
    ...DEFAULT_LAYER_VISIBILITY,
  };
  private readonly fillLayers: Partial<
    Record<EclipseLayerKey, GlobeFillLayer>
  > = {
    centralPath: new GlobeFillLayer(
      "central-path-fill",
      ECLIPSE_COLORS.centralPath,
      0.28,
      GLOBE_PATH_FILL_ELEVATION_METRES,
    ),
    localPenumbra: new GlobeFillLayer(
      "local-penumbra-fill",
      ECLIPSE_COLORS.penumbraFill,
      0.12,
    ),
    localCentralShadow: new GlobeFillLayer(
      "local-central-shadow-fill",
      ECLIPSE_COLORS.centralShadowFill,
      0.2,
    ),
  };
  private readonly lineLayers: Partial<
    Record<EclipseLayerKey, GlobeLineLayer>
  > = {
    centralPath: new GlobeLineLayer("globe-central-path-outline", {
      color: ECLIPSE_COLORS.centralPath,
      width: 1.5,
    }),
    partialExtent: new GlobeLineLayer("globe-partial-extent-line", {
      color: ECLIPSE_COLORS.extent,
      width: 2.25,
    }),
    horizonLimits: new GlobeLineLayer("globe-horizon-limits-line", {
      color: ECLIPSE_COLORS.horizon,
      width: 2,
    }),
    localPenumbra: new GlobeLineLayer("globe-local-penumbra-outline", {
      color: ECLIPSE_COLORS.penumbraLine,
      width: 1.25,
    }),
    localCentralShadow: new GlobeLineLayer(
      "globe-local-central-shadow-outline",
      {
        color: ECLIPSE_COLORS.centralShadowLine,
        width: 2,
      },
    ),
  };
  private readonly centreLineLayer = new GlobeLineLayer(
    "globe-centre-line",
    {
      color: ECLIPSE_COLORS.ink,
      width: 2.4,
      dash: [7.2, 6],
    },
  );
  private readonly limitLineLayer = new GlobeLineLayer(
    "globe-limit-lines",
    {
      color: ECLIPSE_COLORS.limits,
      width: 2,
    },
  );
  private readonly pointLayers: Partial<
    Record<EclipseLayerKey, GlobePointLayer>
  > = {
    contacts: new GlobePointLayer("globe-contacts-circle", {
      color: ECLIPSE_COLORS.contact,
      radius: 5,
      strokeColor: "#ffffff",
      strokeWidth: 1.5,
    }),
    timeMarkers: new GlobePointLayer("globe-time-markers-circle", {
      color: ECLIPSE_COLORS.ink,
      radius: 4,
      strokeColor: "#ffffff",
      strokeWidth: 2,
    }),
  };
  private readonly peakPointLayer = new GlobePointLayer(
    "globe-eclipse-peak-circle",
    {
      color: ECLIPSE_COLORS.limits,
      radius: 7,
      strokeColor: "#ffffff",
      strokeWidth: 2,
    },
  );
  private readonly observerPointLayer = new GlobePointLayer(
    "globe-eclipse-observer-circle",
    {
      color: ECLIPSE_COLORS.observer,
      radius: 7,
      strokeColor: "#ffffff",
      strokeWidth: 2,
    },
  );
  private ready = false;
  private peakCoordinate: Position | null = null;
  private observerCoordinate: Position | null = null;
  private readonly resizeObserver: ResizeObserver | null;
  onLocation?: (observer: Observer) => void;

  constructor(container: HTMLElement) {
    this.container = container;
    container.dataset.projection = "globe";
    let map: MapLibreMap | null = null;
    try {
      map = new maplibregl.Map({
        container,
        style: GLOBE_STYLE,
        center: [0, 20],
        zoom: 0.45,
        attributionControl: { compact: true },
        maxZoom: 19,
      });
      map.addControl(
        new maplibregl.NavigationControl({
          showCompass: true,
          showZoom: true,
          visualizePitch: true,
        }),
        "top-right",
      );
      map.on("load", () => {
        this.ready = true;
        map!.setProjection({ type: "globe" });
        this.installEclipseLayers(map!);
        this.flushAllSources();
        this.setPointSource("eclipse-peak", this.peakCoordinate);
        this.setPointSource("eclipse-observer", this.observerCoordinate);
        this.applyVisibility();
        container.dataset.rendererReady = "true";
      });
      map.on("click", (event) => {
        // Tiled GeoJSON is retained for ordinary-latitude feature picking,
        // but MapLibre clamps that source at the Web-Mercator limit. Never
        // attach a polar popup to the wrong, clamped screen position.
        const feature =
          this.ready &&
          Math.abs(event.lngLat.lat) <= WEB_MERCATOR_MAX_LATITUDE
          ? map!.queryRenderedFeatures(event.point, {
              layers: Object.values(LAYER_IDS).flat(),
            })[0]
          : undefined;
        if (feature) {
          new maplibregl.Popup()
            .setLngLat(event.lngLat)
            .setHTML(popupForFeature(feature as unknown as Feature))
            .addTo(map!);
        }
        const observer = {
          latitudeDeg: event.lngLat.lat,
          longitudeDeg: normalizeLongitude(event.lngLat.lng),
          elevationMeters: 0,
        };
        this.setLocation(observer);
        this.onLocation?.(observer);
      });
      map.getCanvas().addEventListener("webglcontextlost", () => {
        this.showError(
          "The globe lost its WebGL context. The two Leaflet views remain available.",
        );
      });
    } catch (error) {
      this.showError(
        `The globe is unavailable because WebGL could not start${
          error instanceof Error ? `: ${error.message}` : "."
        }`,
      );
    }
    this.map = map;
    this.resizeObserver = map
      ? new ResizeObserver(() => map?.resize())
      : null;
    this.resizeObserver?.observe(container);
  }

  private showError(message: string): void {
    this.container.dataset.rendererReady = "false";
    let element = this.container.querySelector<HTMLElement>(".renderer-error");
    if (!element) {
      element = document.createElement("div");
      element.className = "renderer-error";
      element.setAttribute("role", "status");
      this.container.append(element);
    }
    element.textContent = message;
  }

  private installEclipseLayers(map: MapLibreMap): void {
    for (const key of ECLIPSE_LAYER_KEYS) {
      map.addSource(SOURCE_IDS[key], {
        type: "geojson",
        data: EMPTY_COLLECTION as never,
      });
    }
    map.addSource("eclipse-peak", {
      type: "geojson",
      data: EMPTY_COLLECTION as never,
    });
    map.addSource("eclipse-observer", {
      type: "geojson",
      data: EMPTY_COLLECTION as never,
    });

    map.addLayer(this.fillLayers.localPenumbra!);
    map.addLayer({
      id: "local-penumbra-outline",
      type: "line",
      source: SOURCE_IDS.localPenumbra,
      paint: {
        "line-color": ECLIPSE_COLORS.penumbraLine,
        "line-width": 1.25,
        "line-opacity": 0,
      },
    });
    map.addLayer(this.fillLayers.centralPath!);
    map.addLayer({
      id: "central-path-outline",
      type: "line",
      source: SOURCE_IDS.centralPath,
      paint: {
        "line-color": ECLIPSE_COLORS.centralPath,
        "line-width": 1.5,
        "line-opacity": 0,
      },
    });
    map.addLayer(this.fillLayers.localCentralShadow!);
    map.addLayer({
      id: "local-central-shadow-outline",
      type: "line",
      source: SOURCE_IDS.localCentralShadow,
      paint: {
        "line-color": ECLIPSE_COLORS.centralShadowLine,
        "line-width": 2,
        "line-opacity": 0,
      },
    });
    map.addLayer({
      id: "partial-extent-line",
      type: "line",
      source: SOURCE_IDS.partialExtent,
      paint: {
        "line-color": ECLIPSE_COLORS.extent,
        "line-width": 2.25,
        "line-opacity": 0,
      },
    });
    map.addLayer({
      id: "horizon-limits-line",
      type: "line",
      source: SOURCE_IDS.horizonLimits,
      paint: {
        "line-color": ECLIPSE_COLORS.horizon,
        "line-width": 2,
        "line-opacity": 0,
      },
    });
    map.addLayer({
      id: "centre-line",
      type: "line",
      source: SOURCE_IDS.centerAndLimits,
      filter: ["==", ["get", "feature_type"], "centerline"],
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": ECLIPSE_COLORS.ink,
        "line-width": 2.4,
        "line-dasharray": [3, 2.5],
        "line-opacity": 0,
      },
    });
    map.addLayer({
      id: "limit-lines",
      type: "line",
      source: SOURCE_IDS.centerAndLimits,
      filter: ["in", ["get", "feature_type"], ["literal", [
        "positive_cross_track_limit",
        "negative_cross_track_limit",
      ]]],
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": ECLIPSE_COLORS.limits,
        "line-width": 2,
        "line-opacity": 0,
      },
    });
    map.addLayer({
      id: "time-markers-circle",
      type: "circle",
      source: SOURCE_IDS.timeMarkers,
      paint: {
        "circle-radius": 4,
        "circle-color": ECLIPSE_COLORS.ink,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
        "circle-opacity": 0,
        "circle-stroke-opacity": 0,
      },
    });
    map.addLayer({
      id: "contacts-circle",
      type: "circle",
      source: SOURCE_IDS.contacts,
      paint: {
        "circle-radius": 5,
        "circle-color": ECLIPSE_COLORS.contact,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1.5,
        "circle-opacity": 0,
        "circle-stroke-opacity": 0,
      },
    });
    map.addLayer({
      id: "eclipse-peak-circle",
      type: "circle",
      source: "eclipse-peak",
      paint: {
        "circle-radius": 7,
        "circle-color": ECLIPSE_COLORS.limits,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
        "circle-opacity": 0,
        "circle-stroke-opacity": 0,
      },
    });
    map.addLayer({
      id: "eclipse-observer-circle",
      type: "circle",
      source: "eclipse-observer",
      paint: {
        "circle-radius": 7,
        "circle-color": ECLIPSE_COLORS.observer,
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
        "circle-opacity": 0,
        "circle-stroke-opacity": 0,
      },
    });
    for (const layer of Object.values(this.lineLayers)) {
      if (layer) map.addLayer(layer);
    }
    map.addLayer(this.centreLineLayer);
    map.addLayer(this.limitLineLayer);
    for (const layer of Object.values(this.pointLayers)) {
      if (layer) map.addLayer(layer);
    }
    map.addLayer(this.peakPointLayer);
    map.addLayer(this.observerPointLayer);
  }

  private setFeatures(
    key: EclipseLayerKey,
    features: Feature[],
    updateFill = true,
  ): void {
    if (updateFill) this.fillLayers[key]?.setFeatures(features);
    this.lineLayers[key]?.setLines(linesForFeatures(features));
    this.pointLayers[key]?.setPositions(pointsForFeatures(features));
    if (key === "centerAndLimits") {
      this.centreLineLayer.setLines(
        linesForFeatures(
          features.filter(
            (feature) => feature.properties.feature_type === "centerline",
          ),
        ),
      );
      this.limitLineLayer.setLines(
        linesForFeatures(
          features.filter(
            (feature) =>
              feature.properties.feature_type ===
                "positive_cross_track_limit" ||
              feature.properties.feature_type ===
                "negative_cross_track_limit",
          ),
        ),
      );
    }
    this.features[key] = features.map((feature) => {
      if (
        feature.geometry.type === "Polygon" ||
        feature.geometry.type === "MultiPolygon"
      ) {
        return {
          ...feature,
          geometry: geometryForGlobe(feature.geometry),
        };
      }
      return feature;
    });
    this.flushSource(key);
  }

  private flushSource(key: EclipseLayerKey): void {
    if (!this.ready || !this.map) return;
    const source = this.map.getSource(SOURCE_IDS[key]) as
      | GeoJSONSource
      | undefined;
    source?.setData(collection(this.features[key]) as never);
  }

  private flushAllSources(): void {
    for (const key of ECLIPSE_LAYER_KEYS) this.flushSource(key);
  }

  private setPointSource(
    sourceId: "eclipse-peak" | "eclipse-observer",
    position: Position | null,
  ): void {
    const customLayer =
      sourceId === "eclipse-peak"
        ? this.peakPointLayer
        : this.observerPointLayer;
    customLayer.setPositions(position ? [position] : []);
    if (!this.ready || !this.map) return;
    const features: Feature[] = position
      ? [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: position },
            properties: {},
          },
        ]
      : [];
    const source = this.map.getSource(sourceId) as GeoJSONSource | undefined;
    source?.setData(collection(features) as never);
  }

  private applyVisibility(): void {
    if (!this.ready || !this.map) return;
    for (const key of ECLIPSE_LAYER_KEYS) {
      this.fillLayers[key]?.setVisible(this.visibility[key]);
      this.lineLayers[key]?.setVisible(this.visibility[key]);
      this.pointLayers[key]?.setVisible(this.visibility[key]);
      if (key === "centerAndLimits") {
        this.centreLineLayer.setVisible(this.visibility[key]);
        this.limitLineLayer.setVisible(this.visibility[key]);
      }
      for (const layerId of LAYER_IDS[key]) {
        this.map.setLayoutProperty(
          layerId,
          "visibility",
          this.visibility[key] ? "visible" : "none",
        );
      }
      this.container.dataset[
        `layer${key.charAt(0).toUpperCase()}${key.slice(1)}`
      ] = String(this.visibility[key]);
    }
  }

  private centreGlobe(): void {
    if (!this.ready || !this.map || !this.peakCoordinate) return;
    this.map.easeTo({
      center: this.peakCoordinate,
      zoom: 0.45,
      pitch: 0,
      duration: 0,
    });
  }

  showPath(scene: EclipseScene): void {
    this.clearPath();
    if (!scene.centralPath) return;
    const features = pathFeaturesForGlobe(scene);
    this.container.dataset.pathFeatureCount =
      String(features.length);
    this.peakCoordinate = scene.event.peakLocation
      ? [
          scene.event.peakLocation.longitudeDeg,
          scene.event.peakLocation.latitudeDeg,
        ]
      : null;
    const groups = featureGroups(features);
    for (const [key, features] of groups) {
      this.setFeatures(key, features, key !== "centralPath");
    }
    this.fillLayers.centralPath?.setPathSurface(scene.centralPath);
  }

  showGlobalVisibility(
    scene: EclipseScene | null,
  ): void {
    this.clearGlobalVisibility();
    if (!scene) return;
    const serialized = toGeoJson(scene).features.filter((feature) => {
      const key = layerKeyForFeature(feature);
      return (
        key === "partialExtent" ||
        key === "horizonLimits" ||
        key === "contacts"
      );
    });
    this.container.dataset.globalFeatureCount =
      String(serialized.length);
    if (!this.peakCoordinate) {
      const contact = scene.contacts[0];
      this.peakCoordinate = contact
        ? [
            contact.point.geographic.longitudeDeg,
            contact.point.geographic.latitudeDeg,
          ]
        : null;
    }
    const groups = featureGroups(serialized);
    for (const [key, features] of groups) this.setFeatures(key, features);
    this.lineLayers.partialExtent?.setLines(
      scene.globalVisibility.extent.map((curve) =>
        densifyGlobeLine(
          curve.points.map((point) => [
            point.geographic.longitudeDeg,
            point.geographic.latitudeDeg,
          ]),
        ),
      ),
    );
    this.lineLayers.horizonLimits?.setLines(
      scene.globalVisibility.horizon.map((curve) =>
        densifyGlobeLine(
          curve.points.map((point) => [
            point.geographic.longitudeDeg,
            point.geographic.latitudeDeg,
          ]),
        ),
      ),
    );
  }

  showPeak(
    latitudeDeg: number | undefined,
    longitudeDeg: number | undefined,
  ): void {
    this.peakCoordinate =
      latitudeDeg === undefined || longitudeDeg === undefined
        ? null
        : [longitudeDeg, latitudeDeg];
    this.setPointSource("eclipse-peak", this.peakCoordinate);
  }

  showShadowOutline(scene: EclipseScene | null): void {
    this.clearShadowOutline();
    if (!scene) return;
    const shadow = scene.instantaneousShadows[0];
    if (!shadow) return;
    const serialized = toGeoJson(scene).features.filter((feature) => {
      const key = layerKeyForFeature(feature);
      return (
        key === "localPenumbra" ||
        key === "localCentralShadow"
      );
    });
    this.container.dataset.shadowFeatureCount =
      String(serialized.length);
    const groups = featureGroups(serialized);
    for (const [key, features] of groups) {
      this.setFeatures(key, features, false);
    }
    this.lineLayers.localPenumbra?.setLines(
      shadow.penumbra.rings.map((ring) =>
        densifyGlobeLine(
          ring.points.map((point) => [
            point.geographic.longitudeDeg,
            point.geographic.latitudeDeg,
          ]),
        ),
      ),
    );
    this.fillLayers.localPenumbra?.setSurfaceRegion(shadow.penumbra);
    if (shadow.central) {
      this.lineLayers.localCentralShadow?.setLines(
        shadow.central.region.rings.map((ring) =>
          densifyGlobeLine(
            ring.points.map((point) => [
              point.geographic.longitudeDeg,
              point.geographic.latitudeDeg,
            ]),
          ),
        ),
      );
      this.fillLayers.localCentralShadow?.setSurfaceRegion(
        shadow.central.region,
      );
    }
  }

  clearShadowOutline(): void {
    this.container.dataset.shadowFeatureCount = "0";
    this.setFeatures("localPenumbra", []);
    this.setFeatures("localCentralShadow", []);
  }

  clearGlobalVisibility(): void {
    this.container.dataset.globalFeatureCount = "0";
    this.setFeatures("partialExtent", []);
    this.setFeatures("horizonLimits", []);
    this.setFeatures("contacts", []);
  }

  clearPath(): void {
    this.container.dataset.pathFeatureCount = "0";
    this.clearShadowOutline();
    this.clearGlobalVisibility();
    this.setFeatures("centralPath", []);
    this.setFeatures("centerAndLimits", []);
    this.setFeatures("timeMarkers", []);
  }

  fitPath(): void {
    this.centreGlobe();
  }

  fitGlobalVisibility(): void {
    this.centreGlobe();
  }

  setLocation(observer: Observer): void {
    this.observerCoordinate = [
      normalizeLongitude(observer.longitudeDeg),
      observer.latitudeDeg,
    ];
    this.container.dataset.selectedLatitude =
      observer.latitudeDeg.toFixed(5);
    this.container.dataset.selectedLongitude =
      this.observerCoordinate[0].toFixed(5);
    this.setPointSource("eclipse-observer", this.observerCoordinate);
  }

  setLayerVisibility(visibility: EclipseLayerVisibility): void {
    Object.assign(this.visibility, visibility);
    this.applyVisibility();
  }
}
