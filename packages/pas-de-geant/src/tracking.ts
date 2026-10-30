import { Vector3 } from "three";
import { evaluateSpatialAim, normalizeSpatialCoordinateSpace, normalizeSpatialVector3,
  type SpatialCoordinateSpace, type SpatialVector3 } from "@found-in-space/spatial";
import type { JourneySequence } from "@found-in-space/guided-journey/sequence";
import { geantBodyFixedSpace, type GeantBodyPoseCamera } from "./journey.js";
import type { GeantSequenceValue } from "./sequence.js";
import type { SolarSystemBodyId } from "./worlds/solar-system.js";

export interface GeantTrackingTarget {
  readonly body: SolarSystemBodyId;
  readonly space: SpatialCoordinateSpace;
  /** Physical body-fixed metres. No terrain correction is applied. */
  readonly position: SpatialVector3;
  /** Physical metres per source second, in the same rotating body frame. */
  readonly velocityMPerSec: SpatialVector3;
}
export interface GeantTrackingShot {
  readonly offset: { readonly rightM: number; readonly upM: number; readonly behindM: number };
  readonly up: "radial" | SpatialVector3;
  readonly heading:
    | { readonly kind: "reference"; readonly forward: SpatialVector3 }
    | { readonly kind: "velocity"; readonly referenceForward: SpatialVector3;
        /** Camera-only smooth blend from the reference tangent to reported velocity below this speed. */
        readonly blendSpeedMPerSec: number };
  readonly lookAheadSecs: number;
  readonly scaleDenominator: number;
}
function vector(value: SpatialVector3) { return new Vector3().copy(normalizeSpatialVector3(value)); }
function direction(value: Vector3, label: string) {
  if (value.lengthSq() === 0) throw new RangeError(`${label} must have a nonzero direction.`);
  return value.normalize();
}

/** Pure camera geometry. It never changes target records or infers spacecraft attitude. */
export function evaluateGeantTrackingShot(target: GeantTrackingTarget, shot: GeantTrackingShot): GeantBodyPoseCamera {
  if (!target.space) throw new TypeError("Declare the target coordinate space.");
  const space = normalizeSpatialCoordinateSpace(target.space, geantBodyFixedSpace(target.body));
  const position = vector(target.position), velocity = vector(target.velocityMPerSec);
  if (![shot.offset.rightM, shot.offset.upM, shot.offset.behindM, shot.lookAheadSecs, shot.scaleDenominator].every(Number.isFinite)
    || shot.lookAheadSecs < 0 || shot.scaleDenominator <= 0) throw new RangeError("Invalid tracking shot quantities.");
  const up = direction(shot.up === "radial" ? position.clone() : vector(shot.up), "Shot up");
  const heading = shot.heading;
  if (heading.kind !== "reference" && heading.kind !== "velocity") throw new TypeError("Declare the shot heading convention.");
  const forward = direction(vector(heading.kind === "reference" ? heading.forward : heading.referenceForward).projectOnPlane(up), "Reference tangent");
  if (heading.kind === "velocity") {
    if (!Number.isFinite(heading.blendSpeedMPerSec) || heading.blendSpeedMPerSec <= 0) throw new RangeError("Declare a positive camera heading blend speed.");
    const tangent = velocity.clone().projectOnPlane(up), speed = tangent.length();
    if (speed > 0) {
      tangent.divideScalar(speed);
      const angle = Math.atan2(up.dot(new Vector3().crossVectors(forward, tangent)), forward.dot(tangent));
      const ratio = Math.min(1, speed / heading.blendSpeedMPerSec), blend = ratio * ratio * (3 - 2 * ratio);
      forward.applyAxisAngle(up, angle * blend);
    }
  }
  const right = new Vector3().crossVectors(forward, up);
  const eye = position.clone().addScaledVector(right, shot.offset.rightM).addScaledVector(up, shot.offset.upM).addScaledVector(forward, -shot.offset.behindM);
  const aim = position.clone().addScaledVector(velocity, shot.lookAheadSecs);
  const look = direction(aim.clone().sub(eye), "Camera aim");
  if (new Vector3().crossVectors(look, up).lengthSq() === 0) throw new RangeError("Shot up must not be parallel to the camera aim.");
  const sample = evaluateSpatialAim({ space, position: eye, aim: { kind: "target", target: aim, up } });
  return { kind: "body-pose", body: target.body, scaleDenominator: shot.scaleDenominator,
    pose: { space, position: { x: eye.x, y: eye.y, z: eye.z }, orientation: sample.orientation } };
}

/** Compose one time-indexed target with an authored shot and an optional explicit world-clock mapping. */
export function createGeantTrackingSequence<Target extends GeantTrackingTarget>(options: {
  sequence: JourneySequence<Target>;
  shot: GeantTrackingShot | ((timeSecs: number, target: Target) => GeantTrackingShot);
  worldTime?: (timeSecs: number, target: Target) => number;
}): JourneySequence<GeantSequenceValue & { readonly target: Target }> {
  return {
    durationSecs: options.sequence.durationSecs,
    evaluate(timeSecs) {
      const target = options.sequence.evaluate(timeSecs);
      const shot = typeof options.shot === "function" ? options.shot(timeSecs, target) : options.shot;
      const camera = evaluateGeantTrackingShot(target, shot);
      const atMs = options.worldTime?.(timeSecs, target);
      if (atMs !== undefined && !Number.isFinite(atMs)) throw new RangeError("World epoch must be finite UTC milliseconds.");
      return { target, camera, ...(atMs === undefined ? {} : { atMs }) };
    },
  };
}
