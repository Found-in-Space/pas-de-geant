import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
} from "./planet-state.js";

const ELLIPSOID_XZ_SCALE = EARTH_MEAN_RADIUS_KM / WGS84_A_KM;
const ELLIPSOID_Y_SCALE = EARTH_MEAN_RADIUS_KM / WGS84_B_KM;
const MAXIMUM_ELLIPSOID_SCALE = Math.max(
  ELLIPSOID_XZ_SCALE,
  ELLIPSOID_Y_SCALE,
);
const TIMING_SAMPLE_CAPACITY = 900;
const PACKED_ENTRY_STRIDE = 9;
const PACKED_CENTER_X = 0;
const PACKED_CENTER_Y = 1;
const PACKED_CENTER_Z = 2;
const PACKED_RADIUS = 3;
const PACKED_CONE_AXIS_X = 4;
const PACKED_CONE_AXIS_Y = 5;
const PACKED_CONE_AXIS_Z = 6;
const PACKED_CONE_COSINE = 7;
const PACKED_CONE_SINE = 8;

export interface ElevationBoundsMetres {
  readonly minimum: number;
  readonly maximum: number;
}

export interface TerrainRenderVisibilityEntry {
  readonly mesh: THREE.Mesh;
  readonly baseSphere: THREE.Sphere;
  readonly ellipsoidConeAxis: THREE.Vector3;
  readonly ellipsoidConeCosine: number;
  readonly ellipsoidConeSine: number;
  readonly usesElevationBounds: boolean;
}

export interface TerrainRenderVisibilityMetrics {
  readonly enabled: boolean;
  readonly candidateMeshCount: number;
  readonly leftEyeVisibleCount: number;
  readonly rightEyeVisibleCount: number;
  readonly stereoUnionVisibleCount: number;
  readonly horizonCulledCount: number;
  readonly frustumCulledCount: number;
  readonly conservativeRetainCount: number;
  readonly estimatedTerrainDrawCalls: number;
  readonly classificationTotal: number;
  readonly classificationTimeMs: {
    readonly sampleCount: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
  };
}

interface EyeVisibilityState {
  readonly frustum: THREE.Frustum;
  readonly localPosition: THREE.Vector3;
  readonly ellipsoidDirection: THREE.Vector3;
  readonly viewFromTerrain: THREE.Matrix4;
  readonly clipFromTerrain: THREE.Matrix4;
  horizonCertain: boolean;
  flatHorizonCosine: number;
  flatHorizonSine: number;
  elevatedHorizonCosine: number;
  elevatedHorizonSine: number;
}

function finiteElevationBounds(
  bounds: ElevationBoundsMetres | undefined,
): ElevationBoundsMetres | undefined {
  if (
    !bounds ||
    !Number.isFinite(bounds.minimum) ||
    !Number.isFinite(bounds.maximum) ||
    bounds.minimum > bounds.maximum
  ) return undefined;
  return bounds;
}

function percentile(sorted: readonly number[], amount: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * amount) - 1),
  );
  return sorted[index]!;
}

function eyeVisibilityState(): EyeVisibilityState {
  return {
    frustum: new THREE.Frustum(),
    localPosition: new THREE.Vector3(),
    ellipsoidDirection: new THREE.Vector3(),
    viewFromTerrain: new THREE.Matrix4(),
    clipFromTerrain: new THREE.Matrix4(),
    horizonCertain: false,
    flatHorizonCosine: 1,
    flatHorizonSine: 0,
    elevatedHorizonCosine: 1,
    elevatedHorizonSine: 0,
  };
}

/**
 * Builds immutable render-only bounds from the geometry's undisplaced vertices.
 * This runs only when a committed mesh is created.
 */
export function createTerrainRenderVisibilityEntry(
  mesh: THREE.Mesh<THREE.BufferGeometry>,
  usesElevationBounds: boolean,
): TerrainRenderVisibilityEntry {
  const geometry = mesh.geometry;
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  const boundingSphere = geometry.boundingSphere;
  if (!boundingSphere) {
    throw new Error("Terrain geometry must have a finite bounding sphere.");
  }

  const coneAxis = boundingSphere.center.clone().set(
    boundingSphere.center.x * ELLIPSOID_XZ_SCALE,
    boundingSphere.center.y * ELLIPSOID_Y_SCALE,
    boundingSphere.center.z * ELLIPSOID_XZ_SCALE,
  );
  const coneCentreDistance = coneAxis.length();
  const coneRadius = boundingSphere.radius * MAXIMUM_ELLIPSOID_SCALE;
  if (
    !Number.isFinite(coneCentreDistance) ||
    !Number.isFinite(coneRadius) ||
    coneCentreDistance <= coneRadius
  ) {
    coneAxis.set(1, 0, 0);
    return Object.freeze({
      mesh,
      baseSphere: boundingSphere.clone(),
      ellipsoidConeAxis: coneAxis,
      ellipsoidConeCosine: -1,
      ellipsoidConeSine: 0,
      usesElevationBounds,
    });
  }

  coneAxis.multiplyScalar(1 / coneCentreDistance);
  const sine = Math.max(0, Math.min(1, coneRadius / coneCentreDistance));
  const cosine = Math.sqrt(Math.max(0, 1 - sine * sine));
  return Object.freeze({
    mesh,
    baseSphere: boundingSphere.clone(),
    ellipsoidConeAxis: coneAxis,
    ellipsoidConeCosine: cosine,
    ellipsoidConeSine: sine,
    usesElevationBounds,
  });
}

/**
 * Allocation-free render visibility for the current camera pose. It has no
 * access to terrain scheduling, source providers, residency, or uploads.
 */
export class TerrainRenderVisibility {
  private readonly entries: TerrainRenderVisibilityEntry[] = [];
  private packedEntries = new Float64Array(0);
  private elevationBoundFlags = new Uint8Array(0);
  private readonly eyeStates = [eyeVisibilityState(), eyeVisibilityState()];
  private readonly unionState = eyeVisibilityState();
  private readonly cachedTerrainWorld = new THREE.Matrix4();
  private readonly terrainWorldInverse = new THREE.Matrix4();
  private readonly expandedSphere = new THREE.Sphere();
  private readonly timingSamples = new Float64Array(TIMING_SAMPLE_CAPACITY);
  private readonly elevationBounds: ElevationBoundsMetres | undefined;
  private enabledValue = true;
  private radialMultiplier = Number.NaN;
  private displayRadiusM = Number.NaN;
  private sphereExpansion = Number.POSITIVE_INFINITY;
  private elevationHorizonCertain = false;
  private displacementHorizonCosine = 1;
  private displacementHorizonSine = 0;
  private timingSampleCount = 0;
  private timingSampleIndex = 0;
  private classificationTotal = 0;
  private eyeCount = 1;
  private leftEyeVisibleCount = 0;
  private rightEyeVisibleCount = 0;
  private stereoUnionVisibleCount = 0;
  private horizonCulledCount = 0;
  private frustumCulledCount = 0;
  private conservativeRetainCount = 0;
  private lastCamera: THREE.Camera | undefined;
  private terrainWorldCacheValid = false;

  constructor(
    private readonly terrainGroup: THREE.Object3D,
    elevationBounds: ElevationBoundsMetres | undefined,
  ) {
    this.elevationBounds = finiteElevationBounds(elevationBounds);
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get metrics(): TerrainRenderVisibilityMetrics {
    this.refreshEyeVisibleCounts();
    const sampleCount = Math.min(
      this.timingSampleCount,
      TIMING_SAMPLE_CAPACITY,
    );
    const samples = Array.from(this.timingSamples.subarray(0, sampleCount));
    samples.sort((first, second) => first - second);
    return {
      enabled: this.enabledValue,
      candidateMeshCount: this.entries.length,
      leftEyeVisibleCount: this.leftEyeVisibleCount,
      rightEyeVisibleCount: this.rightEyeVisibleCount,
      stereoUnionVisibleCount: this.stereoUnionVisibleCount,
      horizonCulledCount: this.horizonCulledCount,
      frustumCulledCount: this.frustumCulledCount,
      conservativeRetainCount: this.conservativeRetainCount,
      estimatedTerrainDrawCalls: this.stereoUnionVisibleCount * this.eyeCount,
      classificationTotal: this.classificationTotal,
      classificationTimeMs: {
        sampleCount,
        p50: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        p99: percentile(samples, 0.99),
      },
    };
  }

  setEntries(entries: readonly TerrainRenderVisibilityEntry[]): void {
    this.entries.length = 0;
    if (this.packedEntries.length !== entries.length * PACKED_ENTRY_STRIDE) {
      this.packedEntries = new Float64Array(
        entries.length * PACKED_ENTRY_STRIDE,
      );
      this.elevationBoundFlags = new Uint8Array(entries.length);
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      this.entries.push(entry);
      const packedIndex = index * PACKED_ENTRY_STRIDE;
      this.packedEntries[packedIndex + PACKED_CENTER_X] =
        entry.baseSphere.center.x;
      this.packedEntries[packedIndex + PACKED_CENTER_Y] =
        entry.baseSphere.center.y;
      this.packedEntries[packedIndex + PACKED_CENTER_Z] =
        entry.baseSphere.center.z;
      this.packedEntries[packedIndex + PACKED_RADIUS] = entry.baseSphere.radius;
      this.packedEntries[packedIndex + PACKED_CONE_AXIS_X] =
        entry.ellipsoidConeAxis.x;
      this.packedEntries[packedIndex + PACKED_CONE_AXIS_Y] =
        entry.ellipsoidConeAxis.y;
      this.packedEntries[packedIndex + PACKED_CONE_AXIS_Z] =
        entry.ellipsoidConeAxis.z;
      this.packedEntries[packedIndex + PACKED_CONE_COSINE] =
        entry.ellipsoidConeCosine;
      this.packedEntries[packedIndex + PACKED_CONE_SINE] =
        entry.ellipsoidConeSine;
      this.elevationBoundFlags[index] = entry.usesElevationBounds ? 1 : 0;
    }
    if (!this.enabledValue) this.showAll();
  }

  updateDisplacement(radialMultiplier: number, displayRadiusM: number): void {
    if (
      this.radialMultiplier === radialMultiplier &&
      this.displayRadiusM === displayRadiusM
    ) return;
    this.radialMultiplier = radialMultiplier;
    this.displayRadiusM = displayRadiusM;
    const bounds = this.elevationBounds;
    const displacementIsFinite =
      Boolean(bounds) &&
      Number.isFinite(radialMultiplier) &&
      radialMultiplier >= 0 &&
      Number.isFinite(displayRadiusM) &&
      displayRadiusM > 0;
    if (!bounds || !displacementIsFinite) {
      this.sphereExpansion = Number.POSITIVE_INFINITY;
      this.elevationHorizonCertain = false;
      return;
    }

    const normalizedRadialMetres =
      radialMultiplier / (EARTH_MEAN_RADIUS_KM * 1_000);
    const normalizedSkirtDepth = 0.02 / displayRadiusM;
    this.sphereExpansion =
      Math.max(Math.abs(bounds.minimum), Math.abs(bounds.maximum)) *
        normalizedRadialMetres +
      normalizedSkirtDepth;
    const ellipsoidPerturbation =
      this.sphereExpansion * MAXIMUM_ELLIPSOID_SCALE;
    const maximumOutwardRadius =
      1 + Math.max(0, bounds.maximum) * normalizedRadialMetres *
        MAXIMUM_ELLIPSOID_SCALE;
    if (
      !Number.isFinite(this.sphereExpansion) ||
      !Number.isFinite(maximumOutwardRadius) ||
      ellipsoidPerturbation >= 1 ||
      maximumOutwardRadius < 1
    ) {
      this.elevationHorizonCertain = false;
      return;
    }

    const displacementHorizon =
      Math.acos(1 / maximumOutwardRadius) +
      Math.asin(ellipsoidPerturbation);
    this.elevationHorizonCertain = displacementHorizon < Math.PI / 2;
    if (!this.elevationHorizonCertain) return;
    this.displacementHorizonCosine = Math.cos(displacementHorizon);
    this.displacementHorizonSine = Math.sin(displacementHorizon);
  }

  setEnabled(enabled: boolean): void {
    if (this.enabledValue === enabled) return;
    this.enabledValue = enabled;
    this.clearMetrics();
    this.showAll();
  }

  clearMetrics(): void {
    this.timingSampleCount = 0;
    this.timingSampleIndex = 0;
    this.classificationTotal = 0;
    this.timingSamples.fill(0);
  }

  update(camera: THREE.Camera): void {
    const cameras = camera instanceof THREE.ArrayCamera
      ? camera.cameras
      : undefined;
    this.eyeCount = cameras && cameras.length > 1 ? 2 : 1;
    this.lastCamera = camera;
    if (!this.enabledValue) {
      const count = this.entries.length;
      this.leftEyeVisibleCount = count;
      this.rightEyeVisibleCount = this.eyeCount === 2 ? count : 0;
      this.stereoUnionVisibleCount = count;
      this.horizonCulledCount = 0;
      this.frustumCulledCount = 0;
      this.conservativeRetainCount = 0;
      return;
    }

    const startedAt = performance.now();
    const terrainWorld = this.terrainGroup.matrixWorld;
    if (
      !this.terrainWorldCacheValid ||
      !this.cachedTerrainWorld.equals(terrainWorld)
    ) {
      this.cachedTerrainWorld.copy(terrainWorld);
      this.terrainWorldInverse.copy(terrainWorld).invert();
      this.terrainWorldCacheValid = true;
    }
    this.prepareEyePosition(this.eyeStates[0]!, cameras?.[0] ?? camera);
    if (this.eyeCount === 2) {
      this.prepareEyePosition(this.eyeStates[1]!, cameras?.[1] ?? camera);
    }
    this.prepareUnionHorizon();
    if (!this.unionState.horizonCertain) {
      const count = this.entries.length;
      for (let index = 0; index < count; index += 1) {
        this.entries[index]!.mesh.visible = true;
      }
      this.leftEyeVisibleCount = count;
      this.rightEyeVisibleCount = this.eyeCount === 2 ? count : 0;
      this.stereoUnionVisibleCount = count;
      this.horizonCulledCount = 0;
      this.frustumCulledCount = 0;
      this.conservativeRetainCount = count;
      this.classificationTotal += 1;
      this.recordTiming(performance.now() - startedAt);
      return;
    }
    this.prepareFrustum(this.unionState, camera);

    let unionVisible = 0;
    let horizonCulled = 0;
    let frustumCulled = 0;
    let conservativeRetain = 0;
    const entries = this.entries;
    const packedEntries = this.packedEntries;
    const elevationBoundFlags = this.elevationBoundFlags;
    const union = this.unionState;
    const unionPlanes = union.frustum.planes;
    const plane0 = unionPlanes[0]!;
    const plane1 = unionPlanes[1]!;
    const plane2 = unionPlanes[2]!;
    const plane3 = unionPlanes[3]!;
    const plane4 = unionPlanes[4]!;
    const plane5 = unionPlanes[5]!;
    const plane0X = plane0.normal.x;
    const plane0Y = plane0.normal.y;
    const plane0Z = plane0.normal.z;
    const plane0Constant = plane0.constant;
    const plane1X = plane1.normal.x;
    const plane1Y = plane1.normal.y;
    const plane1Z = plane1.normal.z;
    const plane1Constant = plane1.constant;
    const plane2X = plane2.normal.x;
    const plane2Y = plane2.normal.y;
    const plane2Z = plane2.normal.z;
    const plane2Constant = plane2.constant;
    const plane3X = plane3.normal.x;
    const plane3Y = plane3.normal.y;
    const plane3Z = plane3.normal.z;
    const plane3Constant = plane3.constant;
    const plane4X = plane4.normal.x;
    const plane4Y = plane4.normal.y;
    const plane4Z = plane4.normal.z;
    const plane4Constant = plane4.constant;
    const plane5X = plane5.normal.x;
    const plane5Y = plane5.normal.y;
    const plane5Z = plane5.normal.z;
    const plane5Constant = plane5.constant;
    const unionDirection = union.ellipsoidDirection;
    const elevationHorizonCertain = this.elevationHorizonCertain;
    const flatHorizonCosine = union.flatHorizonCosine;
    const flatHorizonSine = union.flatHorizonSine;
    const elevatedHorizonCosine = union.elevatedHorizonCosine;
    const elevatedHorizonSine = union.elevatedHorizonSine;
    const sphereExpansion = this.sphereExpansion;
    const sphereExpansionFinite = Number.isFinite(sphereExpansion);
    for (
      let index = 0, packedIndex = 0;
      index < entries.length;
      index += 1, packedIndex += PACKED_ENTRY_STRIDE
    ) {
      const entry = entries[index]!;
      const needsBounds = elevationBoundFlags[index] !== 0;
      if (
        needsBounds &&
        (!sphereExpansionFinite || !elevationHorizonCertain)
      ) {
        entry.mesh.visible = true;
        unionVisible += 1;
        conservativeRetain += 1;
        continue;
      }

      const horizonCosine = needsBounds
        ? elevatedHorizonCosine
        : flatHorizonCosine;
      const coneCosine = packedEntries[
        packedIndex + PACKED_CONE_COSINE
      ]!;
      let withinHorizon = true;
      if (coneCosine > -horizonCosine) {
        const horizonSine = needsBounds
          ? elevatedHorizonSine
          : flatHorizonSine;
        const threshold =
          horizonCosine * coneCosine -
          horizonSine * packedEntries[packedIndex + PACKED_CONE_SINE]!;
        withinHorizon =
          unionDirection.x *
              packedEntries[packedIndex + PACKED_CONE_AXIS_X]! +
            unionDirection.y *
              packedEntries[packedIndex + PACKED_CONE_AXIS_Y]! +
            unionDirection.z *
              packedEntries[packedIndex + PACKED_CONE_AXIS_Z]! >= threshold;
      }
      let visible = withinHorizon;
      if (visible) {
        const negativeRadius = -(
          packedEntries[packedIndex + PACKED_RADIUS]! +
          (needsBounds ? sphereExpansion : 0)
        );
        const centerX = packedEntries[packedIndex + PACKED_CENTER_X]!;
        const centerY = packedEntries[packedIndex + PACKED_CENTER_Y]!;
        const centerZ = packedEntries[packedIndex + PACKED_CENTER_Z]!;
        visible = !(
          plane0X * centerX + plane0Y * centerY + plane0Z * centerZ +
              plane0Constant < negativeRadius ||
          plane1X * centerX + plane1Y * centerY + plane1Z * centerZ +
              plane1Constant < negativeRadius ||
          plane2X * centerX + plane2Y * centerY + plane2Z * centerZ +
              plane2Constant < negativeRadius ||
          plane3X * centerX + plane3Y * centerY + plane3Z * centerZ +
              plane3Constant < negativeRadius ||
          plane4X * centerX + plane4Y * centerY + plane4Z * centerZ +
              plane4Constant < negativeRadius ||
          plane5X * centerX + plane5Y * centerY + plane5Z * centerZ +
              plane5Constant < negativeRadius
        );
      }
      entry.mesh.visible = visible;
      if (visible) unionVisible += 1;
      if (!withinHorizon) {
        horizonCulled += 1;
      } else if (!visible) {
        frustumCulled += 1;
      }
    }

    this.stereoUnionVisibleCount = unionVisible;
    this.horizonCulledCount = horizonCulled;
    this.frustumCulledCount = frustumCulled;
    this.conservativeRetainCount = conservativeRetain;
    this.classificationTotal += 1;
    this.recordTiming(performance.now() - startedAt);
  }

  private prepareFrustum(state: EyeVisibilityState, camera: THREE.Camera): void {
    state.viewFromTerrain.multiplyMatrices(
      camera.matrixWorldInverse,
      this.terrainGroup.matrixWorld,
    );
    state.clipFromTerrain.multiplyMatrices(
      camera.projectionMatrix,
      state.viewFromTerrain,
    );
    state.frustum.setFromProjectionMatrix(state.clipFromTerrain);
  }

  private prepareEyePosition(
    eye: EyeVisibilityState,
    camera: THREE.Camera,
  ): void {
    eye.localPosition
      .setFromMatrixPosition(camera.matrixWorld)
      .applyMatrix4(this.terrainWorldInverse);
    eye.ellipsoidDirection.set(
      eye.localPosition.x * ELLIPSOID_XZ_SCALE,
      eye.localPosition.y * ELLIPSOID_Y_SCALE,
      eye.localPosition.z * ELLIPSOID_XZ_SCALE,
    );
    const radius = eye.ellipsoidDirection.length();
    eye.horizonCertain = Number.isFinite(radius) && radius > 1;
    if (!eye.horizonCertain) {
      eye.ellipsoidDirection.set(0, 1, 0);
      eye.flatHorizonCosine = 1;
      eye.flatHorizonSine = 0;
      eye.elevatedHorizonCosine = 1;
      eye.elevatedHorizonSine = 0;
      return;
    }
    eye.ellipsoidDirection.multiplyScalar(1 / radius);
    eye.flatHorizonCosine = 1 / radius;
    eye.flatHorizonSine = Math.sqrt(
      Math.max(0, 1 - eye.flatHorizonCosine * eye.flatHorizonCosine),
    );
    eye.elevatedHorizonCosine = eye.flatHorizonCosine;
    eye.elevatedHorizonSine = eye.flatHorizonSine;
  }

  private prepareUnionHorizon(): void {
    const union = this.unionState;
    const left = this.eyeStates[0]!;
    if (this.eyeCount === 1) {
      union.horizonCertain = left.horizonCertain;
      union.ellipsoidDirection.copy(left.ellipsoidDirection);
      union.flatHorizonCosine = left.flatHorizonCosine;
      union.flatHorizonSine = left.flatHorizonSine;
    } else {
      const right = this.eyeStates[1]!;
      union.horizonCertain = left.horizonCertain && right.horizonCertain;
      union.ellipsoidDirection
        .copy(left.ellipsoidDirection)
        .add(right.ellipsoidDirection);
      const directionLength = union.ellipsoidDirection.length();
      if (!Number.isFinite(directionLength) || directionLength <= 0) {
        union.horizonCertain = false;
        union.ellipsoidDirection.set(0, 1, 0);
      } else {
        union.ellipsoidDirection.multiplyScalar(1 / directionLength);
      }
      if (union.horizonCertain) {
        const directionMarginCosine = Math.min(
          union.ellipsoidDirection.dot(left.ellipsoidDirection),
          union.ellipsoidDirection.dot(right.ellipsoidDirection),
        );
        const marginCosine = Math.max(-1, Math.min(1, directionMarginCosine));
        const marginSine = Math.sqrt(
          Math.max(0, 1 - marginCosine * marginCosine),
        );
        const base = left.flatHorizonCosine <= right.flatHorizonCosine
          ? left
          : right;
        union.flatHorizonCosine =
          base.flatHorizonCosine * marginCosine -
          base.flatHorizonSine * marginSine;
        union.flatHorizonSine =
          base.flatHorizonSine * marginCosine +
          base.flatHorizonCosine * marginSine;
      }
    }
    if (!union.horizonCertain) {
      union.flatHorizonCosine = 1;
      union.flatHorizonSine = 0;
    }
    union.elevatedHorizonCosine = union.flatHorizonCosine;
    union.elevatedHorizonSine = union.flatHorizonSine;
    if (this.elevationHorizonCertain) {
      union.elevatedHorizonCosine =
        union.flatHorizonCosine * this.displacementHorizonCosine -
        union.flatHorizonSine * this.displacementHorizonSine;
      union.elevatedHorizonSine =
        union.flatHorizonSine * this.displacementHorizonCosine +
        union.flatHorizonCosine * this.displacementHorizonSine;
    }
  }

  private refreshEyeVisibleCounts(): void {
    const camera = this.lastCamera;
    if (!camera || !this.enabledValue) return;
    const cameras = camera instanceof THREE.ArrayCamera
      ? camera.cameras
      : undefined;
    this.prepareEyePosition(this.eyeStates[0]!, cameras?.[0] ?? camera);
    this.prepareFrustum(this.eyeStates[0]!, cameras?.[0] ?? camera);
    if (this.eyeCount === 2) {
      this.prepareEyePosition(this.eyeStates[1]!, cameras?.[1] ?? camera);
      this.prepareFrustum(this.eyeStates[1]!, cameras?.[1] ?? camera);
    }
    if (
      !this.eyeStates[0]!.horizonCertain ||
      (this.eyeCount === 2 && !this.eyeStates[1]!.horizonCertain)
    ) {
      const count = this.entries.length;
      this.leftEyeVisibleCount = count;
      this.rightEyeVisibleCount = this.eyeCount === 2 ? count : 0;
      return;
    }
    for (let eyeIndex = 0; eyeIndex < this.eyeCount; eyeIndex += 1) {
      const eye = this.eyeStates[eyeIndex]!;
      eye.elevatedHorizonCosine = eye.flatHorizonCosine;
      eye.elevatedHorizonSine = eye.flatHorizonSine;
      if (this.elevationHorizonCertain) {
        eye.elevatedHorizonCosine =
          eye.flatHorizonCosine * this.displacementHorizonCosine -
          eye.flatHorizonSine * this.displacementHorizonSine;
        eye.elevatedHorizonSine =
          eye.flatHorizonSine * this.displacementHorizonCosine +
          eye.flatHorizonCosine * this.displacementHorizonSine;
      }
    }

    let leftVisible = 0;
    let rightVisible = 0;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      const needsBounds = entry.usesElevationBounds;
      if (
        needsBounds &&
        (!Number.isFinite(this.sphereExpansion) ||
          !this.elevationHorizonCertain)
      ) {
        leftVisible += 1;
        if (this.eyeCount === 2) rightVisible += 1;
        continue;
      }
      this.expandedSphere.center.copy(entry.baseSphere.center);
      this.expandedSphere.radius = entry.baseSphere.radius +
        (needsBounds ? this.sphereExpansion : 0);
      const left = this.withinHorizon(
        entry,
        this.eyeStates[0]!,
        needsBounds,
        this.elevationHorizonCertain,
      ) && this.eyeStates[0]!.frustum.intersectsSphere(this.expandedSphere);
      if (left) leftVisible += 1;
      if (this.eyeCount === 2) {
        const right = this.withinHorizon(
          entry,
          this.eyeStates[1]!,
          needsBounds,
          this.elevationHorizonCertain,
        ) && this.eyeStates[1]!.frustum.intersectsSphere(this.expandedSphere);
        if (right) rightVisible += 1;
      }
    }
    this.leftEyeVisibleCount = leftVisible;
    this.rightEyeVisibleCount = rightVisible;
  }

  private withinHorizon(
    entry: TerrainRenderVisibilityEntry,
    eye: EyeVisibilityState,
    usesElevationBounds: boolean,
    elevationHorizonCertain: boolean,
  ): boolean {
    if (!eye.horizonCertain) return true;
    if (usesElevationBounds && !elevationHorizonCertain) return true;
    const horizonCosine = usesElevationBounds
      ? eye.elevatedHorizonCosine
      : eye.flatHorizonCosine;
    const horizonSine = usesElevationBounds
      ? eye.elevatedHorizonSine
      : eye.flatHorizonSine;
    if (entry.ellipsoidConeCosine <= -horizonCosine) return true;
    const threshold =
      horizonCosine * entry.ellipsoidConeCosine -
      horizonSine * entry.ellipsoidConeSine;
    return eye.ellipsoidDirection.dot(entry.ellipsoidConeAxis) >= threshold;
  }

  private showAll(): void {
    for (let index = 0; index < this.entries.length; index += 1) {
      this.entries[index]!.mesh.visible = true;
    }
    const count = this.entries.length;
    this.leftEyeVisibleCount = count;
    this.rightEyeVisibleCount = this.eyeCount === 2 ? count : 0;
    this.stereoUnionVisibleCount = count;
    this.horizonCulledCount = 0;
    this.frustumCulledCount = 0;
    this.conservativeRetainCount = 0;
  }

  private recordTiming(durationMs: number): void {
    this.timingSamples[this.timingSampleIndex] = durationMs;
    this.timingSampleIndex =
      (this.timingSampleIndex + 1) % TIMING_SAMPLE_CAPACITY;
    this.timingSampleCount += 1;
  }
}
