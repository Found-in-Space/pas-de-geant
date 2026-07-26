import * as Astronomy from "astronomy-engine";
import {
  normalizeLongitude,
  toIsoUtc,
  type CartesianVector,
  type CelestialBody,
  type DateRange,
  type EclipseContact,
  type EclipseCapabilities,
  type EclipseKind,
  type EclipseSearch,
  type EclipseSummary,
  type EarthFixedEphemeris,
  type HorizontalCoordinates,
  type LocalEclipse,
  type Observer,
  type ObserverCircumstances,
  type ProviderMetadata,
  type ReferenceFrame,
  type StateVector,
} from "@found-in-space/shadowline";

const VERSION = "2.1.19";
const astronomyNamespace = Astronomy as unknown as Record<string, unknown>;
const AstronomyRuntime = (
  typeof astronomyNamespace["SearchGlobalSolarEclipse"] === "function"
    ? astronomyNamespace
    : astronomyNamespace["default"]
) as typeof Astronomy;
const {
  BaryState,
  Body,
  EclipseKind: AstronomyEclipseKind,
  Equator,
  GeoMoonState,
  GeoVector,
  HelioState,
  Horizon,
  MakeTime,
  NextGlobalSolarEclipse,
  NextLocalSolarEclipse,
  Observer: AstronomyObserver,
  RotateVector,
  Rotation_EQJ_EQD,
  SearchGlobalSolarEclipse,
  SearchLocalSolarEclipse,
  SiderealTime,
  Vector,
} = AstronomyRuntime;

function astronomyBody(body: CelestialBody): Astronomy.Body {
  switch (body) {
    case "sun":
      return Body.Sun;
    case "moon":
      return Body.Moon;
    case "earth":
      return Body.Earth;
    case "earth-moon-barycentre":
      return Body.EMB;
    case "solar-system-barycentre":
      return Body.SSB;
  }
}

function eclipseKind(
  kind: Astronomy.EclipseKind,
): Exclude<EclipseKind, "hybrid"> {
  switch (kind) {
    case AstronomyEclipseKind.Partial:
      return "partial";
    case AstronomyEclipseKind.Annular:
      return "annular";
    case AstronomyEclipseKind.Total:
      return "total";
    default:
      throw new Error(`Unsupported solar eclipse kind: ${String(kind)}`);
  }
}

function eventId(event: Astronomy.GlobalSolarEclipseInfo): string {
  const date = event.peak.date.toISOString().slice(0, 10);
  return `solar-${date}-${eclipseKind(event.kind)}`;
}

function globalEvent(event: Astronomy.GlobalSolarEclipseInfo): EclipseSummary {
  const location =
    event.latitude === undefined || event.longitude === undefined
      ? undefined
      : {
          latitudeDeg: event.latitude,
          longitudeDeg: normalizeLongitude(event.longitude),
        };
  return {
    id: eventId(event),
    kind: eclipseKind(event.kind),
    peakUtc: toIsoUtc(event.peak.date),
    ...(location ? { peakLocation: location } : {}),
    ...(event.obscuration === undefined
      ? {}
      : { obscuration: event.obscuration }),
    shadowAxisDistanceKm: event.distance,
  };
}

function contact(
  event: Astronomy.EclipseEvent,
  observer: Observer,
): EclipseContact {
  const location = astronomyObserver(observer);
  const equatorial = Equator(
    Body.Sun,
    event.time.date,
    location,
    true,
    true,
  );
  const horizontal = Horizon(
    event.time.date,
    location,
    equatorial.ra,
    equatorial.dec,
    "normal",
  );
  return {
    utc: toIsoUtc(event.time.date),
    sunAltitudeDeg: event.altitude,
    sunAzimuthDeg: horizontal.azimuth,
  };
}

function localEvent(
  event: Astronomy.LocalSolarEclipseInfo,
  observer: Observer,
): LocalEclipse {
  return {
    kind: eclipseKind(event.kind),
    obscuration: event.obscuration,
    partialBegin: contact(event.partial_begin, observer),
    ...(event.total_begin
      ? { centralBegin: contact(event.total_begin, observer) }
      : {}),
    peak: contact(event.peak, observer),
    ...(event.total_end
      ? { centralEnd: contact(event.total_end, observer) }
      : {}),
    partialEnd: contact(event.partial_end, observer),
  };
}

function vector(value: {
  x: number;
  y: number;
  z: number;
}): CartesianVector {
  return { x: value.x, y: value.y, z: value.z };
}

function velocity(value: Astronomy.StateVector): CartesianVector {
  return { x: value.vx, y: value.vy, z: value.vz };
}

function rotateEarthFixed(
  position: CartesianVector,
  at: Date,
): CartesianVector {
  const eqj = new Vector(position.x, position.y, position.z, MakeTime(at));
  const eqd = RotateVector(Rotation_EQJ_EQD(at), eqj);
  const angle = (SiderealTime(at) * 15 * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: cosine * eqd.x + sine * eqd.y,
    y: -sine * eqd.x + cosine * eqd.y,
    z: eqd.z,
  };
}

function finiteDifferenceGeoVelocity(
  body: Astronomy.Body,
  at: Date,
): CartesianVector {
  const stepSeconds = 30;
  const before = GeoVector(
    body,
    new Date(at.getTime() - stepSeconds * 1000),
    true,
  );
  const after = GeoVector(
    body,
    new Date(at.getTime() + stepSeconds * 1000),
    true,
  );
  const factor = (24 * 60 * 60) / (2 * stepSeconds);
  return {
    x: (after.x - before.x) * factor,
    y: (after.y - before.y) * factor,
    z: (after.z - before.z) * factor,
  };
}

function geocentricState(body: CelestialBody, at: Date): StateVector {
  if (body === "earth") {
    return {
      body,
      frame: "geocentric-equatorial-j2000",
      atUtc: toIsoUtc(at),
      positionAu: { x: 0, y: 0, z: 0 },
      velocityAuPerDay: { x: 0, y: 0, z: 0 },
    };
  }
  if (body === "moon") {
    const state = GeoMoonState(at);
    return {
      body,
      frame: "geocentric-equatorial-j2000",
      atUtc: toIsoUtc(at),
      positionAu: vector(state),
      velocityAuPerDay: velocity(state),
    };
  }
  if (body === "sun") {
    const position = GeoVector(Body.Sun, at, true);
    return {
      body,
      frame: "geocentric-equatorial-j2000",
      atUtc: toIsoUtc(at),
      positionAu: vector(position),
      velocityAuPerDay: finiteDifferenceGeoVelocity(Body.Sun, at),
    };
  }
  throw new RangeError(
    `Body ${body} is not available in the geocentric frame.`,
  );
}

function fromAstronomyState(
  body: CelestialBody,
  frame: ReferenceFrame,
  state: Astronomy.StateVector,
): StateVector {
  return {
    body,
    frame,
    atUtc: toIsoUtc(state.t.date),
    positionAu: vector(state),
    velocityAuPerDay: velocity(state),
  };
}

function astronomyObserver(observer: Observer): Astronomy.Observer {
  return new AstronomyObserver(
    observer.latitudeDeg,
    observer.longitudeDeg,
    observer.elevationMeters ?? 0,
  );
}

export class AstronomyEngineProvider
  implements
    EarthFixedEphemeris,
    EclipseSearch,
    ObserverCircumstances
{
  readonly metadata: ProviderMetadata = {
    id: "astronomy-engine",
    name: "Astronomy Engine",
    version: VERSION,
    model: "VSOP87/NOVAS-derived compact ephemeris; centre-of-figure Moon",
    accuracy: "planning",
  };

  searchGlobalEclipses(range: DateRange): EclipseSummary[] {
    const start = new Date(range.startUtc);
    const end = new Date(range.endUtc);
    const events: EclipseSummary[] = [];
    let event = SearchGlobalSolarEclipse(start);
    while (event.peak.date < end) {
      if (event.peak.date >= start) {
        events.push(globalEvent(event));
      }
      event = NextGlobalSolarEclipse(event.peak);
    }
    return events;
  }

  searchLocalEclipses(observer: Observer, range: DateRange): LocalEclipse[] {
    const start = new Date(range.startUtc);
    const end = new Date(range.endUtc);
    const location = astronomyObserver(observer);
    const events: LocalEclipse[] = [];
    let event = SearchLocalSolarEclipse(start, location);
    while (event.peak.time.date < end) {
      if (event.peak.time.date >= start) {
        events.push(localEvent(event, observer));
      }
      event = NextLocalSolarEclipse(event.peak.time, location);
    }
    return events;
  }

  stateVector(
    body: CelestialBody,
    atUtc: string,
    frame: ReferenceFrame,
  ): StateVector {
    const at = new Date(atUtc);
    if (!Number.isFinite(at.getTime())) {
      throw new RangeError(`Invalid state-vector time: ${atUtc}`);
    }
    if (
      frame === "geocentric-equatorial-j2000" ||
      frame === "geocentric-earth-fixed"
    ) {
      const state = geocentricState(body, at);
      if (frame === "geocentric-equatorial-j2000") {
        return state;
      }
      return {
        body,
        frame,
        atUtc: state.atUtc,
        positionAu: rotateEarthFixed(state.positionAu, at),
      };
    }
    const source =
      frame === "heliocentric-equatorial-j2000"
        ? HelioState(astronomyBody(body), at)
        : BaryState(astronomyBody(body), at);
    return fromAstronomyState(body, frame, source);
  }

  horizontalCoordinates(
    body: CelestialBody,
    atUtc: string,
    observer: Observer,
  ): HorizontalCoordinates {
    const at = new Date(atUtc);
    const location = astronomyObserver(observer);
    const equatorial = Equator(
      astronomyBody(body),
      at,
      location,
      true,
      true,
    );
    const horizontal = Horizon(
      at,
      location,
      equatorial.ra,
      equatorial.dec,
      "normal",
    );
    return {
      altitudeDeg: horizontal.altitude,
      azimuthDeg: horizontal.azimuth,
    };
  }
}

export function astronomyEngineCapabilities(
  provider = new AstronomyEngineProvider(),
): EclipseCapabilities {
  return {
    ephemeris: provider,
    eclipseSearch: provider,
    observerCircumstances: provider,
  };
}
