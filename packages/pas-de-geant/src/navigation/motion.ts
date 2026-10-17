import type { SkykitActionRegistry } from "../skykit-runtime.js";
import type { GeantContext } from "../viewer.js";
import { GEANT_ACTIONS } from "./controller.js";
import { scaleDenominatorAfterInput } from "./policy.js";
import { movementNumber } from "./movement-model.js";

/** Device-independent commands. Models supply their behavior. */
export const GEANT_MOTION_ACTIONS = Object.freeze({
  move: "geant:navigation.move", orbit: "geant:navigation.orbitStep",
  orbitDistance: "geant:navigation.adjustOrbitDistance", surfaceDrag: "geant:navigation.dragSurface",
  altitude: "geant:navigation.adjustAltitude", attitude: "geant:navigation.attitude", recenter: "geant:navigation.recenter",
  scale: "geant:scale.adjust", look: "geant:view.look",
});
export function registerGeantMotionActions(geant: GeantContext, actions: SkykitActionRegistry): () => void {
  const unregisters = Object.values(GEANT_MOTION_ACTIONS).map(action => actions.registerAction(action, ({ payload, metadata }) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Motion arguments are required.");
    const input = payload as Record<string, unknown>;
    if (action === GEANT_MOTION_ACTIONS.scale) {
      const value = movementNumber(input, "value"), denominator = geant.navigation.scaleDenominator;
      return actions.invoke(GEANT_ACTIONS.setScale, { scaleDenominator: input.wheel ? denominator * 2 ** (value / 600)
        : scaleDenominatorAfterInput(denominator, value, movementNumber(input, "deltaSeconds")) }, metadata).then(results => {
        for (const result of results) if (result.status === "rejected") throw result.reason;
        return results;
      });
    }
    if (!geant.movement) throw new Error("Install a movement adapter before invoking movement commands.");
    return geant.movement.command(action, input, metadata);
  }));
  return () => { for (const unregister of unregisters.reverse()) unregister(); };
}
