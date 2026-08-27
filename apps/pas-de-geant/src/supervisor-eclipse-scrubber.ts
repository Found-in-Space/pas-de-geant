export const SUPERVISOR_ECLIPSE_SCRUB_INTERVAL_MS = 200;

export type SupervisorEclipseScrubAcknowledgement =
  | "ignored"
  | "streaming"
  | "complete";

interface SupervisorEclipseScrubberOptions {
  readonly send: (utc: string, final: boolean) => string | undefined;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly intervalMs?: number;
}

interface InFlightScrub {
  readonly final: boolean;
}

export class SupervisorEclipseScrubber {
  private readonly send: SupervisorEclipseScrubberOptions["send"];
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly intervalMs: number;
  private latestUtc: string | undefined;
  private readonly inFlight = new Map<string, InFlightScrub>();
  private timer: unknown;
  private finalRequested = false;
  private lastSentAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: SupervisorEclipseScrubberOptions) {
    this.send = options.send;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ??
      ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ??
      ((timer) => window.clearTimeout(timer as number));
    this.intervalMs = options.intervalMs ??
      SUPERVISOR_ECLIPSE_SCRUB_INTERVAL_MS;
  }

  update(utc: string): void {
    this.latestUtc = utc;
    this.finalRequested = false;
    this.schedule();
  }

  finish(utc: string): void {
    this.latestUtc = utc;
    this.finalRequested = true;
    this.cancelTimer();
    this.dispatch(true);
  }

  acknowledge(
    commandId: string,
    ok: boolean,
  ): SupervisorEclipseScrubAcknowledgement {
    const completed = this.inFlight.get(commandId);
    if (!completed) return "ignored";
    this.inFlight.delete(commandId);
    if (completed.final) {
      this.reset();
      return "complete";
    }
    if (!ok && this.finalRequested) return "streaming";
    return "streaming";
  }

  cancel(): void {
    this.reset();
  }

  private schedule(): void {
    if (!this.latestUtc || this.timer !== undefined) return;
    const delayMs = this.lastSentAtMs + this.intervalMs - this.now();
    if (delayMs <= 0) {
      this.dispatch(false);
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.dispatch(this.finalRequested);
    }, delayMs);
  }

  private dispatch(final: boolean): void {
    if (!this.latestUtc) return;
    const utc = this.latestUtc;
    const commandId = this.send(utc, final);
    if (!commandId) {
      this.reset();
      return;
    }
    this.inFlight.set(commandId, { final });
    this.lastSentAtMs = this.now();
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private reset(): void {
    this.cancelTimer();
    this.latestUtc = undefined;
    this.inFlight.clear();
    this.finalRequested = false;
    this.lastSentAtMs = Number.NEGATIVE_INFINITY;
  }
}
