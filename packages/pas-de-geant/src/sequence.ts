import type { JourneyOperation } from "@found-in-space/guided-journey";
import type { JourneySequencePlayer, SequenceContext, SequenceFrame, SequenceParticipant } from "@found-in-space/guided-journey/sequence";
import type { GeantBodyPoseCamera, GeantJourneyServices } from "./journey.js";
import { getGeantContext } from "./viewer.js";
import type { SkykitPlugin } from "./skykit-runtime.js";

export interface GeantSequenceValue {
  readonly camera: GeantBodyPoseCamera;
  /** Optional explicit world UTC milliseconds, independent of presentation/mission time. */
  readonly atMs?: number;
}
let nextParticipant = 0;

/** Schedule a borrowed shared player and its scene consumers in Geant's existing loop. */
export function createGeantSequencePlugin<Value>(options: {
  player: JourneySequencePlayer<Value>;
  id?: string;
  /** Synchronous target/caption presentation using the very same evaluated sample. */
  onFrame?: (frame: SequenceFrame<Value>) => void;
}): SkykitPlugin {
  const id = options.id ?? `geant:sequence-clock:${++nextParticipant}`;
  return { id, setup(context) {
    getGeantContext(context);
    return context.addPart({ id, priority: -175, update(frame) {
      const sample = options.player.update(frame.deltaSeconds);
      options.onFrame?.(sample);
    } });
  } };
}

/** The shared player owns time; the ordinary Geant movement adapter owns placement. */
export function createGeantSequenceParticipant({ browser, navigation,
  id = `geant:sequence:${++nextParticipant}`, durationSecs = 2,
}: GeantJourneyServices & { id?: string; durationSecs?: number }): SequenceParticipant<GeantSequenceValue> & { dispose(): void } {
  if (!Number.isFinite(durationSecs) || durationSecs < 0) throw new RangeError("Join duration must be nonnegative seconds.");
  let disposed = false, owner: SequenceContext | null = null, operation: JourneyOperation | null = null;
  const removers: Array<() => void> = [], acknowledgements: Array<() => void> = [];
  const acknowledge = () => { for (const resolve of acknowledgements.splice(0)) resolve(); };
  // Resolve only after movement (-50), world measurement (0) and arrival (1).
  const removePart = browser.viewer.addPart({ id, priority: 2, update: acknowledge });
  const removeDispose = browser.addDisposable(dispose);
  function validate(value: GeantSequenceValue) {
    if (value.atMs !== undefined && !Number.isFinite(value.atMs)) throw new RangeError("World epoch must be finite UTC milliseconds.");
  }
  function release() {
    for (const remove of removers.splice(0)) remove();
    const previous = operation; operation = null; owner = null;
    // A newer chapter or sequence may already own the same navigation adapter.
    if (previous && navigation.getSnapshot().operation === previous) navigation.cancel();
    acknowledge();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; owner?.cancel(); release(); removePart(); removeDispose();
  }
  return {
    join(frame, context) {
      if (disposed) throw new Error("Sequence participant is disposed.");
      validate(frame.value);
      owner = context;
      const next = navigation.transitionTo(frame.value.camera, { signal: context.signal, durationSecs });
      operation = next;
      removers.push(navigation.subscribe(snapshot => {
        if (!snapshot.holding || snapshot.operation !== next) context.cancel();
      }));
      return next;
    },
    apply(frame, context) {
      if (disposed || !context.isCurrent()) return;
      validate(frame.value);
      navigation.applyPose(frame.value.camera);
      if (frame.value.atMs !== undefined) navigation.setTime({ atMs: frame.value.atMs, rate: 0 });
      return new Promise<void>(resolve => { acknowledgements.push(resolve); });
    },
    release, dispose,
  };
}
