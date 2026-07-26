/// <reference lib="webworker" />

import {
  EclipseEngine,
  type EclipseScene,
  type EclipseSummary,
  type LocalEclipse,
  type Observer,
} from "@found-in-space/shadowline";
import {
  AstronomyEngineProvider,
  astronomyEngineCapabilities,
} from "@found-in-space/shadowline-astronomy-engine";

type PageDirection = "earlier" | "later";

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
}

interface SearchYearRequest {
  id: number;
  type: "search-year";
  year: number;
}

interface SearchGlobalPageRequest {
  id: number;
  type: "search-global-page";
  boundaryUtc: string;
  direction: PageDirection;
  limit: number;
}

interface SearchLocalPageRequest {
  id: number;
  type: "search-local-page";
  observer: Observer;
  boundaryUtc: string;
  direction: PageDirection;
  limit: number;
}

interface SearchLocalRangeRequest {
  id: number;
  type: "search-local-range";
  observer: Observer;
  startUtc: string;
  endUtc: string;
}

type WorkerRequest =
  | SearchYearRequest
  | SearchGlobalPageRequest
  | SearchLocalPageRequest
  | SearchLocalRangeRequest
  | CalculatePathRequest
  | CalculateLocationRequest;

const GLOBAL_CHUNK_YEARS = 10;
const LOCAL_CHUNK_YEARS = 50;
const provider = new AstronomyEngineProvider();
const capabilities = astronomyEngineCapabilities(provider);
const engine = new EclipseEngine(capabilities);

function validDate(utc: string): Date {
  const value = new Date(utc);
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError(`Invalid eclipse search boundary: ${utc}`);
  }
  return value;
}

function shiftYears(utc: string, years: number): string {
  const value = validDate(utc);
  value.setUTCFullYear(value.getUTCFullYear() + years);
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError(`Eclipse search exceeded the supported date range.`);
  }
  return value.toISOString();
}

function instantAfter(utc: string): string {
  const value = validDate(utc);
  value.setTime(value.getTime() + 1);
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError(`Eclipse search exceeded the supported date range.`);
  }
  return value.toISOString();
}

function peakUtc(event: EclipseSummary | LocalEclipse): string {
  return "peakUtc" in event ? event.peakUtc : event.peak.utc;
}

function searchPage<T extends EclipseSummary | LocalEclipse>(
  boundaryUtc: string,
  direction: PageDirection,
  limit: number,
  chunkYears: number,
  search: (startUtc: string, endUtc: string) => T[],
): T[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Eclipse page size must be a positive integer.");
  }
  validDate(boundaryUtc);
  let cursorUtc = boundaryUtc;
  let events: T[] = [];
  let firstChunk = true;
  while (events.length < limit) {
    if (direction === "earlier") {
      const startUtc = shiftYears(cursorUtc, -chunkYears);
      events = [...search(startUtc, cursorUtc), ...events];
      cursorUtc = startUtc;
    } else {
      const startUtc = firstChunk ? instantAfter(cursorUtc) : cursorUtc;
      const endUtc = shiftYears(startUtc, chunkYears);
      events = [...events, ...search(startUtc, endUtc)];
      cursorUtc = endUtc;
    }
    firstChunk = false;
  }
  events.sort((first, second) => peakUtc(first).localeCompare(peakUtc(second)));
  return direction === "earlier"
    ? events.slice(-limit)
    : events.slice(0, limit);
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
    if (request.type === "search-global-page") {
      const events = searchPage(
        request.boundaryUtc,
        request.direction,
        request.limit,
        GLOBAL_CHUNK_YEARS,
        (startUtc, endUtc) => engine.events({ startUtc, endUtc }),
      );
      self.postMessage({
        id: request.id,
        ok: true,
        result: { provider: provider.metadata, events },
      });
      return;
    }
    if (request.type === "search-local-page") {
      const events = searchPage(
        request.boundaryUtc,
        request.direction,
        request.limit,
        LOCAL_CHUNK_YEARS,
        (startUtc, endUtc) =>
          engine.localEclipses(request.observer, { startUtc, endUtc }),
      );
      self.postMessage({
        id: request.id,
        ok: true,
        result: { events },
      });
      return;
    }
    if (request.type === "search-local-range") {
      self.postMessage({
        id: request.id,
        ok: true,
        result: {
          events: engine.localEclipses(request.observer, {
            startUtc: request.startUtc,
            endUtc: request.endUtc,
          }),
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
    self.postMessage({
      id: request.id,
      ok: true,
      result: { selected, shadowScene },
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
