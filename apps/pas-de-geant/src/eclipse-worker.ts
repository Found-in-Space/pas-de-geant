/// <reference lib="webworker" />

import {
  calculateEclipseContactRange,
  calculateEclipseEvents,
  calculateEclipseFrame,
} from "./eclipse-science.js";
import type {
  EclipseWorkerRequest,
  EclipseWorkerResponse,
} from "./eclipse-types.js";

function responseFor(request: EclipseWorkerRequest): EclipseWorkerResponse {
  if (request.type === "events") {
    return {
      type: "events",
      requestId: request.requestId,
      events: calculateEclipseEvents(request.startUtc, request.endUtc),
    };
  }
  if (request.type === "contacts") {
    return {
      type: "contacts",
      requestId: request.requestId,
      range: calculateEclipseContactRange(request.event),
    };
  }
  return {
    type: "frame",
    requestId: request.requestId,
    frame: calculateEclipseFrame(
      request.event,
      request.atUtc,
      request.angularIntervalDegrees,
    ),
  };
}

self.addEventListener(
  "message",
  (message: MessageEvent<EclipseWorkerRequest>) => {
    try {
      self.postMessage(responseFor(message.data));
    } catch (error) {
      const response: EclipseWorkerResponse = {
        type: "error",
        requestId: message.data.requestId,
        message: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(response);
    }
  },
);
