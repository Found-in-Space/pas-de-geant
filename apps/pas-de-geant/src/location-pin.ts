import { EARTH_MEAN_RADIUS_KM } from "@found-in-space/worlds/planet-state";

export interface LocationPin {
  readonly pinId: string;
  readonly label: string;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export interface LocationPinState {
  readonly pins: readonly LocationPin[];
  readonly guidedPinIds: readonly string[];
}

export interface LocationPinCatalogState {
  readonly pins: readonly LocationPin[];
  readonly visiblePinIds: readonly string[];
  readonly guidedPinIds: readonly string[];
}

function requiredText(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${description} must be a non-empty string.`);
  }
  return value.trim();
}

function coordinate(
  value: unknown,
  minimum: number,
  maximum: number,
  description: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${description} must be finite.`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${description} must be between ${minimum} and ${maximum} degrees.`);
  }
  return value;
}

export function parseLocationPin(value: unknown): LocationPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Location pin must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  return {
    pinId: requiredText(candidate.pinId, "Pin ID"),
    label: requiredText(candidate.label, "Pin label"),
    latitudeDegrees: coordinate(
      candidate.latitudeDegrees,
      -90,
      90,
      "Latitude",
    ),
    longitudeDegrees: coordinate(
      candidate.longitudeDegrees,
      -180,
      180,
      "Longitude",
    ),
  };
}

export class LocationPinStore {
  private readonly pins = new Map<string, LocationPin>();
  private readonly visibleIds = new Set<string>();
  private readonly guidedIds = new Set<string>();

  set(pinValue: LocationPin): LocationPinState {
    const pin = parseLocationPin(pinValue);
    this.pins.set(pin.pinId, pin);
    this.visibleIds.add(pin.pinId);
    return this.snapshot();
  }

  remove(pinIdValue: string): LocationPinState {
    const pinId = requiredText(pinIdValue, "Pin ID");
    if (!this.pins.delete(pinId)) {
      throw new Error("Location pin does not exist.");
    }
    this.visibleIds.delete(pinId);
    this.guidedIds.delete(pinId);
    return this.snapshot();
  }

  setVisibility(pinIdValue: string, visible: boolean): LocationPinState {
    const pinId = requiredText(pinIdValue, "Pin ID");
    if (!this.pins.has(pinId)) {
      throw new Error("Location pin does not exist.");
    }
    if (visible) this.visibleIds.add(pinId);
    else {
      this.visibleIds.delete(pinId);
      this.guidedIds.delete(pinId);
    }
    return this.snapshot();
  }

  rename(pinIdValue: string, labelValue: string): LocationPinState {
    const pinId = requiredText(pinIdValue, "Pin ID");
    const pin = this.pins.get(pinId);
    if (!pin) throw new Error("Location pin does not exist.");
    this.pins.set(pinId, {
      ...pin,
      label: requiredText(labelValue, "Pin label"),
    });
    return this.snapshot();
  }

  setGuidance(pinIdValue: string, enabled: boolean): LocationPinState {
    const pinId = requiredText(pinIdValue, "Pin ID");
    if (!this.pins.has(pinId)) {
      throw new Error("Location pin does not exist.");
    }
    if (enabled && !this.visibleIds.has(pinId)) {
      throw new Error("Location pin must be visible before guidance can be enabled.");
    }
    if (enabled) this.guidedIds.add(pinId);
    else this.guidedIds.delete(pinId);
    return this.snapshot();
  }

  clear(): LocationPinState {
    this.pins.clear();
    this.visibleIds.clear();
    this.guidedIds.clear();
    return this.snapshot();
  }

  snapshot(): LocationPinState {
    return {
      pins: [...this.pins.values()].filter(({ pinId }) =>
        this.visibleIds.has(pinId)
      ),
      guidedPinIds: [...this.guidedIds],
    };
  }

  catalogSnapshot(): LocationPinCatalogState {
    return {
      pins: [...this.pins.values()],
      visiblePinIds: [...this.visibleIds],
      guidedPinIds: [...this.guidedIds],
    };
  }
}

export function greatCircleDistanceKm(
  fromLatitudeDegrees: number,
  fromLongitudeDegrees: number,
  toLatitudeDegrees: number,
  toLongitudeDegrees: number,
): number {
  const fromLatitude = fromLatitudeDegrees * Math.PI / 180;
  const toLatitude = toLatitudeDegrees * Math.PI / 180;
  const latitudeDelta = (toLatitudeDegrees - fromLatitudeDegrees) * Math.PI / 180;
  const longitudeDelta = (toLongitudeDegrees - fromLongitudeDegrees) * Math.PI / 180;
  const sineLatitude = Math.sin(latitudeDelta / 2);
  const sineLongitude = Math.sin(longitudeDelta / 2);
  const haversine = sineLatitude * sineLatitude +
    Math.cos(fromLatitude) * Math.cos(toLatitude) *
      sineLongitude * sineLongitude;
  const centralAngle = 2 * Math.atan2(
    Math.sqrt(Math.max(0, haversine)),
    Math.sqrt(Math.max(0, 1 - haversine)),
  );
  return EARTH_MEAN_RADIUS_KM * centralAngle;
}

export function locationPinAngularHeightDegrees(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new Error("Pin distance must be finite and nonnegative.");
  }
  return 2.5 / Math.sqrt(1 + distanceKm / 80);
}

export function worldHeightForAngularSize(
  cameraDistanceM: number,
  angularHeightDegrees: number,
): number {
  if (!Number.isFinite(cameraDistanceM) || cameraDistanceM < 0) {
    throw new Error("Camera distance must be finite and nonnegative.");
  }
  if (!Number.isFinite(angularHeightDegrees) || angularHeightDegrees <= 0) {
    throw new Error("Angular height must be positive and finite.");
  }
  return 2 * cameraDistanceM * Math.tan(
    angularHeightDegrees * Math.PI / 360,
  );
}

export function formatLocationPinDistance(distanceKm: number): string {
  if (distanceKm < 1) return `${Math.round(distanceKm * 1_000)} m`;
  return `${distanceKm.toLocaleString(undefined, {
    maximumFractionDigits: distanceKm < 100 ? 1 : 0,
  })} km`;
}
