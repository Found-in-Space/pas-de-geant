import { Vector2 } from "three";
import type { SkykitActionRegistry } from "../skykit-runtime.js";
import { finiteNumber, geantLocation, type ResolvedGeantConfiguration } from "../config.js";
import { celestialBody, type SolarSystemBodyId, type Vector3d } from "../worlds/solar-system.js";
import { contactFrame, coordinatesForFrame, rollContactFrame, type ContactFrame } from "../worlds/planet-state.js";
import { validScaleDenominator } from "../worlds/world-scale.js";
import type { NavigationMode, SurfaceLocation } from "../worlds/world-navigation.js";
import { anchoredSimulationClock, simulationTimeMs, type SimulationClockState } from "./simulation-clock.js";

export const GEANT_ACTIONS = Object.freeze({ setLocation: "geant:navigation.setLocation", setMode: "geant:navigation.setMode",
  focusBody: "geant:body.focus", setScale: "geant:scale.set", setTerrainMultiplier: "geant:terrain.setMultiplier",
  setAltitude: "geant:navigation.setAltitude", travel: "geant:navigation.travel", setObserver: "geant:navigation.setObserver", setTime: "geant:time.set" });
export interface GeantSnapshot {
  readonly bodies: readonly SolarSystemBodyId[];
  readonly focusBody: SolarSystemBodyId;
  readonly mode: NavigationMode;
  readonly scaleDenominator: number;
  readonly terrainMultiplier: number;
  readonly locations: Readonly<Partial<Record<SolarSystemBodyId, SurfaceLocation>>>;
  readonly observerJ2000M: Vector3d | null;
  readonly time: number;
  readonly timeRate: number;
  readonly revision: number;
}
/** Successful explicit commands, including direct dispatches outside the action registry. */
export interface GeantNavigationCommand {
  readonly action: string;
  readonly payload: unknown;
  /** Optional caller identity for coordinated owners; never inferred from the action name. */
  readonly source?: unknown;
}
function payload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("An action payload object is required.");
  return value as Record<string, unknown>;
}
function numeric(value: unknown, name: string): number {
  if (typeof value !== "number") throw new TypeError(`${name} must be a number.`);
  return finiteNumber(value, name);
}
/** Physical state is independent of renderer objects. Contacts retain transported tangent frames. */
export function createGeantNavigation(configuration: ResolvedGeantConfiguration) {
  let focusBody = configuration.focusBody;
  let mode = configuration.mode;
  let scaleDenominator = configuration.scaleDenominator;
  let terrainMultiplier = configuration.terrainMultiplier;
  let observer: Vector3d | null = null;
  let revision = 0;
  let disposed = false;
  let clock: SimulationClockState = anchoredSimulationClock(configuration.time === "now" ? Date.now() : Date.parse(configuration.time), configuration.timeRate);
  const locations = new Map<SolarSystemBodyId, SurfaceLocation>();
  const contacts = new Map<SolarSystemBodyId, ContactFrame>();
  const actionAdapters = new Map<string, (payload: unknown) => unknown>();
  const listeners = new Set<(snapshot: GeantSnapshot) => void>();
  const commandListeners = new Set<(command: GeantNavigationCommand) => void>();
  for (const body of configuration.bodies) {
    const location = configuration.locations[body]!;
    locations.set(body, { ...location });
    contacts.set(body, contactFrame(location.latitudeDegrees, location.longitudeDegrees));
  }
  function assertActive() { if (disposed) throw new Error("Geant navigation is disposed."); }
  function selected(body: unknown): SolarSystemBodyId {
    if (typeof body !== "string" || !configuration.bodies.includes(body as SolarSystemBodyId)) throw new RangeError("Body is not selected.");
    return body as SolarSystemBodyId;
  }
  function snapshot(): GeantSnapshot {
    return { bodies: [...configuration.bodies], focusBody, mode, scaleDenominator, terrainMultiplier,
      locations: Object.fromEntries([...locations].map(([body, location]) => [body, { ...location }])),
      observerJ2000M: observer ? { ...observer } : null, time: simulationTimeMs(clock), timeRate: clock.scale, revision };
  }
  function publish() { revision++; const state = snapshot(); for (const listener of listeners) listener(state); }
  function commandResult(action: string, value: unknown, source: unknown, changed = true): GeantSnapshot {
    if (changed) publish();
    for (const listener of [...commandListeners]) if (commandListeners.has(listener)) listener({ action, payload: value, source });
    return snapshot();
  }
  function dispatch(action: string, value: unknown, source?: unknown): GeantSnapshot {
    assertActive(); const args = payload(value);
    switch (action) {
      case GEANT_ACTIONS.setLocation: {
        const body = selected(args.body ?? focusBody);
        const location = geantLocation({ ...locations.get(body), latitudeDegrees: numeric(args.latitudeDegrees, "Latitude"),
          longitudeDegrees: numeric(args.longitudeDegrees, "Longitude"),
          ...(args.altitudeM === undefined ? {} : { altitudeM: numeric(args.altitudeM, "Altitude") }),
          ...(args.headingDegrees === undefined ? {} : { headingDegrees: numeric(args.headingDegrees, "Heading") }) });
        locations.set(body, location); contacts.set(body, contactFrame(location.latitudeDegrees, location.longitudeDegrees)); break;
      }
      case GEANT_ACTIONS.focusBody: {
        const body = selected(args.body);
        focusBody = body; break;
      }
      case GEANT_ACTIONS.setMode: {
        if (typeof args.mode !== "string" || !args.mode.trim()) throw new RangeError("A navigation label is required.");
        mode = args.mode as NavigationMode; break;
      }
      case GEANT_ACTIONS.setScale: {
        const next = validScaleDenominator(numeric(args.scaleDenominator, "Scale denominator"));
        if (next === scaleDenominator) return commandResult(action, value, source, false); scaleDenominator = next; break;
      }
      case GEANT_ACTIONS.setTerrainMultiplier: {
        const multiplier = numeric(args.multiplier, "Terrain multiplier");
        if (multiplier < 0) throw new RangeError("Terrain multiplier must be nonnegative.");
        if (multiplier === terrainMultiplier) return commandResult(action, value, source, false); terrainMultiplier = multiplier; break;
      }
      case GEANT_ACTIONS.setAltitude: {
        const body = selected(args.body ?? focusBody);
        locations.set(body, { ...locations.get(body)!, altitudeM: numeric(args.altitudeM, "Altitude") }); break;
      }
      case GEANT_ACTIONS.travel: {
        const eastM = numeric(args.eastM, "East displacement"), northM = numeric(args.northM, "North displacement");
        const contact = rollContactFrame(contacts.get(focusBody)!, new Vector2(eastM, -northM), celestialBody(focusBody).referenceRadiusM);
        contacts.set(focusBody, contact); locations.set(focusBody, { ...locations.get(focusBody)!, ...coordinatesForFrame(contact) }); break;
      }
      case GEANT_ACTIONS.setObserver: observer = { x: numeric(args.x, "X"), y: numeric(args.y, "Y"), z: numeric(args.z, "Z") }; break;
      case GEANT_ACTIONS.setTime: {
        const atMs = numeric(args.atMs, "UTC milliseconds"); const rate = numeric(args.rate ?? clock.scale, "Time rate");
        clock = anchoredSimulationClock(atMs, rate); break;
      }
      default: throw new RangeError(`Unknown Geant action: ${action}`);
    }
    return commandResult(action, value, source);
  }
  return {
    dispatch, getSnapshot: snapshot,
    get mode() { return mode; }, get focusBody() { return focusBody; },
    get scaleDenominator() { return scaleDenominator; }, get terrainMultiplier() { return terrainMultiplier; },
    get observerJ2000M() { return observer ? { ...observer } : null; }, get revision() { return revision; },
    getClock(): SimulationClockState { return { ...clock }; },
    setClock(value: SimulationClockState, source?: unknown) { assertActive();
      clock = { anchorWallTimeMs: finiteNumber(value.anchorWallTimeMs, "Clock anchor"), offsetMs: finiteNumber(value.offsetMs, "Clock offset"), scale: finiteNumber(value.scale, "Clock rate") };
      commandResult(GEANT_ACTIONS.setTime, value, source);
    },
    updateContact(body: SolarSystemBodyId, frame: ContactFrame) {
      assertActive(); body = selected(body);
      const previous = contacts.get(body)!;
      if (previous.upEcef.equals(frame.upEcef) && previous.eastEcef.equals(frame.eastEcef) && previous.northEcef.equals(frame.northEcef)) return;
      const contact = { upEcef: frame.upEcef.clone(), eastEcef: frame.eastEcef.clone(), northEcef: frame.northEcef.clone() };
      contacts.set(body, contact); locations.set(body, { ...locations.get(body)!, ...coordinatesForFrame(contact) }); publish();
    },
    clearObserver() { assertActive(); if (observer === null) return; observer = null; publish(); },
    adaptAction(action: string, handler: (payload: unknown) => unknown) {
      assertActive(); if (actionAdapters.has(action)) throw new Error(`An adapter already owns ${action}.`);
      actionAdapters.set(action, handler); return () => { actionAdapters.delete(action); };
    },
    getContact(body = focusBody): ContactFrame {
      const frame = contacts.get(selected(body))!;
      return { upEcef: frame.upEcef.clone(), eastEcef: frame.eastEcef.clone(), northEcef: frame.northEcef.clone() };
    },
    subscribe(listener: (snapshot: GeantSnapshot) => void) { assertActive(); listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeCommands(listener: (command: GeantNavigationCommand) => void) { assertActive(); commandListeners.add(listener); return () => { commandListeners.delete(listener); }; },
    register(actions: SkykitActionRegistry) {
      const teardowns = Object.values(GEANT_ACTIONS).map(action => actions.registerAction(action, ({ payload }) => actionAdapters.has(action) ? actionAdapters.get(action)!(payload) : dispatch(action, payload)));
      return () => { for (const teardown of teardowns.reverse()) teardown(); };
    },
    dispose() { disposed = true; listeners.clear(); commandListeners.clear(); actionAdapters.clear(); },
  };
}
export type GeantNavigation = ReturnType<typeof createGeantNavigation>;
