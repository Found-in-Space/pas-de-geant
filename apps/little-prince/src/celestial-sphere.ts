import {
  MakeTime,
  RotateVector,
  Rotation_EQD_EQJ,
  SiderealTime,
  Vector,
} from "astronomy-engine";
import { loadStarRows } from "@found-in-space/skykit/data";
import {
  createDefaultThreeStarFieldMaterialProfile,
} from "@found-in-space/three-star-field";
import * as THREE from "three";

export const CELESTIAL_SPHERE_RADIUS_M = 520;
export const CELESTIAL_LIMITING_MAGNITUDE = 6.5;
export const CELESTIAL_TIME_STEP_MS = 1_000;

const ORIGIN_EPSILON_PC = 1e-9;
const APP_ECEF_FROM_STANDARD_ECEF = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
  .normalize();

export interface CelestialStarSource {
  positionPc: {
    x: number;
    y: number;
    z: number;
  };
  apparentMagnitude: number | null;
  teffLog8?: number | null;
  temperatureK: number | null;
}

export interface CelestialStarField {
  object3d: THREE.Group;
  count: number;
  dispose(): void;
}

export type CelestialCatalogLoader = () => Promise<
  Iterable<CelestialStarSource>
>;

export type CelestialCatalogLoadResult =
  | { status: "ready"; count: number }
  | { status: "unavailable"; count: 0; error: unknown };

export function createCelestialStarField(
  stars: Iterable<CelestialStarSource>,
): CelestialStarField {
  const positions: number[] = [];
  const teffLog8: number[] = [];
  const fixedRadiusAbsoluteMagnitude: number[] = [];
  const direction = new THREE.Vector3();
  let count = 0;

  for (const star of stars) {
    const magnitude = star.apparentMagnitude;
    if (
      !Number.isFinite(magnitude) ||
      (magnitude as number) > CELESTIAL_LIMITING_MAGNITUDE
    ) {
      continue;
    }
    direction.set(
      star.positionPc.x,
      star.positionPc.y,
      star.positionPc.z,
    );
    const distancePc = direction.length();
    if (!Number.isFinite(distancePc) || distancePc <= ORIGIN_EPSILON_PC) {
      continue;
    }

    direction.multiplyScalar(CELESTIAL_SPHERE_RADIUS_M / distancePc);
    positions.push(direction.x, direction.y, direction.z);
    teffLog8.push(encodedTemperature(star));
    // SkyKit derives apparent magnitude from absolute magnitude and distance.
    // Every celestial-sphere point is one shader parsec away, so mAbs = mApp+5.
    fixedRadiusAbsoluteMagnitude.push((magnitude as number) + 5);
    count += 1;
  }

  const object3d = new THREE.Group();
  object3d.name = "skykit-celestial-sphere";
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute(
    "teff_log8",
    new THREE.BufferAttribute(new Uint8Array(teffLog8), 1, true),
  );
  geometry.setAttribute(
    "magAbs",
    new THREE.Float32BufferAttribute(fixedRadiusAbsoluteMagnitude, 1),
  );
  geometry.computeBoundingSphere();

  const materialProfile = createDefaultThreeStarFieldMaterialProfile({
    observerPosition: { x: 0, y: 0, z: 0 },
    coordinateUnitsPerParsec: CELESTIAL_SPHERE_RADIUS_M,
    limitingMagnitude: CELESTIAL_LIMITING_MAGNITUDE,
    renderScale: 1,
  });
  materialProfile.material.depthTest = true;
  materialProfile.material.depthWrite = false;
  const points = new THREE.Points(geometry, materialProfile.material);
  points.name = "skykit-star-cores";
  points.frustumCulled = false;
  object3d.add(points);

  if (materialProfile.haloMaterial) {
    materialProfile.haloMaterial.depthTest = true;
    materialProfile.haloMaterial.depthWrite = false;
    const halos = new THREE.Points(
      geometry,
      materialProfile.haloMaterial,
    );
    halos.name = "skykit-star-halos";
    halos.frustumCulled = false;
    object3d.add(halos);
  }

  return {
    object3d,
    count,
    dispose() {
      object3d.remove(...object3d.children);
      geometry.dispose();
      materialProfile.dispose?.();
    },
  };
}

export function equatorialJ2000ToAppEcefQuaternion(
  at: Date,
): THREE.Quaternion {
  if (!Number.isFinite(at.getTime())) {
    throw new RangeError(`Invalid celestial-frame time: ${at}`);
  }
  const siderealAngleRad = (SiderealTime(at) * 15 * Math.PI) / 180;
  const standardEcefToJ2000 = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      rotateStandardEcefBasis(at, siderealAngleRad, 1, 0, 0),
      rotateStandardEcefBasis(at, siderealAngleRad, 0, 1, 0),
      rotateStandardEcefBasis(at, siderealAngleRad, 0, 0, 1),
    ),
  );
  return APP_ECEF_FROM_STANDARD_ECEF.clone()
    .multiply(standardEcefToJ2000.invert())
    .normalize();
}

export function celestialToWorldQuaternion(
  earthToWorld: THREE.Quaternion,
  at: Date,
): THREE.Quaternion {
  return earthToWorld
    .clone()
    .multiply(equatorialJ2000ToAppEcefQuaternion(at))
    .normalize();
}

export class CelestialSphere {
  readonly object3d = new THREE.Group();

  private field: CelestialStarField | null = null;
  private readonly loadCatalog: CelestialCatalogLoader;
  private readonly j2000ToAppEcef = new THREE.Quaternion();
  private nextTimeUpdateMs = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(loadCatalog: CelestialCatalogLoader = loadDefaultCatalog) {
    this.loadCatalog = loadCatalog;
    this.object3d.name = "celestial-sphere-root";
  }

  async load(): Promise<CelestialCatalogLoadResult> {
    try {
      const stars = await this.loadCatalog();
      if (this.disposed) {
        return {
          status: "unavailable",
          count: 0,
          error: new Error("Celestial sphere was disposed while loading."),
        };
      }
      const field = createCelestialStarField(stars);
      this.field?.dispose();
      if (this.field) this.object3d.remove(this.field.object3d);
      this.field = field;
      this.object3d.add(field.object3d);
      return { status: "ready", count: field.count };
    } catch (error) {
      return { status: "unavailable", count: 0, error };
    }
  }

  update(
    earthToWorld: THREE.Quaternion,
    cameraWorldPosition: THREE.Vector3,
    utcMilliseconds: number,
  ): void {
    if (utcMilliseconds >= this.nextTimeUpdateMs) {
      this.j2000ToAppEcef.copy(
        equatorialJ2000ToAppEcefQuaternion(new Date(utcMilliseconds)),
      );
      this.nextTimeUpdateMs = utcMilliseconds + CELESTIAL_TIME_STEP_MS;
    }
    this.object3d.position.copy(cameraWorldPosition);
    this.object3d.quaternion
      .copy(earthToWorld)
      .multiply(this.j2000ToAppEcef)
      .normalize();
    this.object3d.scale.set(1, 1, 1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.field?.dispose();
    if (this.field) this.object3d.remove(this.field.object3d);
    this.field = null;
    this.disposed = true;
  }
}

async function loadDefaultCatalog(): Promise<
  Iterable<CelestialStarSource>
> {
  return loadStarRows({
    observerPc: { x: 0, y: 0, z: 0 },
    limitingMagnitude: CELESTIAL_LIMITING_MAGNITUDE,
    filterVisible: true,
    persistentCache: "on",
  });
}

function rotateStandardEcefBasis(
  at: Date,
  siderealAngleRad: number,
  x: number,
  y: number,
  z: number,
): THREE.Vector3 {
  const cosine = Math.cos(siderealAngleRad);
  const sine = Math.sin(siderealAngleRad);
  const time = MakeTime(at);
  const equatorialOfDate = new Vector(
    cosine * x - sine * y,
    sine * x + cosine * y,
    z,
    time,
  );
  const equatorialJ2000 = RotateVector(
    Rotation_EQD_EQJ(time),
    equatorialOfDate,
  );
  return new THREE.Vector3(
    equatorialJ2000.x,
    equatorialJ2000.y,
    equatorialJ2000.z,
  );
}

function encodedTemperature(star: CelestialStarSource): number {
  if (Number.isFinite(star.teffLog8)) {
    return Math.round(
      THREE.MathUtils.clamp(star.teffLog8 as number, 0, 255),
    );
  }
  if (Number.isFinite(star.temperatureK)) {
    const temperatureK = THREE.MathUtils.clamp(
      star.temperatureK as number,
      2_000,
      50_000,
    );
    return Math.round(
      THREE.MathUtils.clamp(
        Math.log(temperatureK / 2_000) / Math.log(25) * 255,
        0,
        254,
      ),
    );
  }
  return 255;
}
