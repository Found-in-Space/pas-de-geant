import type {
  CartesianVector,
  EclipseSummary,
} from "@found-in-space/shadowline";

export type EclipseViewPreset = "system" | "earth" | "moon" | "shadow";

export interface CartesianBasis {
  x: CartesianVector;
  y: CartesianVector;
  z: CartesianVector;
}

export interface EclipseFrame {
  event: EclipseSummary;
  atUtc: string;
  sunEcefKm: CartesianVector;
  moonEcefKm: CartesianVector;
  direction: CartesianVector;
  ecefToEquatorialJ2000: CartesianBasis;
  sunEarthDistanceKm: number;
  sunMoonDistanceKm: number;
  moonEarthDistanceKm: number;
  axisDistanceToEarthPlaneKm: number;
  centralConeSlope: number;
  penumbraConeSlope: number;
  umbraRadiusAtEarthPlaneKm: number;
  penumbraRadiusAtEarthPlaneKm: number;
  centralKind: "umbra" | "antumbra" | null;
  penumbraRings: CartesianVector[][];
  centralRings: CartesianVector[][];
}

export interface EclipseContactRange {
  startUtc: string;
  endUtc: string;
}

export type EclipseWorkerRequest =
  | {
      type: "events";
      requestId: number;
      startUtc: string;
      endUtc: string;
    }
  | {
      type: "contacts";
      requestId: number;
      event: EclipseSummary;
    }
  | {
      type: "frame";
      requestId: number;
      event: EclipseSummary;
      atUtc: string;
      angularIntervalDegrees?: number;
    };

export type EclipseWorkerResponse =
  | {
      type: "events";
      requestId: number;
      events: EclipseSummary[];
    }
  | {
      type: "contacts";
      requestId: number;
      range: EclipseContactRange;
    }
  | {
      type: "frame";
      requestId: number;
      frame: EclipseFrame;
    }
  | {
      type: "error";
      requestId: number;
      message: string;
    };
