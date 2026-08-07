export interface DurationSummary {
  readonly latestMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

export interface FrameTelemetrySnapshot {
  readonly sampleCount: number;
  readonly windowSeconds: number;
  readonly observedFps: number | null;
  readonly targetFrameRate: number | null;
  readonly targetFrameBudgetMs: number | null;
  readonly framesOverBudget: number;
  readonly renderedFrames: number;
  readonly scheduledInterval: DurationSummary | null;
  readonly applicationCpu: DurationSummary | null;
}

interface FrameSample {
  readonly timestampMs: number;
  readonly intervalMs: number;
  readonly applicationCpuMs: number;
  readonly rendered: boolean;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]!;
}

export function summarizeDurations(
  durationsMs: readonly number[],
): DurationSummary | null {
  if (durationsMs.length === 0) return null;
  const sorted = [...durationsMs].sort((left, right) => left - right);
  const total = durationsMs.reduce((sum, value) => sum + value, 0);
  return {
    latestMs: rounded(durationsMs.at(-1)!),
    meanMs: rounded(total / durationsMs.length),
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    p99Ms: rounded(percentile(sorted, 0.99)),
    maxMs: rounded(sorted.at(-1)!),
  };
}

/** A time-windowed history keeps percentiles relevant after live tuning. */
export class FrameTelemetry {
  readonly #windowMs: number;
  #samples: FrameSample[] = [];

  constructor(windowMs = 10_000) {
    this.#windowMs = windowMs;
  }

  record(
    timestampMs: number,
    intervalMs: number,
    applicationCpuMs: number,
    rendered: boolean,
  ): void {
    this.#samples.push({
      timestampMs,
      intervalMs,
      applicationCpuMs,
      rendered,
    });
    const cutoffMs = timestampMs - this.#windowMs;
    let firstRetainedIndex = 0;
    while (
      firstRetainedIndex < this.#samples.length &&
      this.#samples[firstRetainedIndex]!.timestampMs < cutoffMs
    ) {
      firstRetainedIndex += 1;
    }
    if (firstRetainedIndex > 0) {
      this.#samples.splice(0, firstRetainedIndex);
    }
  }

  clear(): void {
    this.#samples.length = 0;
  }

  snapshot(targetFrameRate?: number): FrameTelemetrySnapshot {
    const intervals = this.#samples.map(({ intervalMs }) => intervalMs);
    const applicationCpu = this.#samples.map(
      ({ applicationCpuMs }) => applicationCpuMs,
    );
    const firstTimestamp = this.#samples.at(0)?.timestampMs;
    const lastTimestamp = this.#samples.at(-1)?.timestampMs;
    const elapsedMs = firstTimestamp === undefined || lastTimestamp === undefined
      ? 0
      : lastTimestamp - firstTimestamp;
    const validTarget = targetFrameRate !== undefined &&
        Number.isFinite(targetFrameRate) && targetFrameRate > 0
      ? targetFrameRate
      : null;
    const budgetMs = validTarget === null ? null : 1_000 / validTarget;
    return {
      sampleCount: this.#samples.length,
      windowSeconds: rounded(elapsedMs / 1_000),
      observedFps: elapsedMs > 0
        ? rounded((this.#samples.length - 1) * 1_000 / elapsedMs)
        : null,
      targetFrameRate: validTarget,
      targetFrameBudgetMs: budgetMs === null ? null : rounded(budgetMs),
      framesOverBudget: budgetMs === null
        ? 0
        : intervals.filter((duration) => duration > budgetMs * 1.05).length,
      renderedFrames: this.#samples.filter(({ rendered }) => rendered).length,
      scheduledInterval: summarizeDurations(intervals),
      applicationCpu: summarizeDurations(applicationCpu),
    };
  }
}

export interface ResourceTimingGroup {
  readonly count: number;
  readonly transferBytes: number;
  readonly encodedBytes: number;
  readonly duration: DurationSummary | null;
}

/** Summarize resource timings without leaking tile paths or API keys. */
export function summarizeResourceTimings(
  entries: readonly PerformanceResourceTiming[],
  nowMs: number,
  recentWindowMs = 30_000,
): Record<string, ResourceTimingGroup> {
  const groups = new Map<string, PerformanceResourceTiming[]>();
  for (const entry of entries) {
    if (nowMs - entry.startTime > recentWindowMs) continue;
    let host = "same-origin";
    try {
      host = new URL(entry.name, window.location.href).host;
    } catch {
      // Keep malformed or browser-internal names in a non-identifying bucket.
    }
    const group = groups.get(host) ?? [];
    group.push(entry);
    groups.set(host, group);
  }
  return Object.fromEntries(
    [...groups.entries()].map(([host, hostEntries]) => [host, {
      count: hostEntries.length,
      transferBytes: hostEntries.reduce(
        (sum, entry) => sum + entry.transferSize,
        0,
      ),
      encodedBytes: hostEntries.reduce(
        (sum, entry) => sum + entry.encodedBodySize,
        0,
      ),
      duration: summarizeDurations(hostEntries.map(({ duration }) => duration)),
    }]),
  );
}
