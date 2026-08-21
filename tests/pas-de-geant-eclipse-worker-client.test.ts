import type { EclipseSummary } from "@found-in-space/shadowline";
import { describe, expect, it, vi } from "vitest";
import type {
  EclipseFrame,
  EclipseWorkerRequest,
  EclipseWorkerResponse,
} from "../apps/pas-de-geant/src/eclipse-types.js";
import { EclipseWorkerClient } from "../apps/pas-de-geant/src/eclipse-worker-client.js";

const event = {
  id: "solar-2026-08-12-total",
  kind: "total",
  peakUtc: "2026-08-12T17:46:00.000Z",
} as EclipseSummary;

function frame(atUtc: string): EclipseFrame {
  return { event, atUtc } as EclipseFrame;
}

class FakeWorker extends EventTarget {
  readonly requests: EclipseWorkerRequest[] = [];
  terminated = false;

  postMessage(request: EclipseWorkerRequest): void {
    this.requests.push(request);
  }

  respond(response: EclipseWorkerResponse): void {
    this.dispatchEvent(new MessageEvent("message", { data: response }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("Eclipse worker client", () => {
  it("coalesces animation frames and resolves callers with the newest time", async () => {
    const worker = new FakeWorker();
    const client = new EclipseWorkerClient(worker as unknown as Worker);
    const firstUtc = "2026-08-12T17:40:00.000Z";
    const skippedUtc = "2026-08-12T17:41:00.000Z";
    const latestUtc = "2026-08-12T17:42:00.000Z";
    const first = client.latest(event, firstUtc);
    const skipped = client.latest(event, skippedUtc);
    const latest = client.latest(event, latestUtc);
    expect(worker.requests).toHaveLength(1);
    const firstRequest = worker.requests[0]!;
    worker.respond({
      type: "frame",
      requestId: firstRequest.requestId,
      frame: frame(firstUtc),
    });
    await vi.waitFor(() => expect(worker.requests).toHaveLength(2));
    const latestRequest = worker.requests[1]!;
    expect(latestRequest).toMatchObject({ type: "frame", atUtc: latestUtc });
    worker.respond({
      type: "frame",
      requestId: latestRequest.requestId,
      frame: frame(latestUtc),
    });

    expect((await first).atUtc).toBe(latestUtc);
    expect((await skipped).atUtc).toBe(latestUtc);
    expect((await latest).atUtc).toBe(latestUtc);
    expect(worker.requests).toHaveLength(2);
    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("ignores a stale response whose request ID is no longer pending", async () => {
    const worker = new FakeWorker();
    const client = new EclipseWorkerClient(worker as unknown as Worker);
    const promise = client.latest(event, event.peakUtc);
    const request = worker.requests[0]!;
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    worker.respond({
      type: "frame",
      requestId: request.requestId + 100,
      frame: frame("2026-08-12T00:00:00.000Z"),
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.respond({
      type: "frame",
      requestId: request.requestId,
      frame: frame(event.peakUtc),
    });
    expect((await promise).atUtc).toBe(event.peakUtc);
    client.dispose();
  });
});
