import * as THREE from "three";
import {
  extrapolateAircraft,
  type TrackedAircraft,
} from "./aircraft-feed.js";
import {
  EARTH_MEAN_RADIUS_KM,
  geodeticSurfaceEcefKm,
  normalizedRadialOffsetForKilometres,
} from "./planet-state.js";

const MAX_AIRCRAFT = 800;
const AIRCRAFT_SYMBOL_SIZE_M = 0.11;
const FEET_TO_KM = 0.0003048;

const position = new THREE.Vector3();
const normal = new THREE.Vector3();
const east = new THREE.Vector3();
const north = new THREE.Vector3();
const forward = new THREE.Vector3();
const side = new THREE.Vector3();
const scale = new THREE.Vector3();
const rotationMatrix = new THREE.Matrix4();
const quaternion = new THREE.Quaternion();
const instanceMatrix = new THREE.Matrix4();

function aircraftGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        0, 0.72, 0,
        -0.16, 0.12, 0,
        -0.64, -0.08, 0,
        -0.62, -0.27, 0,
        -0.12, -0.16, 0,
        -0.17, -0.61, 0,
        0, -0.72, 0,
        0.17, -0.61, 0,
        0.12, -0.16, 0,
        0.62, -0.27, 0,
        0.64, -0.08, 0,
        0.16, 0.12, 0,
      ],
      3,
    ),
  );
  geometry.setIndex([
    0, 1, 11,
    1, 2, 4,
    2, 3, 4,
    1, 4, 11,
    4, 8, 11,
    8, 10, 11,
    8, 9, 10,
    4, 5, 8,
    5, 6, 7,
    5, 7, 8,
  ]);
  geometry.computeVertexNormals();
  return geometry;
}

export function aircraftNormalizedAltitude(
  altitudeFt: number,
  radialMultiplier: number,
): number {
  return normalizedRadialOffsetForKilometres(
    Math.max(0, altitudeFt) * FEET_TO_KM,
    radialMultiplier,
  );
}

export class AircraftLayer {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private aircraft: TrackedAircraft[] = [];

  constructor() {
    this.mesh = new THREE.InstancedMesh(
      aircraftGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x7cecff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
      MAX_AIRCRAFT,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.count = 0;
    this.group.add(this.mesh);
  }

  setAircraft(aircraft: TrackedAircraft[]): void {
    this.aircraft = aircraft.slice(0, MAX_AIRCRAFT);
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }

  update(
    atMs: number,
    displayRadiusM: number,
    radialMultiplier: number,
  ): void {
    if (!this.group.visible) return;
    const symbolScale = AIRCRAFT_SYMBOL_SIZE_M / displayRadiusM;
    let count = 0;
    for (const report of this.aircraft) {
      const aircraft = extrapolateAircraft(report, atMs);
      const latitude = THREE.MathUtils.degToRad(aircraft.latitudeDegrees);
      const longitude = THREE.MathUtils.degToRad(aircraft.longitudeDegrees);

      position.copy(
        geodeticSurfaceEcefKm(
          aircraft.latitudeDegrees,
          aircraft.longitudeDegrees,
        ),
      ).multiplyScalar(1 / EARTH_MEAN_RADIUS_KM);
      normal.set(
        Math.cos(latitude) * Math.cos(longitude),
        Math.sin(latitude),
        -Math.cos(latitude) * Math.sin(longitude),
      );
      position
        .addScaledVector(
          normal,
          aircraftNormalizedAltitude(
            aircraft.altitudeFt,
            radialMultiplier,
          ),
        );

      east.set(-Math.sin(longitude), 0, -Math.cos(longitude)).normalize();
      north
        .set(
          -Math.sin(latitude) * Math.cos(longitude),
          Math.cos(latitude),
          Math.sin(latitude) * Math.sin(longitude),
        )
        .normalize();
      const track = THREE.MathUtils.degToRad(aircraft.trackDegrees);
      forward
        .copy(north)
        .multiplyScalar(Math.cos(track))
        .addScaledVector(east, Math.sin(track))
        .normalize();
      side.crossVectors(forward, normal).normalize();
      rotationMatrix.makeBasis(side, forward, normal);
      quaternion.setFromRotationMatrix(rotationMatrix);
      scale.setScalar(symbolScale);
      instanceMatrix.compose(position, quaternion, scale);
      this.mesh.setMatrixAt(count, instanceMatrix);

      count += 1;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
