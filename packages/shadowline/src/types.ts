export type EclipseKind = "partial" | "annular" | "total" | "hybrid";

export interface GeographicPoint {
  latitudeDeg: number;
  longitudeDeg: number;
}

export interface Observer extends GeographicPoint {
  elevationMeters?: number;
}

export interface DateRange {
  startUtc: string;
  endUtc: string;
}

export interface ProviderMetadata {
  id: string;
  name: string;
  version: string;
  model: string;
  accuracy: "planning" | "research";
}

export interface EclipseSummary {
  id: string;
  kind: EclipseKind;
  peakUtc: string;
  peakLocation?: GeographicPoint;
  obscuration?: number;
  shadowAxisDistanceKm: number;
}

export interface EclipseContact {
  utc: string;
  sunAltitudeDeg: number;
  sunAzimuthDeg: number;
}

export interface LocalEclipse {
  kind: Exclude<EclipseKind, "hybrid">;
  obscuration: number;
  partialBegin: EclipseContact;
  centralBegin?: EclipseContact;
  peak: EclipseContact;
  centralEnd?: EclipseContact;
  partialEnd: EclipseContact;
}

export type CelestialBody =
  | "sun"
  | "moon"
  | "earth"
  | "earth-moon-barycentre"
  | "solar-system-barycentre";

export type ReferenceFrame =
  | "geocentric-equatorial-j2000"
  | "geocentric-earth-fixed"
  | "heliocentric-equatorial-j2000"
  | "barycentric-equatorial-j2000";

export interface CartesianVector {
  x: number;
  y: number;
  z: number;
}

export interface StateVector {
  body: CelestialBody;
  frame: ReferenceFrame;
  atUtc: string;
  positionAu: CartesianVector;
  velocityAuPerDay?: CartesianVector;
}

export interface HorizontalCoordinates {
  altitudeDeg: number;
  azimuthDeg: number;
}

/** The only capability required by the geometry solvers. */
export interface EarthFixedEphemeris {
  readonly metadata: ProviderMetadata;
  stateVector(
    body: "sun" | "moon",
    atUtc: string,
    frame: "geocentric-earth-fixed",
  ): StateVector;
}

export interface EclipseSearch {
  searchGlobalEclipses(range: DateRange): EclipseSummary[];
}

export interface ObserverCircumstances {
  searchLocalEclipses(observer: Observer, range: DateRange): LocalEclipse[];
  horizontalCoordinates(
    body: "sun" | "moon",
    atUtc: string,
    observer: Observer,
  ): HorizontalCoordinates;
}

export interface EclipseCapabilities {
  ephemeris: EarthFixedEphemeris;
  eclipseSearch?: EclipseSearch;
  observerCircumstances?: ObserverCircumstances;
}

export type EclipseCapability =
  | "eclipse-search"
  | "observer-circumstances";

export class EclipseCapabilityError extends Error {
  readonly name = "EclipseCapabilityError";

  constructor(readonly capability: EclipseCapability) {
    super(`The ${capability} capability is required for this operation.`);
  }
}

export interface SurfacePoint {
  /** Canonical WGS 84 Earth-fixed Cartesian position, in kilometres. */
  ecefKm: CartesianVector;
  /** Derived WGS 84 coordinates for display and serialization. */
  geographic: GeographicPoint;
}

export interface TimedSurfacePoint extends SurfacePoint {
  atUtc: string;
}

export interface SurfaceCurve<T extends SurfacePoint = SurfacePoint> {
  points: T[];
  closed?: boolean;
}

export interface SurfaceBoundarySegment {
  kind: "cone" | "solar-limb";
  curve: SurfaceCurve<SurfacePoint>;
}

export interface SurfaceRing extends SurfaceCurve<SurfacePoint> {
  closed: true;
  segments: SurfaceBoundarySegment[];
}

export interface SurfaceRegion {
  rings: SurfaceRing[];
}

export type Position = [longitudeDeg: number, latitudeDeg: number];

export type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] }
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Feature {
  type: "Feature";
  id?: string;
  geometry: Geometry;
  properties: Record<string, JsonValue>;
}

export interface EclipseFeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
  metadata: {
    schemaVersion: "2.0.0";
    eventId: string;
    eventKind: EclipseKind;
    peakUtc: string;
    provider: ProviderMetadata;
    datum: "WGS 84";
  };
}

export interface PathOptions {
  /** Maximum spacing between returned samples. */
  sampleIntervalSeconds?: number;
}

export interface TimeMarkerOptions {
  intervalMinutes?: number;
}

export interface CentralPathStrip {
  edges: [
    SurfaceCurve<TimedSurfacePoint>,
    SurfaceCurve<TimedSurfacePoint>,
  ];
}

export interface CentralPathSurface {
  datum: "WGS 84";
  calculationFrame: "geocentric-earth-fixed";
  kind: Exclude<EclipseKind, "partial">;
  centralBeginUtc: string;
  centralEndUtc: string;
  centerline: SurfaceCurve<TimedSurfacePoint>;
  limits: {
    positiveCrossTrack: SurfaceCurve<TimedSurfacePoint>;
    negativeCrossTrack: SurfaceCurve<TimedSurfacePoint>;
  };
  startCap: CentralPathStrip;
  endCap: CentralPathStrip;
  boundary: SurfaceCurve<SurfacePoint>;
}

export type InstantaneousShadowKind = "umbra" | "antumbra" | "penumbra";

export interface ShadowOutlineOptions {
  /** Maximum angular spacing between returned boundary samples. */
  angularIntervalDegrees?: number;
}

export interface InstantaneousCentralShadow {
  kind: Exclude<InstantaneousShadowKind, "penumbra">;
  region: SurfaceRegion;
}

export interface InstantaneousShadowSurface {
  datum: "WGS 84";
  calculationFrame: "geocentric-earth-fixed";
  atUtc: string;
  penumbra: SurfaceRegion;
  central: InstantaneousCentralShadow | null;
}

export type PenumbralContactKind = "P1" | "P2" | "P3" | "P4";

export interface PenumbralContact {
  kind: PenumbralContactKind;
  utc: string;
  point: SurfacePoint;
}

export interface GlobalVisibilityOptions {
  /** Maximum spacing between returned samples. */
  sampleIntervalSeconds?: number;
  /** Maximum angular spacing used for returned horizon samples. */
  angularIntervalDegrees?: number;
}

export interface PenumbralVisibilitySurface {
  datum: "WGS 84";
  calculationFrame: "geocentric-earth-fixed";
  extent: SurfaceCurve<TimedSurfacePoint>[];
  horizon: SurfaceCurve<TimedSurfacePoint>[];
}

export interface GlobalVisibilityResult {
  surface: PenumbralVisibilitySurface;
  contacts: PenumbralContact[];
}

export interface TimeMarker {
  point: TimedSurfacePoint;
  sunAltitudeDeg: number;
  sunAzimuthDeg: number;
  pathWidthKm: number;
  centralDurationSeconds?: number;
  eclipseKind: "total" | "annular";
}

export interface CalculateEventOptions {
  centralPath?: boolean;
  globalVisibility?: boolean;
  instantaneousAtUtc?: string[];
  timeMarkers?: boolean | TimeMarkerOptions;
  path?: PathOptions;
  visibility?: GlobalVisibilityOptions;
  shadow?: ShadowOutlineOptions;
}

export interface EclipseScene {
  event: EclipseSummary;
  provider: ProviderMetadata;
  centralPath: CentralPathSurface | null;
  globalVisibility: PenumbralVisibilitySurface;
  instantaneousShadows: InstantaneousShadowSurface[];
  contacts: PenumbralContact[];
  timeMarkers: TimeMarker[];
}

export interface GeoJsonOptions {
  seam?: "split" | "unsplit";
  latitudeClipDeg?: number;
}

export interface ExportedEclipse {
  filename: string;
  mimeType: string;
  contents: string | Uint8Array;
}

export interface EclipseExporter {
  readonly id: string;
  readonly extension: string;
  readonly mimeType: string;
  export(scene: EclipseScene, options?: GeoJsonOptions): ExportedEclipse;
}
