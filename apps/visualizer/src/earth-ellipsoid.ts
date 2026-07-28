import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
  type CartesianVector,
} from "@found-in-space/shadowline";

export const WGS84_DISPLAY_EQUATORIAL_RADIUS =
  WGS84_A_KM / EARTH_MEAN_RADIUS_KM;
export const WGS84_DISPLAY_POLAR_RADIUS = WGS84_B_KM / EARTH_MEAN_RADIUS_KM;
export const WGS84_DISPLAY_AXES = new THREE.Vector3(
  WGS84_DISPLAY_EQUATORIAL_RADIUS,
  WGS84_DISPLAY_POLAR_RADIUS,
  WGS84_DISPLAY_EQUATORIAL_RADIUS
);

const WGS84_ECCENTRICITY_SQUARED =
  1 - (WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);

/**
 * Maps physical ECEF kilometres into Spacefarer's Three.js axes while applying
 * only the one shared Earth–Moon display scale.
 */
export function ecefKmToDisplay(value: CartesianVector): THREE.Vector3 {
  return new THREE.Vector3(
    value.x / EARTH_MEAN_RADIUS_KM,
    value.z / EARTH_MEAN_RADIUS_KM,
    -value.y / EARTH_MEAN_RADIUS_KM
  );
}

export function displayToEcefKm(value: THREE.Vector3): CartesianVector {
  return {
    x: value.x * EARTH_MEAN_RADIUS_KM,
    y: -value.z * EARTH_MEAN_RADIUS_KM,
    z: value.y * EARTH_MEAN_RADIUS_KM,
  };
}

export function geodeticDisplayPosition(
  latitudeRadians: number,
  longitudeRadians: number,
  altitudeKm = 0
): THREE.Vector3 {
  const sineLatitude = Math.sin(latitudeRadians);
  const cosineLatitude = Math.cos(latitudeRadians);
  const primeVerticalRadius =
    WGS84_A_KM /
    Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sineLatitude * sineLatitude);
  const radialKm = (primeVerticalRadius + altitudeKm) * cosineLatitude;
  return ecefKmToDisplay({
    x: radialKm * Math.cos(longitudeRadians),
    y: radialKm * Math.sin(longitudeRadians),
    z:
      (primeVerticalRadius * (1 - WGS84_ECCENTRICITY_SQUARED) + altitudeKm) *
      sineLatitude,
  });
}

export function wgs84DisplayNormal(position: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    position.x /
      (WGS84_DISPLAY_EQUATORIAL_RADIUS * WGS84_DISPLAY_EQUATORIAL_RADIUS),
    position.y / (WGS84_DISPLAY_POLAR_RADIUS * WGS84_DISPLAY_POLAR_RADIUS),
    position.z /
      (WGS84_DISPLAY_EQUATORIAL_RADIUS * WGS84_DISPLAY_EQUATORIAL_RADIUS)
  ).normalize();
}

/**
 * Intersects an Earth-centred direction with the WGS 84 reference ellipsoid.
 */
export function projectDirectionToWgs84Display(
  direction: THREE.Vector3
): THREE.Vector3 {
  const unit = direction.clone().normalize();
  const inverseRadius = Math.sqrt(
    (unit.x * unit.x + unit.z * unit.z) /
      (WGS84_DISPLAY_EQUATORIAL_RADIUS * WGS84_DISPLAY_EQUATORIAL_RADIUS) +
      (unit.y * unit.y) /
        (WGS84_DISPLAY_POLAR_RADIUS * WGS84_DISPLAY_POLAR_RADIUS)
  );
  return unit.multiplyScalar(1 / inverseRadius);
}

export function wgs84DisplayEquation(position: THREE.Vector3): number {
  return (
    (position.x * position.x + position.z * position.z) /
      (WGS84_DISPLAY_EQUATORIAL_RADIUS * WGS84_DISPLAY_EQUATORIAL_RADIUS) +
    (position.y * position.y) /
      (WGS84_DISPLAY_POLAR_RADIUS * WGS84_DISPLAY_POLAR_RADIUS)
  );
}

export function createGeodeticEllipsoidGeometry(
  longitudeSegments: number,
  latitudeSegments: number,
  altitudeKm = 0
): THREE.BufferGeometry {
  if (
    !Number.isInteger(longitudeSegments) ||
    longitudeSegments < 3 ||
    !Number.isInteger(latitudeSegments) ||
    latitudeSegments < 2
  ) {
    throw new RangeError(
      "Ellipsoid geometry needs at least 3 longitude and 2 latitude segments."
    );
  }
  if (!Number.isFinite(altitudeKm) || altitudeKm < 0) {
    throw new RangeError("Ellipsoid altitude must be non-negative.");
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const rowLength = longitudeSegments + 1;

  for (
    let latitudeIndex = 0;
    latitudeIndex <= latitudeSegments;
    latitudeIndex += 1
  ) {
    const latitude = Math.PI / 2 - (latitudeIndex / latitudeSegments) * Math.PI;
    const sineLatitude = Math.sin(latitude);
    const cosineLatitude = Math.cos(latitude);
    for (
      let longitudeIndex = 0;
      longitudeIndex <= longitudeSegments;
      longitudeIndex += 1
    ) {
      const longitude =
        -Math.PI + (longitudeIndex / longitudeSegments) * Math.PI * 2;
      const position = geodeticDisplayPosition(latitude, longitude, altitudeKm);
      const normal = new THREE.Vector3(
        cosineLatitude * Math.cos(longitude),
        sineLatitude,
        -cosineLatitude * Math.sin(longitude)
      ).normalize();
      positions.push(position.x, position.y, position.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(
        longitudeIndex / longitudeSegments,
        1 - latitudeIndex / latitudeSegments
      );
    }
  }

  for (
    let latitudeIndex = 0;
    latitudeIndex < latitudeSegments;
    latitudeIndex += 1
  ) {
    for (
      let longitudeIndex = 0;
      longitudeIndex < longitudeSegments;
      longitudeIndex += 1
    ) {
      const northWest = latitudeIndex * rowLength + longitudeIndex;
      const southWest = northWest + rowLength;
      const southEast = southWest + 1;
      const northEast = northWest + 1;
      if (latitudeIndex !== 0) {
        indices.push(northWest, southWest, northEast);
      }
      if (latitudeIndex !== latitudeSegments - 1) {
        indices.push(southWest, southEast, northEast);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
