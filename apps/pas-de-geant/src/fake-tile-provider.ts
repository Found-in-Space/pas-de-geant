import {
  tileIdentityKey,
  type TileIdentity,
} from "./tile-transition-planner.js";
import type {
  TileProvider,
  TileProviderResult,
  TileRequestHandle,
} from "./tile-provider.js";

export type FakeFailureMode =
  | "none"
  | "transient-first-attempt"
  | "persistent-selected"
  | "deterministic-rate";

export interface FakeTileProviderOptions {
  readonly latencyMs: number;
  readonly jitterMs: number;
  readonly failureMode: FakeFailureMode;
  readonly failureRate: number;
  readonly selectedFailureKey: string;
}

export interface FakeTileResource {
  readonly tile: TileIdentity;
  readonly requestId: number;
  readonly attempt: number;
}

export type FakeProviderEventPhase =
  | "request"
  | "in-flight"
  | "response"
  | "failure"
  | "cancellation";

export interface FakeProviderEvent {
  readonly sequence: number;
  readonly timeMs: number;
  readonly phase: FakeProviderEventPhase;
  readonly requestId: number;
  readonly tile: TileIdentity;
  readonly attempt: number;
  readonly dueTimeMs: number;
  readonly reason?: string;
}

interface PendingRequest {
  readonly requestId: number;
  readonly tile: TileIdentity;
  readonly attempt: number;
  readonly dueTimeMs: number;
  readonly willFail: boolean;
  readonly failureReason: string;
  readonly observer: (result: TileProviderResult<FakeTileResource>) => void;
  phase: "request" | "in-flight";
  cancelled: boolean;
}

const DEFAULT_OPTIONS: FakeTileProviderOptions = {
  latencyMs: 650,
  jitterMs: 280,
  failureMode: "none",
  failureRate: 0.2,
  selectedFailureKey: "",
};

function immutableTile(tile: TileIdentity): TileIdentity {
  return Object.freeze({ z: tile.z, x: tile.x, y: tile.y });
}

function hashString(source: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function normalizedOptions(
  options: Partial<FakeTileProviderOptions>,
): FakeTileProviderOptions {
  return Object.freeze({
    latencyMs: Math.max(0, Number(options.latencyMs ?? DEFAULT_OPTIONS.latencyMs)),
    jitterMs: Math.max(0, Number(options.jitterMs ?? DEFAULT_OPTIONS.jitterMs)),
    failureMode: options.failureMode ?? DEFAULT_OPTIONS.failureMode,
    failureRate: Math.max(
      0,
      Math.min(1, Number(options.failureRate ?? DEFAULT_OPTIONS.failureRate)),
    ),
    selectedFailureKey:
      options.selectedFailureKey ?? DEFAULT_OPTIONS.selectedFailureKey,
  });
}

/**
 * A deterministic asynchronous XYZ resource provider driven by an explicit
 * clock. It produces identity tokens only: there is no fetch, decode or cache.
 */
export class FakeTileProvider implements TileProvider<FakeTileResource> {
  private options: FakeTileProviderOptions;
  private currentTimeMs = 0;
  private nextRequestId = 1;
  private nextSequence = 1;
  private readonly attempts = new Map<string, number>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(event: FakeProviderEvent) => void>();

  constructor(options: Partial<FakeTileProviderOptions> = {}) {
    this.options = normalizedOptions(options);
  }

  get now(): number {
    return this.currentTimeMs;
  }

  get configuration(): FakeTileProviderOptions {
    return this.options;
  }

  configure(options: Partial<FakeTileProviderOptions>): void {
    this.options = normalizedOptions({ ...this.options, ...options });
  }

  subscribe(listener: (event: FakeProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(
    request: PendingRequest,
    phase: FakeProviderEventPhase,
    reason?: string,
  ): void {
    const event = Object.freeze({
      sequence: this.nextSequence,
      timeMs: this.currentTimeMs,
      phase,
      requestId: request.requestId,
      tile: request.tile,
      attempt: request.attempt,
      dueTimeMs: request.dueTimeMs,
      ...(reason === undefined ? {} : { reason }),
    });
    this.nextSequence += 1;
    for (const listener of this.listeners) listener(event);
  }

  request(
    sourceTile: TileIdentity,
    observer: (result: TileProviderResult<FakeTileResource>) => void,
  ): TileRequestHandle {
    const tile = immutableTile(sourceTile);
    const key = tileIdentityKey(tile);
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const jitterUnit = hashString(`${key}:attempt:${attempt}`) / 0xffff_ffff;
    const jitter = (jitterUnit * 2 - 1) * this.options.jitterMs;
    const dueTimeMs =
      this.currentTimeMs + Math.max(0, this.options.latencyMs + jitter);
    const deterministicRate =
      hashString(`failure:${key}`) / 0xffff_ffff < this.options.failureRate;
    const willFail =
      (this.options.failureMode === "transient-first-attempt" && attempt === 1) ||
      (this.options.failureMode === "persistent-selected" &&
        key === this.options.selectedFailureKey.trim()) ||
      (this.options.failureMode === "deterministic-rate" && deterministicRate);
    const failureReason =
      this.options.failureMode === "transient-first-attempt"
        ? "Deterministic first-attempt failure"
        : this.options.failureMode === "persistent-selected"
          ? `Persistent selected failure for ${key}`
          : `Deterministic rate failure for ${key}`;
    const pending: PendingRequest = {
      requestId,
      tile,
      attempt,
      dueTimeMs,
      willFail,
      failureReason,
      observer,
      phase: "request",
      cancelled: false,
    };
    this.pending.set(requestId, pending);
    this.emit(pending, "request");

    return Object.freeze({
      requestId,
      cancel: (): void => {
        const active = this.pending.get(requestId);
        if (!active || active.cancelled) return;
        active.cancelled = true;
        this.pending.delete(requestId);
        this.emit(active, "cancellation", "Cancelled by owner");
      },
    });
  }

  /** Advance the deterministic provider clock and deliver due lifecycle events. */
  advanceBy(milliseconds: number): void {
    this.currentTimeMs += Math.max(0, milliseconds);
    const active = [...this.pending.values()].sort(
      (first, second) =>
        first.dueTimeMs - second.dueTimeMs ||
        first.requestId - second.requestId,
    );

    for (const request of active) {
      if (request.cancelled || !this.pending.has(request.requestId)) continue;
      if (request.phase === "request") {
        request.phase = "in-flight";
        this.emit(request, "in-flight");
        request.observer(Object.freeze({ phase: "in-flight" }));
      }
      if (request.dueTimeMs > this.currentTimeMs) continue;
      this.pending.delete(request.requestId);
      if (request.willFail) {
        this.emit(request, "failure", request.failureReason);
        request.observer(
          Object.freeze({
            phase: "failure",
            reason: request.failureReason,
          }),
        );
      } else {
        const resource = Object.freeze({
          tile: request.tile,
          requestId: request.requestId,
          attempt: request.attempt,
        });
        this.emit(request, "response");
        request.observer(Object.freeze({ phase: "response", resource }));
      }
    }
  }
}
