import * as THREE from "three";
import { celestialBody, type SolarSystemBodyId, type CelestialBodyDefinition } from "./solar-system.js";
import type { TerrainSurface } from "./terrain-surface.js";

/** Inverse observation in body-fixed X/north/-east axes and physical metres. */
export function referenceSurfaceObservation(body: CelestialBodyDefinition, point: THREE.Vector3) {
  const p = Math.hypot(point.x, point.z);
  const longitude = Math.atan2(-point.z, point.x);
  let latitude: number;
  if (body.shape.kind === "sphere") latitude = Math.atan2(point.y, p);
  else {
    const { equatorialRadiusM: a, polarRadiusM: b } = body.shape;
    const e2 = 1 - b * b / (a * a);
    // Fixed-point inversion of the normal-height parameterization. The bodies
    // are oblate, and this converges rapidly at and above their reference surface.
    latitude = Math.atan2(point.y, p * (1 - e2));
    for (let iteration = 0; iteration < 12; iteration++) {
      const sine = Math.sin(latitude), n = a / Math.sqrt(1 - e2 * sine * sine);
      const next = Math.atan2(point.y + e2 * n * sine, p);
      if (Math.abs(next - latitude) < 1e-15) { latitude = next; break; }
      latitude = next;
    }
  }
  const latitudeDegrees = THREE.MathUtils.radToDeg(latitude), longitudeDegrees = THREE.MathUtils.radToDeg(longitude);
  const normal = new THREE.Vector3(Math.cos(latitude) * Math.cos(longitude), Math.sin(latitude), -Math.cos(latitude) * Math.sin(longitude));
  const a = body.shape.kind === "sphere" ? body.shape.radiusM : body.shape.equatorialRadiusM;
  const b = body.shape.kind === "sphere" ? body.shape.radiusM : body.shape.polarRadiusM;
  const e2 = 1 - b * b / (a * a), n = a / Math.sqrt(1 - e2 * normal.y * normal.y);
  const surfacePoint = new THREE.Vector3(n * normal.x, n * (1 - e2) * normal.y, n * normal.z);
  return { latitudeDegrees, longitudeDegrees, heightMetres: point.clone().sub(surfacePoint).dot(normal),
    surfacePoint, surfaceNormal: normal };
}
export interface BodySurfaceView {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly observerHeightWorldM: number;
  readonly referenceSurfaceHeightWorldM: number;
  readonly elevationMetres: number;
  readonly displayRadiusM: number;
}
/** Measures posed terrain independently of application or eclipse policies. */
export function observeBodySurface(options: {
  readonly bodyId: SolarSystemBodyId;
  readonly root: THREE.Object3D;
  readonly camera: THREE.Camera;
  readonly surface: Pick<TerrainSurface, "sampleElevationMetres">;
  readonly terrainMultiplier: number;
}): BodySurfaceView {
  const body = celestialBody(options.bodyId);
  options.camera.updateWorldMatrix(true, false); options.root.updateWorldMatrix(true, false);
  const local = options.root.worldToLocal(options.camera.getWorldPosition(new THREE.Vector3())).multiplyScalar(body.referenceRadiusM);
  const observed = referenceSurfaceObservation(body, local);
  const displayRadiusM = options.root.getWorldScale(new THREE.Vector3()).x;
  const metresPerPhysicalMetre = displayRadiusM / body.referenceRadiusM;
  const elevationMetres = options.surface.sampleElevationMetres(observed.latitudeDegrees, observed.longitudeDegrees);
  return { latitudeDegrees: observed.latitudeDegrees, longitudeDegrees: observed.longitudeDegrees, displayRadiusM, elevationMetres,
    referenceSurfaceHeightWorldM: observed.heightMetres * metresPerPhysicalMetre,
    observerHeightWorldM: Math.max(0.001, (observed.heightMetres - elevationMetres * options.terrainMultiplier) * metresPerPhysicalMetre) };
}
