import {
  WEB_MERCATOR_MAX_LATITUDE,
} from "./tile-onion-core.js";
import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";
import type { MercatorForecastDisplacement } from "./view-residency.js";

const VELOCITY_FILTER_MS = 180;
const FORECAST_QUANTIZATION_STEPS_PER_TILE = 2;

export const DEFAULT_TILE_ASSET_READY_MS = 750;

export interface TileMovementView {
  readonly displayRadiusM: number;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export interface TileMovementForecast {
  /** Motion changes payload admission only, never planned topology quality. */
  readonly velocityEastMps: number;
  readonly velocityNorthMps: number;
  readonly speedMps: number;
  readonly estimatedReadyMs: number;
  readonly predictedTravelM: number;
  readonly finestTileWidthM: number;
  readonly predictedTravelTileSpans: number;
  readonly deferSpeculativeWarm: boolean;
  readonly displacement: MercatorForecastDisplacement;
  /** Changes only at half-fine-tile displacement boundaries. */
  readonly signature: number;
}

function wrappedLongitudeDeltaRadians(
  firstLongitudeDegrees: number,
  secondLongitudeDegrees: number,
): number {
  const radians = Math.PI / 180;
  const rawLongitudeDelta =
    (secondLongitudeDegrees - firstLongitudeDegrees) * radians;
  return ((rawLongitudeDelta + Math.PI) % (Math.PI * 2) + Math.PI * 2) %
      (Math.PI * 2) - Math.PI;
}

function normalizedMercatorY(latitudeDegrees: number): number {
  const latitude = Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
  ) * Math.PI / 180;
  return (
    1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI
  ) * 0.5;
}

/** Physical width of one Web Mercator tile on the rendered globe. */
export function renderedTileWidthM(
  latitudeDegrees: number,
  displayRadiusM: number,
  zoom: number,
): number {
  const latitude = Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, latitudeDegrees),
  ) * Math.PI / 180;
  return 2 * Math.PI * Math.max(0.001, displayRadiusM) *
    Math.max(1e-6, Math.cos(latitude)) /
    2 ** Math.max(0, Math.floor(zoom));
}

/**
 * Predicts which payloads can become useful before they are ready. The class
 * is shared by terrain and imagery; different measured ready times naturally
 * produce different forecasts without changing topology semantics.
 */
export class TileMovementAdmission {
  private sampleLatitudeDegrees: number | undefined;
  private sampleLongitudeDegrees = 0;
  private sampleTimeMs: number | undefined;
  private filteredVelocityEastMps = 0;
  private filteredVelocityNorthMps = 0;
  /** Reused because this policy is sampled on every rendered frame. */
  private readonly forecastValue = {
    velocityEastMps: 0,
    velocityNorthMps: 0,
    speedMps: 0,
    estimatedReadyMs: DEFAULT_TILE_ASSET_READY_MS,
    predictedTravelM: 0,
    finestTileWidthM: 1,
    predictedTravelTileSpans: 0,
    deferSpeculativeWarm: false,
    displacement: { x: 0, y: 0 },
    signature: 0,
  };

  constructor(initialView?: TileMovementView) {
    if (!initialView) return;
    this.sampleLatitudeDegrees = initialView.latitudeDegrees;
    this.sampleLongitudeDegrees = initialView.longitudeDegrees;
  }

  /** Live read-only view, reused across updates to avoid frame allocations. */
  get forecast(): TileMovementForecast {
    return this.forecastValue;
  }

  update(
    view: TileMovementView,
    desiredZoom: number,
    estimatedReadyMs: number,
    nowMs: number,
  ): TileMovementForecast {
    if (this.sampleLatitudeDegrees === undefined) {
      this.sampleLatitudeDegrees = view.latitudeDegrees;
      this.sampleLongitudeDegrees = view.longitudeDegrees;
      this.sampleTimeMs = nowMs;
    } else if (this.sampleTimeMs === undefined) {
      this.sampleTimeMs = nowMs;
      this.sampleLatitudeDegrees = view.latitudeDegrees;
      this.sampleLongitudeDegrees = view.longitudeDegrees;
    } else {
      const elapsedMs = nowMs - this.sampleTimeMs;
      if (elapsedMs > 0) {
        const radians = Math.PI / 180;
        const radius = Math.max(0.001, view.displayRadiusM);
        const meanLatitude = Math.max(
          -WEB_MERCATOR_MAX_LATITUDE,
          Math.min(
            WEB_MERCATOR_MAX_LATITUDE,
            (this.sampleLatitudeDegrees + view.latitudeDegrees) * 0.5,
          ),
        ) * radians;
        const seconds = elapsedMs / 1_000;
        const instantaneousEastMps = wrappedLongitudeDeltaRadians(
          this.sampleLongitudeDegrees,
          view.longitudeDegrees,
        ) * Math.cos(meanLatitude) * radius / seconds;
        const instantaneousNorthMps =
          (view.latitudeDegrees - this.sampleLatitudeDegrees) * radians *
          radius / seconds;
        const filterWeight = 1 - Math.exp(-elapsedMs / VELOCITY_FILTER_MS);
        this.filteredVelocityEastMps +=
          (instantaneousEastMps - this.filteredVelocityEastMps) *
          filterWeight;
        this.filteredVelocityNorthMps +=
          (instantaneousNorthMps - this.filteredVelocityNorthMps) *
          filterWeight;
        this.sampleTimeMs = nowMs;
        this.sampleLatitudeDegrees = view.latitudeDegrees;
        this.sampleLongitudeDegrees = view.longitudeDegrees;
      }
    }

    const speedMps = Math.hypot(
      this.filteredVelocityEastMps,
      this.filteredVelocityNorthMps,
    );
    const readyMs = Math.max(0, estimatedReadyMs);
    const readinessSeconds = readyMs / 1_000;
    const predictedTravelM = speedMps * readinessSeconds;
    const finestTileWidthM = renderedTileWidthM(
      view.latitudeDegrees,
      view.displayRadiusM,
      desiredZoom,
    );
    const predictedTravelTileSpans = predictedTravelM / finestTileWidthM;
    const width = 2 ** Math.max(0, Math.floor(desiredZoom));
    const latitude = Math.max(
      -WEB_MERCATOR_MAX_LATITUDE,
      Math.min(WEB_MERCATOR_MAX_LATITUDE, view.latitudeDegrees),
    ) * Math.PI / 180;
    const normalizedMetres = 2 * Math.PI *
      Math.max(0.001, view.displayRadiusM) * Math.cos(latitude);
    const rawX = this.filteredVelocityEastMps * readinessSeconds /
      normalizedMetres;
    let rawY = -this.filteredVelocityNorthMps * readinessSeconds /
      normalizedMetres;
    const currentY = normalizedMercatorY(view.latitudeDegrees);
    rawY = Math.max(0, Math.min(1, currentY + rawY)) - currentY;
    const quantizedX = Math.round(
      rawX * width * FORECAST_QUANTIZATION_STEPS_PER_TILE,
    );
    const quantizedY = Math.round(
      rawY * width * FORECAST_QUANTIZATION_STEPS_PER_TILE,
    );
    const deferSpeculativeWarm = predictedTravelTileSpans >= 1;
    let signature = Math.imul(2_166_136_261 ^ quantizedX, 16_777_619);
    signature = Math.imul(signature ^ quantizedY, 16_777_619);
    signature = Math.imul(
      signature ^ Number(deferSpeculativeWarm),
      16_777_619,
    ) >>> 0;
    this.forecastValue.velocityEastMps = this.filteredVelocityEastMps;
    this.forecastValue.velocityNorthMps = this.filteredVelocityNorthMps;
    this.forecastValue.speedMps = speedMps;
    this.forecastValue.estimatedReadyMs = readyMs;
    this.forecastValue.predictedTravelM = predictedTravelM;
    this.forecastValue.finestTileWidthM = finestTileWidthM;
    this.forecastValue.predictedTravelTileSpans = predictedTravelTileSpans;
    this.forecastValue.deferSpeculativeWarm = deferSpeculativeWarm;
    this.forecastValue.displacement.x =
      quantizedX / FORECAST_QUANTIZATION_STEPS_PER_TILE / width;
    this.forecastValue.displacement.y =
      quantizedY / FORECAST_QUANTIZATION_STEPS_PER_TILE / width;
    this.forecastValue.signature = signature;
    return this.forecastValue;
  }
}

/** Defers only speculative work that has neither started nor loaded. */
export function tileDemandForAdmission(
  fullDemand: readonly TileIdentity[],
  hotKeys: ReadonlySet<string>,
  forecastKeys: ReadonlySet<string>,
  deferSpeculativeWarm: boolean,
  isResidentOrInFlight: (tile: TileIdentity) => boolean,
): readonly TileIdentity[] {
  if (!deferSpeculativeWarm) return fullDemand;
  return fullDemand.filter((tile) => {
    const key = tileIdentityKey(tile);
    return hotKeys.has(key) || forecastKeys.has(key) ||
      isResidentOrInFlight(tile);
  });
}
