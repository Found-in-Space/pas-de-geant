import type { NavigationMode } from "../worlds/world-navigation.js";
import { GEANT_MOTION_ACTIONS } from "./motion.js";

export type GeantPointerMode = "look" | "grab" | "orbit" | "none";
export type GeantXrButton = "trigger" | "grip" | "primary" | "secondary";
export type GeantButtonInput =
  | { readonly kind: "key"; readonly code: string }
  | { readonly kind: "xr-button"; readonly hand: "left" | "right"; readonly button: GeantXrButton };
export type GeantControlInput = GeantButtonInput
  | { readonly kind: "xr-axis"; readonly hand: "left" | "right"; readonly axis: "x" | "y" }
  | { readonly kind: "drag"; readonly axis: "x" | "y" }
  | { readonly kind: "wheel" };

/** Bindings invoke public actions. Held inputs are integrated once per frame. */
export interface GeantControlBinding {
  readonly id: string;
  readonly label: string;
  readonly input: GeantControlInput;
  readonly action: string;
  readonly component?: string;
  readonly multiplier?: number;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly phase?: "press" | "hold";
  /** Multiply an angular rate by frame time; pixel gestures already give a displacement. */
  readonly timeScale?: boolean;
  readonly modes?: readonly NavigationMode[];
  readonly pointerModes?: readonly GeantPointerMode[];
  readonly modifiers?: readonly GeantButtonInput[];
  readonly unless?: readonly GeantButtonInput[];
  readonly category?: "movement" | "look" | "feature";
  /** Latch one axis until all inputs in this group return to neutral. */
  readonly exclusiveGroup?: string;
}
export interface GeantControlScheme {
  readonly id: string;
  readonly bindings: readonly GeantControlBinding[];
}
export interface GeantControlSchemeExtension {
  readonly id: string;
  readonly add?: readonly GeantControlBinding[];
  readonly replace?: readonly GeantControlBinding[];
  readonly remove?: readonly string[];
}

function freezeData<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
export function geantControlInputKey(input: GeantControlInput): string {
  switch (input.kind) {
    case "key": return `key:${input.code}`;
    case "xr-button": return `xr:${input.hand}:${input.button}`;
    case "xr-axis": return `xr:${input.hand}:${input.axis}`;
    case "drag": return `drag:${input.axis}`;
    case "wheel": return "wheel";
  }
}
function overlaps<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  return !a || !b || a.some(value => b.includes(value));
}
function conflicts(a: GeantControlBinding, b: GeantControlBinding): boolean {
  if (geantControlInputKey(a.input) !== geantControlInputKey(b.input) ||
      !overlaps(a.modes, b.modes) || !overlaps(a.pointerModes, b.pointerModes)) return false;
  const required = [...(a.modifiers ?? []), ...(b.modifiers ?? [])].map(geantControlInputKey);
  const forbidden = [...(a.unless ?? []), ...(b.unless ?? [])].map(geantControlInputKey);
  return !required.some(key => forbidden.includes(key));
}
/** Clone and freeze data so extending or installing a scheme never mutates its source. */
export function defineGeantControlScheme(scheme: GeantControlScheme): GeantControlScheme {
  const copy = structuredClone(scheme);
  const ids = new Set<string>();
  for (let index = 0; index < copy.bindings.length; index++) {
    const binding = copy.bindings[index]!;
    if (!binding.id || !binding.action || ids.has(binding.id)) throw new Error(`Duplicate or empty control binding: ${binding.id}`);
    ids.add(binding.id);
    if (binding.multiplier !== undefined && !Number.isFinite(binding.multiplier)) throw new Error(`Invalid multiplier: ${binding.id}`);
    for (const previous of copy.bindings.slice(0, index)) {
      if (conflicts(binding, previous)) throw new Error(`Conflicting controls: ${previous.id} and ${binding.id}. Replace a binding or use disjoint conditions.`);
    }
  }
  return freezeData(copy);
}
export function extendGeantControlScheme(base: GeantControlScheme, extension: GeantControlSchemeExtension): GeantControlScheme {
  const bindings = new Map(base.bindings.map(binding => [binding.id, binding]));
  for (const id of extension.remove ?? []) {
    if (!bindings.delete(id)) throw new Error(`Cannot remove unknown control: ${id}`);
  }
  for (const binding of extension.replace ?? []) {
    if (!bindings.has(binding.id)) throw new Error(`Cannot replace unknown control: ${binding.id}`);
    bindings.set(binding.id, binding);
  }
  for (const binding of extension.add ?? []) {
    if (bindings.has(binding.id)) throw new Error(`Control already exists: ${binding.id}. Use replace.`);
    bindings.set(binding.id, binding);
  }
  return defineGeantControlScheme({ id: extension.id, bindings: [...bindings.values()] });
}

/** Labels derive from the installed bindings, including authored extensions. */
export function describeGeantControlScheme(scheme: GeantControlScheme): readonly string[] {
  const name = (input: GeantControlInput): string => {
    switch (input.kind) {
      case "key": return input.code.replace(/^Key/, "");
      case "xr-button": return `${input.hand} ${input.button}`;
      case "xr-axis": return `${input.hand} stick ${input.axis}`;
      case "drag": return `drag ${input.axis}`;
      case "wheel": return "wheel";
    }
  };
  return scheme.bindings.map(binding => `${[...(binding.modifiers ?? []).map(name), name(binding.input)].join(" + ")}: ${binding.label}` +
    (binding.modes ? ` (${binding.modes.join(", ")})` : "") +
    (binding.pointerModes ? ` [pointer: ${binding.pointerModes.join(", ")}]` : ""));
}

const bindings: GeantControlBinding[] = [];
const move = GEANT_MOTION_ACTIONS.move, orbit = GEANT_MOTION_ACTIONS.orbit;
for (const [code, component, multiplier] of [
  ["KeyW", "forward", 1], ["KeyS", "forward", -1], ["KeyD", "right", 1], ["KeyA", "right", -1],
] as const) {
  bindings.push({ id: `keyboard.${code}.move`, label: "Travel", input: { kind: "key", code }, action: move,
    component, multiplier, phase: "hold", modes: ["surface", "free", "ship"] });
  bindings.push({ id: `keyboard.${code}.orbit`, label: "Orbit focused body", input: { kind: "key", code }, action: orbit,
    component: component === "forward" ? "y" : "x", multiplier, phase: "hold", modes: ["orbit", "observation"] });
}
for (const [code, multiplier] of [["KeyX", 1], ["KeyZ", -1]] as const) {
  bindings.push({ id: `keyboard.${code}.scale`, label: "Change world scale", input: { kind: "key", code },
    action: GEANT_MOTION_ACTIONS.scale, multiplier, phase: "hold" });
}
for (const [code, multiplier] of [["KeyV", 1], ["KeyC", -1]] as const) {
  bindings.push({ id: `keyboard.${code}.distance`, label: "Change orbital distance", input: { kind: "key", code },
    action: GEANT_MOTION_ACTIONS.orbitDistance, multiplier, phase: "hold", modes: ["orbit", "observation"] });
}
for (const code of ["ShiftLeft", "ShiftRight"]) {
  for (const [action, modes] of [[move, ["surface", "free", "ship"]], [orbit, ["orbit", "observation"]]] as const) {
    bindings.push({ id: `keyboard.${code}.${action}`, label: "Faster travel", input: { kind: "key", code },
      action, component: "boost", phase: "hold", modes });
  }
}
for (const axis of ["x", "y"] as const) {
  bindings.push({ id: `pointer.look.${axis}`, label: "Look around", input: { kind: "drag", axis }, action: GEANT_MOTION_ACTIONS.look,
    component: axis === "x" ? "yawRadians" : "pitchRadians", multiplier: -0.0035, category: "look",
    modes: ["surface"], pointerModes: ["look"] });
  bindings.push({ id: `pointer.look.${axis}.free`, label: "Look around", input: { kind: "drag", axis }, action: GEANT_MOTION_ACTIONS.look,
    component: axis === "x" ? "yawRadians" : "pitchRadians", multiplier: -0.0035, category: "look",
    modes: ["free", "ship"], pointerModes: ["look", "grab"] });
  bindings.push({ id: `pointer.orbit.${axis}`, label: "Orbit focused body", input: { kind: "drag", axis }, action: orbit,
    component: axis, payload: { drag: true }, modes: ["orbit", "observation"] });
}
for (const axis of ["x", "y"] as const) bindings.push({ id: `pointer.grab.${axis}`, label: "Drag the surface",
  input: { kind: "drag", axis }, action: GEANT_MOTION_ACTIONS.surfaceDrag, component: axis,
  modes: ["surface"], pointerModes: ["grab"] });
bindings.push({ id: "pointer.wheel.scale", label: "Change world scale", input: { kind: "wheel" },
  action: GEANT_MOTION_ACTIONS.scale, payload: { wheel: true }, modes: ["surface", "free", "ship"] });
bindings.push({ id: "pointer.wheel.distance", label: "Change orbital distance", input: { kind: "wheel" },
  action: GEANT_MOTION_ACTIONS.orbitDistance, payload: { wheel: true }, modes: ["orbit", "observation"] });

const surfaceModes = ["surface", "observation", "orbit"];
const shipModes = ["ship", "free"];
for (const axis of ["x", "y"] as const) {
  bindings.push({ id: `xr.travel.${axis}`, label: "Move across the surface", input: { kind: "xr-axis", hand: "left", axis }, action: move,
    component: axis === "x" ? "right" : "forward", multiplier: axis === "x" ? 1 : -1, modes: surfaceModes });
  bindings.push({ id: `xr.ship.travel.${axis}`, label: "Move in the ship frame", input: { kind: "xr-axis", hand: "right", axis }, action: move,
    component: axis === "x" ? "right" : "forward", multiplier: axis === "x" ? 1 : -1, modes: shipModes });
}
bindings.push({ id: "xr.turn", label: "Snap turn 30 degrees", input: { kind: "xr-axis", hand: "right", axis: "x" },
  action: GEANT_MOTION_ACTIONS.look, component: "yawRadians", multiplier: -Math.PI / 6, phase: "press",
  modes: surfaceModes, category: "look", exclusiveGroup: "surface-right-stick" });
bindings.push({ id: "xr.altitude", label: "Adjust altitude above planetary ground", input: { kind: "xr-axis", hand: "right", axis: "y" },
  action: GEANT_MOTION_ACTIONS.altitude, multiplier: -1, modes: surfaceModes, exclusiveGroup: "surface-right-stick" });
bindings.push({ id: "xr.boost", label: "Faster surface travel", input: { kind: "xr-button", hand: "left", button: "grip" },
  action: move, component: "boost", phase: "hold", modes: surfaceModes });
bindings.push({ id: "xr.ship.boost", label: "Faster ship travel", input: { kind: "xr-button", hand: "right", button: "grip" },
  action: move, component: "boost", phase: "hold", modes: shipModes });
const rollModifier: GeantButtonInput = { kind: "xr-button", hand: "left", button: "grip" };
bindings.push({ id: "xr.ship.yaw", label: "Ship yaw", input: { kind: "xr-axis", hand: "left", axis: "x" },
  action: GEANT_MOTION_ACTIONS.attitude, component: "yaw", multiplier: -1, unless: [rollModifier], modes: shipModes });
bindings.push({ id: "xr.ship.roll", label: "Ship roll with left grip held", input: { kind: "xr-axis", hand: "left", axis: "x" },
  action: GEANT_MOTION_ACTIONS.attitude, component: "roll", modifiers: [rollModifier], modes: shipModes });
bindings.push({ id: "xr.ship.pitch", label: "Ship pitch", input: { kind: "xr-axis", hand: "left", axis: "y" },
  action: GEANT_MOTION_ACTIONS.attitude, component: "pitch", modes: shipModes });

/** Optional browser preset. Hosts can supply a completely different scheme. */
export const standardGeantControlScheme = defineGeantControlScheme({ id: "geant:standard", bindings });
