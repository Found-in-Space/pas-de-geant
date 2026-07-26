/// <reference lib="webworker" />

import {
  EclipseEngine,
  type EclipseScene,
  type EclipseSummary,
  type Observer,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";

interface CalculatePathRequest {
  id: number;
  type: "calculate-path";
  event: EclipseSummary;
}

interface CalculateLocationRequest {
  id: number;
  type: "calculate-location";
  event: EclipseSummary;
  observer: Observer;
  referenceYear: number;
  yearsEachSide: number;
}

interface SearchYearRequest {
  id: number;
  type: "search-year";
  year: number;
}

type WorkerRequest =
  | SearchYearRequest
  | CalculatePathRequest
  | CalculateLocationRequest;

const provider = new AstronomyEngineProvider();
const capabilities = astronomyEngineCapabilities(provider);
const engine = new EclipseEngine(capabilities);

function yearBoundary(year: number): string {
  const value = new Date(0);
  value.setUTCFullYear(year, 0, 1);
  value.setUTCHours(0, 0, 0, 0);
  return value.toISOString();
}

self.addEventListener("message", (message: MessageEvent<WorkerRequest>) => {
  const request = message.data;
  try {
    if (request.type === "search-year") {
      self.postMessage({
        id: request.id,
        ok: true,
        result: {
          provider: provider.metadata,
          events: engine.eventsForYear(request.year),
        },
      });
      return;
    }
    if (request.type === "calculate-path") {
      const scene = engine.calculateEvent(request.event, {
        centralPath: true,
        globalVisibility: true,
        timeMarkers: request.event.kind === "partial" ? false : true,
      });
      self.postMessage({
        id: request.id,
        ok: true,
        result: { scene },
      });
      return;
    }
    const startYear = request.referenceYear - request.yearsEachSide;
    const endYear = request.referenceYear + request.yearsEachSide;
    const selected = engine.localCircumstances(request.event, request.observer);
    let shadowScene: EclipseScene | null = null;
    if (selected) {
      try {
        shadowScene = engine.calculateEvent(request.event, {
          centralPath: false,
          globalVisibility: false,
          instantaneousAtUtc: [selected.peak.utc],
          timeMarkers: false,
        });
      } catch {
        // Local circumstances remain useful when an outline is singular
        // extremely close to a horizon contact.
      }
    }
    const nearby = engine.localEclipses(request.observer, {
      startUtc: yearBoundary(startYear),
      endUtc: yearBoundary(endYear + 1),
    });
    self.postMessage({
      id: request.id,
      ok: true,
      result: {
        selected,
        shadowScene,
        nearby,
        startYear,
        endYear,
      },
    });
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

export {};
