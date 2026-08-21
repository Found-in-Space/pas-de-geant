import {
  MakeTime,
  RotateVector,
  Rotation_EQD_EQJ,
  SiderealTime,
  Vector,
} from "astronomy-engine";
import type { CartesianVector } from "@found-in-space/shadowline";
import type { CartesianBasis } from "./eclipse-types.js";

function rotatedBasisVector(
  at: Date,
  siderealAngleRad: number,
  ecef: CartesianVector,
): CartesianVector {
  const cosine = Math.cos(siderealAngleRad);
  const sine = Math.sin(siderealAngleRad);
  const time = MakeTime(at);
  const equatorialOfDate = new Vector(
    cosine * ecef.x - sine * ecef.y,
    sine * ecef.x + cosine * ecef.y,
    ecef.z,
    time,
  );
  const equatorialJ2000 = RotateVector(
    Rotation_EQD_EQJ(time),
    equatorialOfDate,
  );
  return {
    x: equatorialJ2000.x,
    y: equatorialJ2000.y,
    z: equatorialJ2000.z,
  };
}

export function earthFixedToEquatorialJ2000Basis(
  atUtc: string,
): CartesianBasis {
  const at = new Date(atUtc);
  if (!Number.isFinite(at.getTime())) {
    throw new RangeError(`Invalid celestial-frame time: ${atUtc}`);
  }
  const siderealAngleRad = SiderealTime(at) * 15 * Math.PI / 180;
  return {
    x: rotatedBasisVector(at, siderealAngleRad, { x: 1, y: 0, z: 0 }),
    y: rotatedBasisVector(at, siderealAngleRad, { x: 0, y: 1, z: 0 }),
    z: rotatedBasisVector(at, siderealAngleRad, { x: 0, y: 0, z: 1 }),
  };
}
