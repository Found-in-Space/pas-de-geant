import type { SkykitPlugin } from "@found-in-space/skykit";
import { createSkykitXrControlBindings } from "@found-in-space/skykit/xr";
import { getGeantContext, type GeantContext } from "../viewer.js";
import {
  defineGeantControlScheme, geantControlInputKey, standardGeantControlScheme,
  type GeantButtonInput, type GeantControlBinding, type GeantControlInput, type GeantControlScheme, type GeantPointerMode,
} from "../navigation/control-scheme.js";
import { GEANT_MOTION_ACTIONS } from "../navigation/motion.js";

export interface GeantControlsOptions {
  readonly scheme?: GeantControlScheme;
  readonly keyboard?: boolean;
  readonly pointer?: GeantPointerMode;
  readonly movement?: boolean;
  readonly speedHeadsetMPerSecond?: number;
}
const owners = new WeakSet<GeantContext>();
const hands = ["left", "right"] as const;
const buttons = ["trigger", "grip", "primary", "secondary"] as const;

/** One input owner per viewer; all schemes and extensions use its action path. */
export function createGeantControlsPlugin(options: GeantControlsOptions = {}) {
  let scheme = defineGeantControlScheme(options.scheme ?? standardGeantControlScheme);
  let resetInput = () => {};
  let disposed = false;
  let installed = false;
  const plugin = {
    id: "geant:controls",
    setScheme(next: GeantControlScheme) {
      if (disposed) throw new Error("Controls are disposed.");
      const resolved = defineGeantControlScheme(next);
      resetInput(); scheme = resolved;
    },
    getSnapshot() { return { scheme, disposed }; },
    setup(context) {
      const geant = getGeantContext(context), host = geant.host;
      if (disposed || installed) throw new Error("Create a fresh controls plugin for each viewer.");
      if (!host) throw new Error("Browser controls require a host.");
      if (owners.has(geant)) throw new Error("This viewer already has controls. Extend its scheme instead.");
      owners.add(geant);
      installed = true;
      const canvas = geant.renderer.domElement;
      const abort = new AbortController(), signal = abort.signal;
      const keys = new Set<string>(), presses = new Set<string>(), blockedKeys = new Set<string>();
      const exclusive = new Map<string, string>();
      const axisPresses = new Set<string>();
      let movementRevision = geant.movementRevision;
      const removers: Array<() => void> = [];
      const xr = createSkykitXrControlBindings({
        deadzone: 0.25,
        axes: Object.fromEntries(hands.map(hand => [hand, { hand }])),
        buttons: Object.fromEntries(hands.flatMap(hand => buttons.map(button => [`${hand}:${button}`, { hand, button }]))),
      });
      let pointer: { id: number; x: number; y: number } | undefined;
      let dragX = 0, dragY = 0, wheel = 0;
      let session: XRSession | null = null, sources: XRInputSource[] = [], needsNeutral = true;
      let generation = 0;
      let mode = geant.navigation.mode, body = geant.navigation.focusBody;
      const pointerMode = options.pointer ?? "look";

      function releasePointer() {
        const id = pointer?.id; pointer = undefined;
        if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      }
      function clear() {
        generation++;
        for (const key of keys) blockedKeys.add(key);
        keys.clear(); presses.clear(); exclusive.clear(); axisPresses.clear();
        releasePointer(); dragX = dragY = wheel = 0;
        xr.reset(); needsNeutral = true;
      }
      resetInput = clear;
      const teardown = context.addDisposable(() => {
        if (disposed) return;
        clear(); abort.abort(); xr.dispose(); owners.delete(geant); disposed = true; resetInput = () => {};
        for (const remove of removers.reverse()) remove();
      });
      removers.push(geant.navigation.subscribe(state => {
        if (mode !== state.mode || body !== state.focusBody) { mode = state.mode; body = state.focusBody; clear(); }
      }));
      host.addEventListener("blur", clear, { signal });
      host.ownerDocument.addEventListener("visibilitychange", clear, { signal });
      host.ownerDocument.defaultView?.addEventListener("blur", clear, { signal });
      // Releases can occur outside the focused host after a blur.
      host.ownerDocument.defaultView?.addEventListener("keyup", event => {
        keys.delete(event.code); blockedKeys.delete(event.code);
      }, { signal });
      const editable = (target: EventTarget | null) => {
        const element = target as HTMLElement | null;
        return element?.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(element?.tagName ?? "");
      };
      function accepts(binding: GeantControlBinding): boolean {
        return (!binding.modes || binding.modes.includes(mode)) &&
          (!binding.pointerModes || binding.pointerModes.includes(pointerMode)) &&
          (options.movement !== false || binding.category === "look" || binding.category === "feature");
      }
      if (options.keyboard !== false) {
        host.addEventListener("keydown", event => {
          if (editable(event.target) || blockedKeys.has(event.code)) return;
          if (!scheme.bindings.some(binding => accepts(binding) && [binding.input, ...(binding.modifiers ?? []), ...(binding.unless ?? [])]
            .some(input => input.kind === "key" && input.code === event.code))) return;
          if (!event.repeat && !keys.has(event.code)) presses.add(event.code);
          keys.add(event.code); event.preventDefault();
        }, { signal });
        host.addEventListener("keyup", event => { keys.delete(event.code); blockedKeys.delete(event.code); }, { signal });
      }
      canvas.addEventListener("pointerdown", event => {
        host.focus({ preventScroll: true });
        if (pointerMode === "none" || geant.renderer.xr?.isPresenting) return;
        releasePointer();
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
      }, { signal });
      canvas.addEventListener("pointermove", event => {
        if (!pointer || pointer.id !== event.pointerId || geant.renderer.xr?.isPresenting) return;
        dragX += event.clientX - pointer.x; dragY += event.clientY - pointer.y;
        pointer.x = event.clientX; pointer.y = event.clientY;
      }, { signal });
      canvas.addEventListener("pointerup", event => { if (pointer?.id === event.pointerId) releasePointer(); }, { signal });
      for (const type of ["pointercancel", "lostpointercapture"] as const) canvas.addEventListener(type, () => {
        releasePointer(); dragX = dragY = 0;
      }, { signal });
      canvas.addEventListener("wheel", event => {
        if (pointerMode === "none" || geant.renderer.xr?.isPresenting ||
            !scheme.bindings.some(binding => accepts(binding) && binding.input.kind === "wheel")) return;
        event.preventDefault(); wheel += event.deltaY;
      }, { signal, passive: false });

      function raw(input: GeantControlInput, edge = false): number {
        switch (input.kind) {
          case "key": return Number((edge ? presses : keys).has(input.code));
          case "drag": return input.axis === "x" ? dragX : dragY;
          case "wheel": return wheel;
          case "xr-axis": return needsNeutral ? 0 : xr.getAxis(input.hand)[input.axis];
          case "xr-button": {
            const button = xr.getButton(`${input.hand}:${input.button}`);
            return needsNeutral ? 0 : Number(edge ? button.pressedEdge : button.pressed);
          }
        }
      }
      function pressed(input: GeantButtonInput) { return raw(input) !== 0; }
      removers.push(context.addPart({ id: "geant:manual-input", priority: -100, update(frame) {
        if (movementRevision !== geant.movementRevision) { clear(); movementRevision = geant.movementRevision; }
        const activeSession = geant.renderer.xr?.isPresenting ? geant.renderer.xr.getSession() : null;
        const activeSources = [...(activeSession?.inputSources ?? [])];
        if (activeSession !== session || activeSources.length !== sources.length || activeSources.some((source, index) => source !== sources[index])) {
          clear(); session = activeSession; sources = activeSources;
        }
        xr.update({ inputSources: activeSources });
        if (needsNeutral && hands.every(hand => !xr.getAxis(hand).active && buttons.every(button => !xr.isPressed(`${hand}:${button}`)))) needsNeutral = false;
        const candidates = scheme.bindings.filter(binding => accepts(binding) &&
          (activeSession ? binding.input.kind.startsWith("xr-") : !binding.input.kind.startsWith("xr-")) &&
          (binding.modifiers ?? []).every(pressed) && !(binding.unless ?? []).some(pressed));
        const values = new Map<GeantControlBinding, number>();
        for (const binding of candidates) {
          const edge = (binding.input.kind === "key" || binding.input.kind === "xr-button") && binding.phase !== "hold";
          let value = raw(binding.input, edge);
          if (binding.input.kind === "xr-axis" && binding.phase === "press") {
            const wasActive = axisPresses.has(binding.id);
            if (value) axisPresses.add(binding.id); else axisPresses.delete(binding.id);
            value = wasActive ? 0 : Math.sign(value);
          }
          values.set(binding, value);
        }
        const groups = new Map<string, GeantControlBinding[]>();
        // Neutral means the physical group is released, even if a modifier or
        // navigation mode currently excludes one of its bindings.
        for (const binding of scheme.bindings) if (binding.exclusiveGroup) {
          const group = groups.get(binding.exclusiveGroup) ?? []; group.push(binding); groups.set(binding.exclusiveGroup, group);
        }
        for (const [name, group] of groups) {
          if (group.every(binding => !raw(binding.input))) exclusive.delete(name);
          if (!exclusive.has(name)) {
            const strongest = [...group].sort((a, b) => Math.abs(values.get(b) ?? 0) - Math.abs(values.get(a) ?? 0))[0]!;
            if (values.get(strongest)) exclusive.set(name, geantControlInputKey(strongest.input));
          }
          for (const binding of group) if (exclusive.get(name) !== geantControlInputKey(binding.input)) values.set(binding, 0);
        }
        const commands = new Map<string, { action: string; payload: Record<string, unknown> }>();
        for (const [binding, rawValue] of values) {
          if (!rawValue) continue;
          const value = rawValue * (binding.multiplier ?? 1) * (binding.timeScale ? frame.deltaSeconds : 1);
          const key = JSON.stringify([binding.action, binding.payload ?? {}]);
          const command = commands.get(key) ?? { action: binding.action, payload: { ...binding.payload, deltaSeconds: frame.deltaSeconds } };
          const component = binding.component ?? "value";
          command.payload[component] = Number(command.payload[component] ?? 0) + value;
          commands.set(key, command);
        }
        // Consume impulses before invoking actions: a mode-changing action can clear input.
        presses.clear(); dragX = dragY = wheel = 0;
        const inputGeneration = generation;
        for (const command of commands.values()) {
          if (generation !== inputGeneration) break;
          if (command.action === GEANT_MOTION_ACTIONS.move && options.speedHeadsetMPerSecond !== undefined) {
            command.payload.speedHeadsetMPerSecond = options.speedHeadsetMPerSecond;
          }
          void context.actions.invoke(command.action, command.payload, { source: activeSession ? "xr" : "desktop" });
        }
      } }));
      return teardown;
    },
  } satisfies SkykitPlugin & {
    setScheme(next: GeantControlScheme): void;
    getSnapshot(): { scheme: GeantControlScheme; disposed: boolean };
  };
  return plugin;
}
export type GeantControlsPlugin = ReturnType<typeof createGeantControlsPlugin>;
