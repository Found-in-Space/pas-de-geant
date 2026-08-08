export type TileRequestCircuitState =
  | "closed"
  | "open"
  | "half-open"
  | "disabled";

export interface TileRequestFailureMetadata {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryable?: boolean;
  readonly systemic: boolean;
}

export interface TileRequestCircuitDiagnostics {
  readonly state: TileRequestCircuitState;
  readonly last_status: number | null;
  readonly status_counts: Readonly<Record<string, number>>;
  /** Failures for which browser fetch exposed no HTTP status. */
  readonly opaque_failure_count: number;
  /** Backwards-compatible alias; opaque failures may hide an HTTP response. */
  readonly network_failure_count: number;
  readonly cooldown_until_ms: number | null;
  readonly probe_in_flight: boolean;
}

export type TileRequestStart = "normal" | "probe";

const SESSION_FATAL_STATUSES = new Set([400, 401, 403, 410]);

export function isSessionFatalStatus(status: number): boolean {
  return SESSION_FATAL_STATUSES.has(status);
}

/** Parses both delta-seconds and HTTP-date Retry-After values. */
export function retryAfterMilliseconds(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const delay = seconds * 1_000;
    return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - nowMs);
}

/**
 * Event-driven circuit for one provider source queue. The closed hot path is
 * one state comparison per source start; it creates no timers and does no
 * queue scans.
 */
export class TileRequestCircuit {
  private stateValue: TileRequestCircuitState = "closed";
  private lastStatus: number | undefined;
  private readonly statusCounts = new Map<number, number>();
  private networkFailureCount = 0;
  private cooldownUntilMs: number | undefined;
  private probeInFlight = false;

  get state(): TileRequestCircuitState {
    return this.stateValue;
  }

  get diagnostics(): TileRequestCircuitDiagnostics {
    return Object.freeze({
      state: this.stateValue,
      last_status: this.lastStatus ?? null,
      status_counts: Object.freeze(Object.fromEntries(
        [...this.statusCounts].map(([status, count]) => [String(status), count]),
      )),
      opaque_failure_count: this.networkFailureCount,
      network_failure_count: this.networkFailureCount,
      cooldown_until_ms: this.cooldownUntilMs ?? null,
      probe_in_flight: this.probeInFlight,
    });
  }

  mayStart(nowMs?: number): boolean {
    if (this.stateValue === "disabled") return false;
    if (this.stateValue === "closed") return true;
    if (this.stateValue === "open") {
      return (nowMs ?? Date.now()) >= (this.cooldownUntilMs ?? 0);
    }
    return !this.probeInFlight;
  }

  tryStart(nowMs?: number): TileRequestStart | undefined {
    if (this.stateValue === "disabled") return undefined;
    if (this.stateValue === "closed") return "normal";
    if (this.stateValue === "open") {
      if (
        (nowMs ?? Date.now()) < (this.cooldownUntilMs ?? 0)
      ) return undefined;
      this.stateValue = "half-open";
    }
    if (this.probeInFlight) return undefined;
    this.probeInFlight = true;
    return "probe";
  }

  recordSuccess(probe: boolean): boolean {
    if (!probe || this.stateValue !== "half-open") return false;
    this.stateValue = "closed";
    this.cooldownUntilMs = undefined;
    this.probeInFlight = false;
    return true;
  }

  recordCancellation(probe: boolean): void {
    if (!probe || this.stateValue !== "half-open") return;
    this.probeInFlight = false;
  }

  /** Returns true when network admission tripped open or disabled. */
  recordFailure(
    metadata: TileRequestFailureMetadata,
    probe: boolean,
    nowMs?: number,
  ): boolean {
    if (metadata.status === undefined) {
      if (metadata.systemic) this.networkFailureCount += 1;
    } else {
      this.lastStatus = metadata.status;
      this.statusCounts.set(
        metadata.status,
        (this.statusCounts.get(metadata.status) ?? 0) + 1,
      );
    }
    // A fatal response disables automatic requests for the remainder of this
    // provider session. Later responses from work that was already in flight
    // may enrich diagnostics, but must never reopen the circuit.
    if (this.stateValue === "disabled") return false;
    if (!metadata.systemic) {
      // A half-open request that reached a tile-local HTTP/content result has
      // proved network availability just as surely as a usable tile. Close the
      // provider circuit while leaving that one tile failed for its consumer.
      this.recordSuccess(probe);
      return false;
    }
    this.probeInFlight = false;
    if (metadata.retryable === false) {
      this.stateValue = "disabled";
      this.cooldownUntilMs = undefined;
      return true;
    }
    this.stateValue = "open";
    const failureTime = nowMs ?? Date.now();
    const requestedCooldownUntil = metadata.retryAfterMs === undefined
      ? failureTime
      : failureTime + Math.max(0, metadata.retryAfterMs);
    // Several requests may already be in flight when a provider starts
    // throttling. A later, shorter response must not erase the longest
    // Retry-After already observed for this provider.
    this.cooldownUntilMs = Math.max(
      this.cooldownUntilMs ?? Number.NEGATIVE_INFINITY,
      requestedCooldownUntil,
    );
    return true;
  }
}
