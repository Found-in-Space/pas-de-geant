import type { Quaternion, Vector3 } from "three";
import type { GeantNavigation, GeantSnapshot } from "./controller.js";
import type { CelestialBodyDefinition, SolarSystemBodyId, Vector3d } from "../worlds/solar-system.js";
import type { SurfaceModel } from "../worlds/surface-model.js";

/** Geometry adapter. A model does not receive the world renderer or its scene root. */
export interface GeantMovementSurface {
  readonly body: CelestialBodyDefinition;
  readonly geometry: Pick<SurfaceModel, "positionAndNormal" | "referenceRadiusM">;
  sampleElevationMetres(latitudeDegrees: number, longitudeDegrees: number): number;
}
export interface GeantRigPose {
  readonly position: Vector3;
  readonly orientation: Quaternion;
}
/** Physical positions use J2000 metres. Presentation positions use room metres. */
export interface GeantPlacement {
  readonly originJ2000M: Vector3d;
  readonly systemRotation: Quaternion;
  readonly translation: Vector3;
  readonly rig?: GeantRigPose;
  readonly desktopOrientation?: Quaternion;
  readonly desktopPosition?: Vector3;
}
export interface GeantMovementFrame {
  /** Navigation state with time sampled once for this viewer frame, shared with world presentation. */
  readonly state: GeantSnapshot;
  readonly navigation: GeantNavigation;
  readonly deltaSeconds: number;
  readonly xr: boolean;
  /** Unmodified headset pose in the XR reference space, or the desktop camera pose. */
  readonly tracking: GeantRigPose & { readonly tracked: boolean };
  readonly rig: GeantRigPose;
  readonly observerJ2000M: Vector3d | null;
  /** Preceding physical-to-room rotation, for a continuous change of navigation frame. */
  readonly previousSystemRotation: Quaternion;
  readonly reason: "initial" | "selection" | "focus" | "tracking";
  /** Desktop pointer viewport in CSS pixels; independent of framebuffer/XR tile detail. */
  readonly viewportHeight: number;
  /** Desktop pointer projection in CSS pixels, for orbit-drag input. */
  readonly focalLengthPixels: number;
  surface(body: SolarSystemBodyId): GeantMovementSurface;
  invoke(action: string, payload: Record<string, unknown>): Promise<unknown>;
}
/** Models are ordinary objects. Hosts select and compose them without a type registry. */
export interface GeantMovementModel {
  readonly id: string;
  enter?(frame: GeantMovementFrame): void;
  leave?(frame: GeantMovementFrame): void;
  update(frame: GeantMovementFrame): GeantPlacement;
  command?(action: string, payload: Readonly<Record<string, unknown>>, frame: GeantMovementFrame): unknown;
}
export type GeantMovementSelection = GeantMovementModel | ((frame: GeantMovementFrame) => GeantMovementModel);

export function movementNumber(input: Readonly<Record<string, unknown>>, key: string, fallback = 0): number {
  const value = input[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${key} must be finite.`);
  return value;
}
