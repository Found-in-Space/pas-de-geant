import type { GeantNavigation } from "./navigation/controller.js";
import { simulationTimeMs } from "./navigation/simulation-clock.js";

export interface GeantSimulationTimeSnapshot {
  /** Absolute simulation time, in UTC Unix milliseconds. */
  readonly atMs: number;
  /** Signed simulation seconds per real second; zero pauses playback. */
  readonly rate: number;
  /** Signed change since the preceding viewer frame, including seeks. */
  readonly deltaMs: number;
  /** Increments when the clock is set, including seeks and rate changes. */
  readonly revision: number;
  readonly discontinuity: boolean;
}
export type GeantSimulationTimeReason = "initial" | "advance" | "clock";
export type GeantSimulationTimeListener = (time: GeantSimulationTimeSnapshot, reason: GeantSimulationTimeReason) => void;
/** A read-only clock shared by renderers and observation providers. */
export interface GeantSimulationTime {
  getSnapshot(): GeantSimulationTimeSnapshot;
  /** Delivers the current sample immediately, then advances and clock changes. */
  subscribe(listener: GeantSimulationTimeListener, options?: { readonly signal?: AbortSignal }): () => void;
}

/** Navigation owns the clock; the viewer samples it before its frame parts run. */
export function createGeantSimulationTime(navigation: Pick<GeantNavigation, "getClock" | "subscribe">) {
  let clock = navigation.getClock();
  let snapshot: GeantSimulationTimeSnapshot = Object.freeze({ atMs: simulationTimeMs(clock), rate: clock.scale,
    deltaMs: 0, revision: 0, discontinuity: false });
  let frameAtMs = snapshot.atMs, pendingDiscontinuity = false;
  const listeners = new Set<GeantSimulationTimeListener>();
  const removers = new Set<() => void>();
  let disposed = false;
  function publish(reason: GeantSimulationTimeReason) {
    const published = snapshot;
    for (const listener of [...listeners]) if (listeners.has(listener)) listener(published, reason);
  }
  const unsubscribe = navigation.subscribe(() => {
    const next = navigation.getClock();
    if (next.anchorWallTimeMs === clock.anchorWallTimeMs && next.offsetMs === clock.offsetMs && next.scale === clock.scale) return;
    const now = Date.now(), previousAtNow = simulationTimeMs(clock, now), atMs = simulationTimeMs(next, now);
    pendingDiscontinuity ||= atMs !== previousAtNow;
    clock = next;
    snapshot = Object.freeze({ atMs, rate: clock.scale, deltaMs: atMs - frameAtMs,
      revision: snapshot.revision + 1, discontinuity: pendingDiscontinuity });
    publish("clock");
  });
  const time: GeantSimulationTime = {
    getSnapshot: () => snapshot,
    subscribe(listener, options = {}) {
      if (disposed) throw new Error("Simulation time is disposed.");
      if (options.signal?.aborted) return () => {};
      // Subscriptions have independent lifetimes even when they reuse a callback.
      const notify: GeantSimulationTimeListener = (sample, reason) => listener(sample, reason);
      const remove = () => { listeners.delete(notify); removers.delete(remove); options.signal?.removeEventListener("abort", remove); };
      listeners.add(notify); removers.add(remove);
      options.signal?.addEventListener("abort", remove, { once: true });
      try { notify(snapshot, "initial"); } catch (error) { remove(); throw error; }
      return remove;
    },
  };
  return { time,
    sample() {
      const atMs = simulationTimeMs(clock), changed = atMs !== snapshot.atMs;
      snapshot = Object.freeze({ atMs, rate: clock.scale, deltaMs: atMs - frameAtMs,
        revision: snapshot.revision, discontinuity: pendingDiscontinuity });
      frameAtMs = atMs; pendingDiscontinuity = false;
      if (changed) publish("advance");
    },
    dispose() { disposed = true; unsubscribe(); for (const remove of [...removers]) remove(); },
  };
}
