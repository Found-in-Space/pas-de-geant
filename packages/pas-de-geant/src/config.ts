import { DEFAULT_SCALE_DENOMINATOR } from "./navigation/policy.js";
import type { WebGLRenderer } from "three";
import { celestialBody, isSolarSystemBodyId, type SolarSystemBodyId } from "./worlds/solar-system.js";
import type { NavigationMode, SurfaceLocation } from "./worlds/world-navigation.js";
import { validScaleDenominator } from "./worlds/world-scale.js";
import type { WorldSurfaceSource } from "./worlds/world-runtime.js";

export interface SurfaceFactoryContext {
  readonly body: SolarSystemBodyId;
  readonly renderer: WebGLRenderer;
  readonly signal: AbortSignal;
}
/** Factories transfer their providers and explicitly owned base texture to this instance. */
export type GeantSurfaceFactory = (context: SurfaceFactoryContext) => WorldSurfaceSource | Promise<WorldSurfaceSource>;
export interface GeantConfiguration {
  readonly bodies?: readonly SolarSystemBodyId[];
  readonly focusBody?: SolarSystemBodyId;
  readonly mode?: NavigationMode;
  readonly location?: Partial<SurfaceLocation>;
  readonly locations?: Readonly<Partial<Record<SolarSystemBodyId, Partial<SurfaceLocation>>>>;
  readonly scaleDenominator?: number;
  readonly terrainMultiplier?: number;
  readonly time?: "now" | string;
  readonly timeRate?: number;
}
export interface ResolvedGeantConfiguration {
  readonly bodies: readonly SolarSystemBodyId[];
  readonly focusBody: SolarSystemBodyId;
  readonly mode: NavigationMode;
  readonly locations: Readonly<Partial<Record<SolarSystemBodyId, SurfaceLocation>>>;
  readonly scaleDenominator: number;
  readonly terrainMultiplier: number;
  readonly time: "now" | string;
  readonly timeRate: number;
}
export function finiteNumber(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`);
  return value;
}
export function geantLocation(value: Partial<SurfaceLocation> = {}): SurfaceLocation {
  const latitudeDegrees = finiteNumber(value.latitudeDegrees ?? 0, "Latitude");
  const longitudeDegrees = finiteNumber(value.longitudeDegrees ?? 0, "Longitude");
  if (latitudeDegrees < -90 || latitudeDegrees > 90 || longitudeDegrees < -180 || longitudeDegrees > 180) {
    throw new RangeError("Location must use latitude [-90, 90] and longitude [-180, 180] in degrees.");
  }
  return { latitudeDegrees, longitudeDegrees, altitudeM: finiteNumber(value.altitudeM ?? 0, "Altitude"),
    headingDegrees: finiteNumber(value.headingDegrees ?? 0, "Heading") };
}
export function resolveGeantConfiguration(options: GeantConfiguration = {}): ResolvedGeantConfiguration {
  const bodies: SolarSystemBodyId[] = [...new Set<SolarSystemBodyId>(options.bodies ?? ["earth"])];
  if (!bodies.length || bodies.some(body => !isSolarSystemBodyId(body))) throw new RangeError("Select at least one registered body.");
  const focusBody = options.focusBody ?? bodies[0]!;
  if (!bodies.includes(focusBody)) throw new RangeError("The focused body must be selected.");
  const mode = options.mode ?? (celestialBody(focusBody).surface ? "surface" : "orbit");
  if (!["surface", "orbit", "free"].includes(mode)) throw new RangeError("Unknown navigation mode.");
  if (mode === "surface" && !celestialBody(focusBody).surface) throw new RangeError(`${focusBody} has no surface navigation.`);
  const terrainMultiplier = finiteNumber(options.terrainMultiplier ?? 1, "Terrain multiplier");
  if (terrainMultiplier < 0) throw new RangeError("Terrain multiplier must be nonnegative.");
  const time = options.time ?? "now";
  if (time !== "now" && (!time.endsWith("Z") || !Number.isFinite(Date.parse(time)))) throw new RangeError("Time must be now or an ISO UTC timestamp ending in Z.");
  return { bodies, focusBody, mode,
    locations: Object.fromEntries(bodies.map(body => [body, geantLocation({ ...options.locations?.[body], ...(body === focusBody ? options.location : {}) })])),
    scaleDenominator: validScaleDenominator(options.scaleDenominator ?? DEFAULT_SCALE_DENOMINATOR), terrainMultiplier,
    time, timeRate: finiteNumber(options.timeRate ?? 1, "Time rate") };
}

export interface GeantAiOptions {
  readonly sessionEndpoint: string;
  readonly profile?: string;
  readonly button?: boolean;
  readonly greetingInstructions?: string;
}
