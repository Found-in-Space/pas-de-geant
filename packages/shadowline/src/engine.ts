import {
  calculateCentralPath,
  calculateTimeMarkers,
  classifyCentralEclipse,
} from "./path.js";
import {
  calculateGlobalContacts,
  calculateGlobalVisibility,
} from "./global-visibility.js";
import { calculateInstantaneousShadow } from "./shadow.js";
import type {
  CalculateEventOptions,
  CentralPathSurface,
  DateRange,
  EclipseCapabilities,
  EclipseScene,
  EclipseSummary,
  GlobalVisibilityOptions,
  GlobalVisibilityResult,
  InstantaneousShadowSurface,
  LocalEclipse,
  Observer,
  PathOptions,
  PenumbralContact,
  PenumbralVisibilitySurface,
  ShadowOutlineOptions,
  TimeMarker,
  TimeMarkerOptions,
} from "./types.js";
import { EclipseCapabilityError } from "./types.js";

const MAXIMUM_LOCAL_WINDOW_YEARS = 200;

function validateObserver(observer: Observer): Observer {
  if (
    !Number.isFinite(observer.latitudeDeg) ||
    observer.latitudeDeg < -90 ||
    observer.latitudeDeg > 90
  ) {
    throw new RangeError("Latitude must be between -90 and 90 degrees.");
  }
  if (
    !Number.isFinite(observer.longitudeDeg) ||
    observer.longitudeDeg < -180 ||
    observer.longitudeDeg > 180
  ) {
    throw new RangeError(
      "Longitude must be between -180 and 180 degrees.",
    );
  }
  if (
    observer.elevationMeters !== undefined &&
    (!Number.isFinite(observer.elevationMeters) ||
      observer.elevationMeters < -500 ||
      observer.elevationMeters > 100_000)
  ) {
    throw new RangeError(
      "Elevation must be between -500 and 100000 metres.",
    );
  }
  return observer;
}

function validateRange(
  range: DateRange,
  maximumYears?: number,
): DateRange {
  const start = new Date(range.startUtc);
  const end = new Date(range.endUtc);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start >= end
  ) {
    throw new RangeError(
      "Date range must have valid increasing UTC bounds.",
    );
  }
  if (
    maximumYears !== undefined &&
    (end.getTime() - start.getTime()) /
      (365.2425 * 24 * 60 * 60 * 1000) >
      maximumYears
  ) {
    throw new RangeError(
      `Local eclipse searches are limited to ${maximumYears} years.`,
    );
  }
  return range;
}

function yearBoundary(year: number): string {
  if (!Number.isInteger(year)) {
    throw new RangeError("Year must be an integer.");
  }
  const value = new Date(0);
  value.setUTCFullYear(year, 0, 1);
  value.setUTCHours(0, 0, 0, 0);
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError(`Year is outside the supported date range: ${year}.`);
  }
  return value.toISOString();
}

function emptyVisibility(): PenumbralVisibilitySurface {
  return {
    datum: "WGS 84",
    calculationFrame: "geocentric-earth-fixed",
    extent: [],
    horizon: [],
  };
}

export class EclipseEngine {
  constructor(readonly capabilities: EclipseCapabilities) {}

  eventsForYear(year: number): EclipseSummary[] {
    return this.events({
      startUtc: yearBoundary(year),
      endUtc: yearBoundary(year + 1),
    });
  }

  events(range: DateRange): EclipseSummary[] {
    const validRange = validateRange(range);
    const search = this.capabilities.eclipseSearch;
    if (!search) throw new EclipseCapabilityError("eclipse-search");
    return search
      .searchGlobalEclipses(validRange)
      .map((event) => this.normalizeEvent(event));
  }

  private normalizeEvent(event: EclipseSummary): EclipseSummary {
    if (event.kind === "partial") return event;
    const kind = classifyCentralEclipse(
      this.capabilities.ephemeris,
      event,
    );
    if (kind === event.kind) return event;
    const suffix = `-${event.kind}`;
    return {
      ...event,
      id: event.id.endsWith(suffix)
        ? `${event.id.slice(0, -suffix.length)}-${kind}`
        : event.id,
      kind,
    };
  }

  localEclipses(
    observer: Observer,
    range: DateRange,
  ): LocalEclipse[] {
    const circumstances = this.capabilities.observerCircumstances;
    if (!circumstances) {
      throw new EclipseCapabilityError("observer-circumstances");
    }
    return circumstances.searchLocalEclipses(
      validateObserver(observer),
      validateRange(range, MAXIMUM_LOCAL_WINDOW_YEARS),
    );
  }

  localCircumstances(
    event: EclipseSummary,
    observer: Observer,
  ): LocalEclipse | null {
    const circumstances = this.capabilities.observerCircumstances;
    if (!circumstances) {
      throw new EclipseCapabilityError("observer-circumstances");
    }
    const peak = new Date(event.peakUtc).getTime();
    const candidates = circumstances.searchLocalEclipses(
      validateObserver(observer),
      {
        startUtc: new Date(
          peak - 36 * 60 * 60 * 1000,
        ).toISOString(),
        endUtc: new Date(
          peak + 36 * 60 * 60 * 1000,
        ).toISOString(),
      },
    );
    return (
      candidates.find(
        (candidate) =>
          Math.abs(
            new Date(candidate.peak.utc).getTime() - peak,
          ) <
          18 * 60 * 60 * 1000,
      ) ?? null
    );
  }

  calculateCentralPath(
    event: EclipseSummary,
    options?: PathOptions,
  ): CentralPathSurface {
    return calculateCentralPath(
      this.capabilities.ephemeris,
      event,
      options,
    );
  }

  calculateInstantaneousShadow(
    event: EclipseSummary,
    atUtc: string,
    options?: ShadowOutlineOptions,
  ): InstantaneousShadowSurface {
    return calculateInstantaneousShadow(
      this.capabilities.ephemeris,
      event,
      atUtc,
      options,
    );
  }

  calculateGlobalVisibility(
    event: EclipseSummary,
    options?: GlobalVisibilityOptions,
  ): GlobalVisibilityResult {
    return calculateGlobalVisibility(
      this.capabilities.ephemeris,
      event,
      options,
    );
  }

  calculateGlobalContacts(event: EclipseSummary): PenumbralContact[] {
    return calculateGlobalContacts(this.capabilities.ephemeris, event);
  }

  calculateTimeMarkers(
    event: EclipseSummary,
    path: CentralPathSurface,
    options?: TimeMarkerOptions,
  ): TimeMarker[] {
    const circumstances = this.capabilities.observerCircumstances;
    if (!circumstances) {
      throw new EclipseCapabilityError("observer-circumstances");
    }
    return calculateTimeMarkers(
      this.capabilities.ephemeris,
      circumstances,
      event,
      path,
      options,
    );
  }

  calculateEvent(
    event: EclipseSummary,
    options: CalculateEventOptions = {},
  ): EclipseScene {
    const includeCentral = options.centralPath ?? true;
    const includeGlobal = options.globalVisibility ?? true;
    const centralPath =
      includeCentral && event.kind !== "partial"
        ? this.calculateCentralPath(event, options.path)
        : null;
    const global = includeGlobal
      ? this.calculateGlobalVisibility(event, options.visibility)
      : { surface: emptyVisibility(), contacts: [] };
    const instantaneousShadows = (
      options.instantaneousAtUtc ?? []
    ).map((atUtc) =>
      this.calculateInstantaneousShadow(
        event,
        atUtc,
        options.shadow,
      ),
    );
    let timeMarkers: TimeMarker[] = [];
    if (options.timeMarkers && centralPath) {
      timeMarkers = this.calculateTimeMarkers(
        event,
        centralPath,
        typeof options.timeMarkers === "object"
          ? options.timeMarkers
          : undefined,
      );
    }
    return {
      event: centralPath
        ? { ...event, kind: centralPath.kind }
        : event,
      provider: this.capabilities.ephemeris.metadata,
      centralPath,
      globalVisibility: global.surface,
      instantaneousShadows,
      contacts: global.contacts,
      timeMarkers,
    };
  }
}
