import { SPATIAL_Z_UP_TO_Y_UP } from "@found-in-space/spatial";
import * as THREE from "three";
import type { BodyRotation } from "./solar-system.js";

const J2000_TO_RENDER = new THREE.Quaternion(
  SPATIAL_Z_UP_TO_Y_UP.x, SPATIAL_Z_UP_TO_Y_UP.y, SPATIAL_Z_UP_TO_Y_UP.z, SPATIAL_Z_UP_TO_Y_UP.w,
);
const BODY_BASIS = new THREE.Matrix4();
const RENDER_TO_J2000 = J2000_TO_RENDER.clone().invert();

/** Body-fixed coordinates to raw equatorial J2000 axes used by Skykit. */
export function bodyFixedToJ2000Quaternion(
  rotation: BodyRotation,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  return bodyFixedToRenderQuaternion(rotation, target).premultiply(RENDER_TO_J2000);
}

/** Maps the app's body-fixed x/up/-east axes into the rendered J2000 frame. */
export function bodyFixedToRenderQuaternion(
  rotation: BodyRotation,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  const alpha = THREE.MathUtils.degToRad(rotation.poleRightAscensionDegrees);
  const delta = THREE.MathUtils.degToRad(rotation.poleDeclinationDegrees);
  const spin = THREE.MathUtils.degToRad(rotation.primeMeridianDegrees);
  const sinAlpha = Math.sin(alpha);
  const cosAlpha = Math.cos(alpha);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);
  const sinSpin = Math.sin(spin);
  const cosSpin = Math.cos(spin);

  const primeX = -sinAlpha * cosSpin - cosAlpha * sinDelta * sinSpin;
  const primeY = cosAlpha * cosSpin - sinAlpha * sinDelta * sinSpin;
  const primeZ = cosDelta * sinSpin;
  const eastX = sinAlpha * sinSpin - cosAlpha * sinDelta * cosSpin;
  const eastY = -cosAlpha * sinSpin - sinAlpha * sinDelta * cosSpin;
  const eastZ = cosDelta * cosSpin;
  const northX = cosAlpha * cosDelta;
  const northY = sinAlpha * cosDelta;
  const northZ = sinDelta;
  BODY_BASIS.set(
    primeX, northX, -eastX, 0,
    primeY, northY, -eastY, 0,
    primeZ, northZ, -eastZ, 0,
    0, 0, 0, 1,
  );
  return target.setFromRotationMatrix(BODY_BASIS)
    .premultiply(J2000_TO_RENDER)
    .normalize();
}
