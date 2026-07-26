import type {
  EclipseScene,
  EclipseSummary,
  LocalEclipse,
  Observer,
  ProviderMetadata,
} from "@found-in-space/shadowline";

interface EventSearchResult {
  provider: ProviderMetadata;
  events: EclipseSummary[];
}

interface LocationResult {
  selected: LocalEclipse | null;
  shadowScene: EclipseScene | null;
  nearby: LocalEclipse[];
  startYear: number;
  endYear: number;
}

interface EventGeometryResult {
  scene: EclipseScene;
}

interface WorkerResponse<T> {
  id: number;
  ok: boolean;
  result?: T;
  error?: string;
}

export class EclipseWorkerClient {
  private readonly worker = new Worker(
    new URL("./path-worker.ts", import.meta.url),
    { type: "module" },
  );
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: Error): void }
  >();

  constructor() {
    this.worker.addEventListener(
      "message",
      (message: MessageEvent<WorkerResponse<unknown>>) => {
        const pending = this.pending.get(message.data.id);
        if (!pending) return;
        this.pending.delete(message.data.id);
        if (message.data.ok) {
          pending.resolve(message.data.result);
        } else {
          pending.reject(
            new Error(message.data.error ?? "Eclipse worker failed."),
          );
        }
      },
    );
  }

  private request<T>(payload: object): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.worker.postMessage({ ...payload, id });
    });
  }

  eventsForYear(year: number): Promise<EventSearchResult> {
    return this.request({ type: "search-year", year });
  }

  calculateEventGeometry(
    event: EclipseSummary,
  ): Promise<EventGeometryResult> {
    return this.request({ type: "calculate-path", event });
  }

  calculateLocation(
    event: EclipseSummary,
    observer: Observer,
    referenceYear: number,
    yearsEachSide: number,
  ): Promise<LocationResult> {
    return this.request({
      type: "calculate-location",
      event,
      observer,
      referenceYear,
      yearsEachSide,
    });
  }
}
