import L, {
  type GeoJSON as LeafletGeoJSON,
  type LeafletMouseEvent,
  type Map as LeafletMap,
} from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  normalizeLongitude,
  toGeoJson,
  type EclipseFeatureCollection,
  type EclipseScene,
  type Feature,
  type Geometry,
  type Observer,
} from "@found-in-space/shadowline";
import {
  clipForWebMercator,
  WEB_MERCATOR_MAX_LATITUDE,
} from "./web-mercator.js";
import {
  collectionForLeaflet,
  geometryForLeaflet,
} from "./display-geometry.js";
import {
  ECLIPSE_COLORS,
  layerKeyForFeature,
  popupForFeature,
} from "./feature-presentation.js";
import {
  DEFAULT_LAYER_VISIBILITY,
  type EclipseLayerKey,
  type EclipseLayerVisibility,
  type EclipseRenderer,
  type MapView,
} from "./renderer.js";

type LeafletProjection = "mercator" | "equirectangular";

interface LeafletRendererOptions {
  id: "mercator" | "world";
  projection: LeafletProjection;
  initialView: MapView;
  interactive: boolean;
}

function featureStyle(feature?: Feature): L.PathOptions {
  const type = feature?.properties.feature_type;
  if (type === "central_path") {
    return {
      color: ECLIPSE_COLORS.centralPath,
      weight: 1.5,
      stroke: false,
      fillColor: ECLIPSE_COLORS.centralPath,
      fillOpacity: 0.28,
      bubblingMouseEvents: false,
    };
  }
  if (type === "centerline") {
    return {
      color: ECLIPSE_COLORS.ink,
      weight: 2.4,
      dashArray: "7 6",
      opacity: 0.9,
      bubblingMouseEvents: false,
    };
  }
  return {
    color: ECLIPSE_COLORS.limits,
    weight: 2,
    opacity: 0.95,
    bubblingMouseEvents: false,
  };
}

function datasetLayerName(key: EclipseLayerKey): string {
  return `layer${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

class LeafletEclipseRenderer implements EclipseRenderer {
  readonly id: "mercator" | "world";
  readonly map: LeafletMap;
  readonly projection: LeafletProjection;
  private readonly container: HTMLElement;
  private readonly groups: Record<EclipseLayerKey, L.LayerGroup>;
  private displayLayer: LeafletGeoJSON | null = null;
  private globalDisplayLayer: L.FeatureGroup | null = null;
  private locationMarker: L.CircleMarker | null = null;
  private peakMarker: L.CircleMarker | null = null;
  private displayAnchorLongitude = 0;
  private readonly resizeObserver: ResizeObserver;
  onLocation?: (observer: Observer) => void;
  onViewChanged?: (view: MapView) => void;

  constructor(container: HTMLElement, options: LeafletRendererOptions) {
    this.id = options.id;
    this.projection = options.projection;
    this.container = container;
    const isWorld = this.projection === "equirectangular";
    this.map = L.map(container, {
      center: isWorld
        ? [0, 0]
        : [options.initialView.latitude, options.initialView.longitude],
      zoom: isWorld ? 0 : options.initialView.zoom,
      crs: isWorld ? L.CRS.EPSG4326 : L.CRS.EPSG3857,
      worldCopyJump: !isWorld,
      preferCanvas: true,
      zoomControl: options.interactive,
      dragging: options.interactive,
      touchZoom: options.interactive,
      scrollWheelZoom: options.interactive,
      doubleClickZoom: options.interactive,
      boxZoom: options.interactive,
      keyboard: options.interactive,
      zoomSnap: isWorld ? 0 : 1,
      attributionControl: true,
      maxBounds: isWorld
        ? [
            [-90, -180],
            [90, 180],
          ]
        : undefined,
    });

    if (isWorld) {
      L.tileLayer
        .wms(
          "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi",
          {
            layers: "BlueMarble_ShadedRelief_Bathymetry",
            format: "image/jpeg",
            transparent: false,
            version: "1.3.0",
            crs: L.CRS.EPSG4326,
            noWrap: true,
            bounds: [
              [-90, -180],
              [90, 180],
            ],
            maxZoom: 8,
            attribution:
              'Imagery <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
          },
        )
        .addTo(this.map);
    } else {
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(this.map);
      L.control.scale({ imperial: false, position: "bottomright" }).addTo(this.map);
    }

    this.groups = {
      centralPath: L.layerGroup(),
      partialExtent: L.layerGroup(),
      horizonLimits: L.layerGroup(),
      contacts: L.layerGroup(),
      localPenumbra: L.layerGroup(),
      localCentralShadow: L.layerGroup(),
      centerAndLimits: L.layerGroup(),
      timeMarkers: L.layerGroup(),
    };
    this.setLayerVisibility(DEFAULT_LAYER_VISIBILITY);

    this.map.on("click", (event: LeafletMouseEvent) => {
      this.selectLocation(event.latlng.lat, event.latlng.lng);
    });
    if (!isWorld) {
      this.map.on("moveend", () => {
        if (this.constrainMercatorView()) return;
        const center = this.map.getCenter();
        this.onViewChanged?.({
          latitude: center.lat,
          longitude: center.lng,
          zoom: this.map.getZoom(),
        });
      });
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.map.invalidateSize({ pan: false });
      if (isWorld) this.fitWholeEarth();
    });
    this.resizeObserver.observe(container);
    if (isWorld) {
      queueMicrotask(() => this.fitWholeEarth());
    }
    container.dataset.rendererReady = "true";
  }

  private constrainMercatorView(): boolean {
    if (this.projection !== "mercator") return false;
    // A polar track can touch the projection cap. Keep the camera inside the
    // finite Mercator world without restricting antimeridian-aware longitude.
    const size = this.map.getSize();
    const currentZoom = this.map.getZoom();
    const minimumCoveredZoom = Math.max(
      0,
      Math.ceil(Math.log2(size.y / 256)),
    );
    if (currentZoom < minimumCoveredZoom) {
      this.map.setZoom(minimumCoveredZoom, { animate: false });
      return true;
    }

    const center = this.map.getCenter();
    const centerPoint = this.map.project(center, currentZoom);
    const northY = this.map.project(
      [WEB_MERCATOR_MAX_LATITUDE, 0],
      currentZoom,
    ).y;
    const southY = this.map.project(
      [-WEB_MERCATOR_MAX_LATITUDE, 0],
      currentZoom,
    ).y;
    const minimumCenterY = northY + size.y / 2;
    const maximumCenterY = southY - size.y / 2;
    const constrainedCenterY = Math.max(
      minimumCenterY,
      Math.min(maximumCenterY, centerPoint.y),
    );
    if (Math.abs(constrainedCenterY - centerPoint.y) < 0.5) {
      return false;
    }
    this.map.setView(
      this.map.unproject(
        L.point(centerPoint.x, constrainedCenterY),
        currentZoom,
      ),
      currentZoom,
      { animate: false },
    );
    return true;
  }

  private fitWholeEarth(): void {
    this.map.fitBounds(
      [
        [-90, -180],
        [90, 180],
      ],
      { animate: false, padding: [0, 0] },
    );
  }

  private selectLocation(latitudeDeg: number, longitudeDeg: number): void {
    const observer = {
      latitudeDeg,
      longitudeDeg: normalizeLongitude(longitudeDeg),
      elevationMeters: 0,
    };
    this.setLocation(observer);
    this.onLocation?.(observer);
  }

  private selectLayerLocation(event: LeafletMouseEvent): void {
    L.DomEvent.stopPropagation(event.originalEvent);
    this.selectLocation(event.latlng.lat, event.latlng.lng);
  }

  private displayCollection<T extends { features: Feature[] }>(
    collection: T,
  ): Omit<T, "features"> & { features: Feature[] } {
    if (this.projection === "equirectangular") {
      return collection;
    }
    return clipForWebMercator(
      collectionForLeaflet(collection, this.displayAnchorLongitude),
    ) as unknown as Omit<T, "features"> & { features: Feature[] };
  }

  private displayGeometry(geometry: Geometry): Geometry {
    return this.projection === "equirectangular"
      ? geometry
      : geometryForLeaflet(geometry, this.displayAnchorLongitude);
  }

  showPath(scene: EclipseScene): void {
    this.clearPath();
    const collection = toGeoJson(scene);
    const pathFeatures = collection.features.filter((feature) => {
      const key = layerKeyForFeature(feature);
      return (
        key === "centralPath" ||
        key === "centerAndLimits" ||
        key === "timeMarkers"
      );
    });
    this.container.dataset.pathFeatureCount =
      String(pathFeatures.length);
    this.displayAnchorLongitude =
      scene.event.peakLocation?.longitudeDeg ?? 0;
    const display = this.displayCollection({
      ...collection,
      features: pathFeatures,
    });
    for (const feature of display.features) {
      const key = layerKeyForFeature(feature);
      if (!key) continue;
      const layer = L.geoJSON(feature as never, {
        style: () => featureStyle(feature),
        pointToLayer: (_feature, latlng) =>
          L.circleMarker(latlng, {
            radius: 4,
            color: "#fff",
            weight: 2,
            fillColor: ECLIPSE_COLORS.ink,
            fillOpacity: 1,
            bubblingMouseEvents: false,
          }),
        onEachFeature: (_current, currentLayer) => {
          currentLayer.bindPopup(popupForFeature(feature));
          currentLayer.on("click", (event: LeafletMouseEvent) => {
            this.selectLayerLocation(event);
          });
        },
      });
      layer.addTo(this.groups[key]);
      if (key === "centralPath") this.displayLayer = layer;
    }
  }

  showGlobalVisibility(
    scene: EclipseScene | null,
    anchorLongitude?: number,
  ): void {
    this.clearGlobalVisibility();
    if (!scene) return;
    const collection = toGeoJson(scene);
    const visibilityFeatures = collection.features.filter((feature) => {
      const key = layerKeyForFeature(feature);
      return (
        key === "partialExtent" ||
        key === "horizonLimits" ||
        key === "contacts"
      );
    });
    this.container.dataset.globalFeatureCount =
      String(visibilityFeatures.length);
    this.displayAnchorLongitude =
      anchorLongitude ??
      scene.event.peakLocation?.longitudeDeg ??
      scene.contacts[0]?.point.geographic.longitudeDeg ??
      0;
    const display = this.displayCollection({
      ...collection,
      features: visibilityFeatures,
    });
    this.globalDisplayLayer = L.featureGroup();
    for (const feature of display.features) {
      const key = layerKeyForFeature(feature);
      if (!key) continue;
      const isContact = key === "contacts";
      const isHorizon = key === "horizonLimits";
      const layer = L.geoJSON(feature as never, {
        style: isContact
          ? {
              color: "#fff",
              weight: 1.5,
              fillColor: ECLIPSE_COLORS.contact,
              fillOpacity: 1,
              bubblingMouseEvents: false,
            }
          : {
              color: isHorizon
                ? ECLIPSE_COLORS.horizon
                : ECLIPSE_COLORS.extent,
              weight: isHorizon ? 2 : 2.25,
              opacity: 0.95,
              fillOpacity: 0,
              bubblingMouseEvents: false,
            },
        pointToLayer: (_current, latlng) =>
          L.circleMarker(latlng, {
            radius: 5,
            color: "#fff",
            weight: 1.5,
            fillColor: ECLIPSE_COLORS.contact,
            fillOpacity: 1,
            bubblingMouseEvents: false,
          }),
        onEachFeature: (_current, currentLayer) => {
          currentLayer.bindPopup(popupForFeature(feature));
          currentLayer.on("click", (event: LeafletMouseEvent) => {
            this.selectLayerLocation(event);
          });
        },
      });
      layer.addTo(this.groups[key]);
      this.globalDisplayLayer.addLayer(layer);
    }
  }

  showPeak(
    latitudeDeg: number | undefined,
    longitudeDeg: number | undefined,
  ): void {
    this.peakMarker?.remove();
    this.peakMarker = null;
    if (latitudeDeg === undefined || longitudeDeg === undefined) return;
    this.displayAnchorLongitude = longitudeDeg;
    const displayPoint = this.displayGeometry({
      type: "Point",
      coordinates: [longitudeDeg, latitudeDeg],
    });
    if (displayPoint.type !== "Point") return;
    this.peakMarker = L.circleMarker(
      [displayPoint.coordinates[1], displayPoint.coordinates[0]],
      {
        radius: 7,
        color: "#fff",
        weight: 2,
        fillColor: ECLIPSE_COLORS.limits,
        fillOpacity: 1,
        bubblingMouseEvents: false,
      },
    )
      .bindTooltip("Global eclipse peak")
      .on("click", (event: LeafletMouseEvent) => {
        this.selectLayerLocation(event);
      })
      .addTo(this.map);
  }

  showShadowOutline(scene: EclipseScene | null): void {
    this.clearShadowOutline();
    if (!scene) return;
    const collection = toGeoJson(scene);
    const shadowFeatures = collection.features.filter((feature) => {
      const key = layerKeyForFeature(feature);
      return (
        key === "localPenumbra" ||
        key === "localCentralShadow"
      );
    });
    this.container.dataset.shadowFeatureCount =
      String(shadowFeatures.length);
    const display = this.displayCollection({
      ...collection,
      features: shadowFeatures,
    });
    for (const feature of display.features) {
      const key = layerKeyForFeature(feature);
      if (
        key !== "localPenumbra" &&
        key !== "localCentralShadow"
      ) {
        continue;
      }
      const isPenumbra = key === "localPenumbra";
      const layer = L.geoJSON(feature as never, {
        style: {
          color: isPenumbra
            ? ECLIPSE_COLORS.penumbraLine
            : ECLIPSE_COLORS.centralShadowLine,
          weight: isPenumbra ? 1.25 : 2,
          fillColor: isPenumbra
            ? ECLIPSE_COLORS.penumbraFill
            : ECLIPSE_COLORS.centralShadowFill,
          fillOpacity: isPenumbra ? 0.12 : 0.2,
          bubblingMouseEvents: false,
        },
        onEachFeature: (_current, currentLayer) => {
          currentLayer.bindPopup(popupForFeature(feature));
          currentLayer.on("click", (event: LeafletMouseEvent) => {
            this.selectLayerLocation(event);
          });
        },
      });
      layer.addTo(this.groups[key]);
    }
    this.groups.localPenumbra.eachLayer((layer) => {
      if ("bringToBack" in layer) {
        (layer as L.Path).bringToBack();
      }
    });
  }

  clearShadowOutline(): void {
    this.container.dataset.shadowFeatureCount = "0";
    this.groups.localPenumbra.clearLayers();
    this.groups.localCentralShadow.clearLayers();
  }

  clearGlobalVisibility(): void {
    this.container.dataset.globalFeatureCount = "0";
    this.groups.partialExtent.clearLayers();
    this.groups.horizonLimits.clearLayers();
    this.groups.contacts.clearLayers();
    this.globalDisplayLayer = null;
  }

  clearPath(): void {
    this.container.dataset.pathFeatureCount = "0";
    this.clearShadowOutline();
    this.clearGlobalVisibility();
    this.groups.centralPath.clearLayers();
    this.groups.centerAndLimits.clearLayers();
    this.groups.timeMarkers.clearLayers();
    this.displayLayer = null;
  }

  fitPath(): void {
    if (this.projection === "equirectangular") {
      this.fitWholeEarth();
    } else if (this.displayLayer) {
      this.map.fitBounds(this.displayLayer.getBounds(), {
        padding: [24, 24],
        animate: false,
      });
    }
  }

  fitGlobalVisibility(): void {
    if (this.projection === "equirectangular") {
      this.fitWholeEarth();
    } else if (this.globalDisplayLayer) {
      this.map.fitBounds(this.globalDisplayLayer.getBounds(), {
        padding: [24, 24],
        animate: false,
      });
    }
  }

  setLocation(observer: Observer): void {
    const canonicalLongitude = normalizeLongitude(observer.longitudeDeg);
    this.container.dataset.selectedLatitude =
      observer.latitudeDeg.toFixed(5);
    this.container.dataset.selectedLongitude =
      canonicalLongitude.toFixed(5);
    const displayPoint = this.displayGeometry({
      type: "Point",
      coordinates: [canonicalLongitude, observer.latitudeDeg],
    });
    if (displayPoint.type !== "Point") return;
    this.locationMarker?.remove();
    this.locationMarker = L.circleMarker(
      [displayPoint.coordinates[1], displayPoint.coordinates[0]],
      {
        radius: 7,
        color: "#fff",
        weight: 2,
        fillColor: ECLIPSE_COLORS.observer,
        fillOpacity: 1,
        bubblingMouseEvents: false,
      },
    )
      .bindTooltip("Checked location")
      .addTo(this.map);
  }

  setLayerVisibility(visibility: EclipseLayerVisibility): void {
    for (const [key, group] of Object.entries(this.groups ?? {}) as [
      EclipseLayerKey,
      L.LayerGroup,
    ][]) {
      const visible = visibility[key];
      if (visible && !this.map.hasLayer(group)) group.addTo(this.map);
      if (!visible && this.map.hasLayer(group)) group.removeFrom(this.map);
      this.container.dataset[datasetLayerName(key)] = String(visible);
    }
  }
}

export class LeafletMercatorRenderer extends LeafletEclipseRenderer {
  declare readonly id: "mercator";

  constructor(container: HTMLElement, initialView: MapView) {
    super(container, {
      id: "mercator",
      projection: "mercator",
      initialView,
      interactive: true,
    });
  }

  getView(): MapView {
    const center = this.map.getCenter();
    return {
      latitude: center.lat,
      longitude: center.lng,
      zoom: this.map.getZoom(),
    };
  }
}

export class LeafletEquirectangularRenderer extends LeafletEclipseRenderer {
  declare readonly id: "world";

  constructor(container: HTMLElement) {
    super(container, {
      id: "world",
      projection: "equirectangular",
      initialView: { latitude: 0, longitude: 0, zoom: 0 },
      interactive: false,
    });
  }
}

export function displayBounds(
  collection: EclipseFeatureCollection,
  anchorLongitude = 0,
): L.LatLngBounds {
  return L.geoJSON(
    clipForWebMercator(
      collectionForLeaflet(collection, anchorLongitude),
    ) as never,
  ).getBounds();
}
