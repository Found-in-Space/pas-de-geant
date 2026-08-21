import type { EclipseSummary } from "@found-in-space/shadowline";
import type {
  EclipseContactRange,
  EclipseFrame,
  EclipseWorkerRequest,
  EclipseWorkerResponse,
} from "./eclipse-types.js";

interface PendingRequest {
  resolve(value: EclipseWorkerResponse): void;
  reject(error: Error): void;
}

type EclipseWorkerRequestPayload = EclipseWorkerRequest extends infer Request
  ? Request extends { requestId: number }
    ? Omit<Request, "requestId">
    : never
  : never;

interface DesiredFrame {
  event: EclipseSummary;
  atUtc: string;
  angularIntervalDegrees: number;
  key: string;
}

export class EclipseWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private desiredFrame: DesiredFrame | null = null;
  private processedFrameKey = "";
  private frameDrain: Promise<EclipseFrame> | null = null;
  private latestFrame: EclipseFrame | null = null;

  constructor(
    worker = new Worker(new URL("./eclipse-worker.ts", import.meta.url), {
      type: "module",
    }),
  ) {
    this.worker = worker;
    worker.addEventListener(
      "message",
      (message: MessageEvent<EclipseWorkerResponse>) => {
        const response = message.data;
        const pending = this.pending.get(response.requestId);
        if (!pending) return;
        this.pending.delete(response.requestId);
        if (response.type === "error") {
          pending.reject(new Error(response.message));
        } else {
          pending.resolve(response);
        }
      },
    );
    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "The eclipse worker stopped.");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  async events(startUtc: string, endUtc: string): Promise<EclipseSummary[]> {
    const response = await this.request({
      type: "events",
      startUtc,
      endUtc,
    });
    if (response.type !== "events") throw new Error("Unexpected worker response.");
    return response.events;
  }

  async contacts(event: EclipseSummary): Promise<EclipseContactRange> {
    const response = await this.request({ type: "contacts", event });
    if (response.type !== "contacts") throw new Error("Unexpected worker response.");
    return response.range;
  }

  latest(
    event: EclipseSummary,
    atUtc: string,
    angularIntervalDegrees = 3,
  ): Promise<EclipseFrame> {
    this.desiredFrame = {
      event,
      atUtc,
      angularIntervalDegrees,
      key: `${event.id}:${atUtc}:${angularIntervalDegrees}`,
    };
    const activeDrain = this.frameDrain ?? this.startFrameDrain();
    return activeDrain.then((frame) => {
      const desired = this.desiredFrame;
      return desired && desired.key !== this.processedFrameKey
        ? this.latest(
            desired.event,
            desired.atUtc,
            desired.angularIntervalDegrees,
          )
        : frame;
    });
  }

  dispose(): void {
    this.worker.terminate();
    const error = new Error("The eclipse worker client was disposed.");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async drainFrames(): Promise<EclipseFrame> {
    while (
      this.desiredFrame &&
      this.desiredFrame.key !== this.processedFrameKey
    ) {
      const desired = this.desiredFrame;
      const response = await this.request({
        type: "frame",
        event: desired.event,
        atUtc: desired.atUtc,
        angularIntervalDegrees: desired.angularIntervalDegrees,
      });
      if (response.type !== "frame") {
        throw new Error("Unexpected worker response.");
      }
      this.processedFrameKey = desired.key;
      this.latestFrame = response.frame;
    }
    if (!this.latestFrame) throw new Error("No eclipse frame was calculated.");
    return this.latestFrame;
  }

  private startFrameDrain(): Promise<EclipseFrame> {
    const drain = this.drainFrames();
    this.frameDrain = drain;
    void drain.then(
      () => {
        if (this.frameDrain === drain) this.frameDrain = null;
      },
      () => {
        if (this.frameDrain === drain) this.frameDrain = null;
      },
    );
    return drain;
  }

  private request(
    request: EclipseWorkerRequestPayload,
  ): Promise<EclipseWorkerResponse> {
    this.requestId += 1;
    const requestId = this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...request, requestId });
    });
  }
}
