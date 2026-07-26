import type {
  EclipseScene,
  EclipseSummary,
  LocalEclipse,
  Observer,
  ProviderMetadata,
} from "@found-in-space/shadowline";

export type PageDirection = "earlier" | "later";

interface EventSearchResult {
  provider: ProviderMetadata;
  events: EclipseSummary[];
}

interface LocalEventSearchResult {
  events: LocalEclipse[];
}

interface LocationResult {
  selected: LocalEclipse | null;
  shadowScene: EclipseScene | null;
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

  globalEventsPage(
    boundaryUtc: string,
    direction: PageDirection,
    limit: number,
  ): Promise<EventSearchResult> {
    return this.request({
      type: "search-global-page",
      boundaryUtc,
      direction,
      limit,
    });
  }

  localEventsPage(
    observer: Observer,
    boundaryUtc: string,
    direction: PageDirection,
    limit: number,
  ): Promise<LocalEventSearchResult> {
    return this.request({
      type: "search-local-page",
      observer,
      boundaryUtc,
      direction,
      limit,
    });
  }

  localEventsInRange(
    observer: Observer,
    startUtc: string,
    endUtc: string,
  ): Promise<LocalEventSearchResult> {
    return this.request({
      type: "search-local-range",
      observer,
      startUtc,
      endUtc,
    });
  }

  calculateEventGeometry(
    event: EclipseSummary,
  ): Promise<EventGeometryResult> {
    return this.request({ type: "calculate-path", event });
  }

  calculateLocation(
    event: EclipseSummary,
    observer: Observer,
  ): Promise<LocationResult> {
    return this.request({
      type: "calculate-location",
      event,
      observer,
    });
  }
}
