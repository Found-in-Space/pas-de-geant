import * as THREE from "three";
import { EARTH_SURFACE_MODEL } from "./surface-model.js";
import {
  surfaceDisplacementBounds,
  surfaceVisibilityHorizonRadians,
  surfaceTargetHorizonRadians,
  type ElevationBoundsMetres,
  type SurfaceDisplacementBounds,
  type SurfaceVisibilityGeometry,
} from "./surface-visibility-geometry.js";
export type { ElevationBoundsMetres } from "./surface-visibility-geometry.js";
const TIMING_SAMPLE_CAPACITY = 900;
const PACKED_ENTRY_STRIDE = 13;
const PACKED_CENTER_X = 0;
const PACKED_CENTER_Y = 1;
const PACKED_CENTER_Z = 2;
const PACKED_RADIUS = 3;
const PACKED_CONE_AXIS_X = 4;
const PACKED_CONE_AXIS_Y = 5;
const PACKED_CONE_AXIS_Z = 6;
const PACKED_CONE_COSINE = 7;
const PACKED_CONE_SINE = 8;
const PACKED_SPHERE_EXPANSION = 9;
const PACKED_HORIZON_DELTA_COSINE = 10;
const PACKED_HORIZON_DELTA_SINE = 11;
const PACKED_BOUNDS_FINITE = 12;

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
  readonly measuredElevationBoundCount: number;
  readonly providerFallbackElevationBoundCount: number;
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
  };
}

/**
 * Builds immutable render-only bounds from the geometry's undisplaced vertices.
 * This runs only when a committed mesh is created.
 */
export function createTerrainRenderVisibilityEntry(
  mesh: THREE.Mesh<THREE.BufferGeometry>,
  usesElevationBounds: boolean,
  bodyGeometry: SurfaceVisibilityGeometry = EARTH_SURFACE_MODEL.visibilityGeometry,
): TerrainRenderVisibilityEntry {
  const geometry = mesh.geometry;
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  const boundingSphere = geometry.boundingSphere;
  if (!boundingSphere) {
    throw new Error("Terrain geometry must have a finite bounding sphere.");
  }

  const coneAxis = boundingSphere.center.clone().set(
    boundingSphere.center.x * bodyGeometry.xzScale,
    boundingSphere.center.y * bodyGeometry.yScale,
    boundingSphere.center.z * bodyGeometry.xzScale,
  );
  const coneCentreDistance = coneAxis.length();
  const coneRadius = boundingSphere.radius * bodyGeometry.maximumScale;
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
  private readonly measuredBounds = new WeakMap<TerrainRenderVisibilityEntry, ElevationBoundsMetres>();
  private readonly entryIndices = new WeakMap<TerrainRenderVisibilityEntry, number>();
  private enabledValue = true;
  private terrainMultiplier = Number.NaN;
  private displayRadiusM = Number.NaN;
  private minimumMeshRadius = Number.NaN;
  private displacementBounds: SurfaceDisplacementBounds | undefined;
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
    private readonly bodyGeometry: SurfaceVisibilityGeometry = EARTH_SURFACE_MODEL.visibilityGeometry,
  ) {
    this.elevationBounds = elevationBounds;
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
      measuredElevationBoundCount: this.entries.filter((entry) => entry.usesElevationBounds && this.measuredBounds.has(entry)).length,
      providerFallbackElevationBoundCount: this.entries.filter((entry) => entry.usesElevationBounds && !this.measuredBounds.has(entry)).length,
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
      this.entryIndices.set(entry, index);
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
      this.packElevationBounds(entry, index);
    }
    if (!this.enabledValue) this.showAll();
  }

  updateDisplacement(
    terrainMultiplier: number,
    displayRadiusM: number,
    minimumMeshRadius = 1,
  ): void {
    if (
      this.terrainMultiplier === terrainMultiplier &&
      this.displayRadiusM === displayRadiusM &&
      this.minimumMeshRadius === minimumMeshRadius
    ) return;
    this.terrainMultiplier = terrainMultiplier;
    this.displayRadiusM = displayRadiusM;
    this.minimumMeshRadius = minimumMeshRadius;
    this.displacementBounds = surfaceDisplacementBounds(
      this.bodyGeometry, this.elevationBounds,
      terrainMultiplier, displayRadiusM, minimumMeshRadius,
    );
    for (let index = 0; index < this.entries.length; index += 1) this.packElevationBounds(this.entries[index]!, index);
  }

  /** Measured crop extrema override only this target's displacement. The
   * occluding shell remains shared and conservative for unknown terrain. */
  setElevationBounds(entry: TerrainRenderVisibilityEntry, bounds: ElevationBoundsMetres | undefined): void {
    if (bounds && Number.isFinite(bounds.minimum) && Number.isFinite(bounds.maximum) && bounds.minimum <= bounds.maximum) {
      this.measuredBounds.set(entry, bounds);
    } else this.measuredBounds.delete(entry);
    const index = this.entryIndices.get(entry);
    if (index !== undefined && this.entries[index] === entry) this.packElevationBounds(entry, index);
  }

  private packElevationBounds(entry: TerrainRenderVisibilityEntry, index: number): void {
    const offset = index * PACKED_ENTRY_STRIDE;
    const local = surfaceDisplacementBounds(this.bodyGeometry, this.measuredBounds.get(entry) ?? this.elevationBounds,
      this.terrainMultiplier, this.displayRadiusM, this.minimumMeshRadius);
    const global = this.displacementBounds;
    this.packedEntries[offset + PACKED_BOUNDS_FINITE] = local && global ? 1 : 0;
    this.packedEntries[offset + PACKED_SPHERE_EXPANSION] = local?.sphereExpansion ?? Infinity;
    const delta = local && global ? surfaceTargetHorizonRadians({ ...local, innerRadius: global.innerRadius }) -
      surfaceTargetHorizonRadians(global, false) : 0;
    this.packedEntries[offset + PACKED_HORIZON_DELTA_COSINE] = Math.cos(delta);
    this.packedEntries[offset + PACKED_HORIZON_DELTA_SINE] = Math.sin(delta);
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
    const flatHorizonCosine = union.flatHorizonCosine;
    const flatHorizonSine = union.flatHorizonSine;
    for (
      let index = 0, packedIndex = 0;
      index < entries.length;
      index += 1, packedIndex += PACKED_ENTRY_STRIDE
    ) {
      const entry = entries[index]!;
      const needsBounds = elevationBoundFlags[index] !== 0;
      if (
        needsBounds &&
        packedEntries[packedIndex + PACKED_BOUNDS_FINITE] === 0
      ) {
        entry.mesh.visible = true;
        unionVisible += 1;
        conservativeRetain += 1;
        continue;
      }

      const deltaCosine = packedEntries[packedIndex + PACKED_HORIZON_DELTA_COSINE]!;
      const deltaSine = packedEntries[packedIndex + PACKED_HORIZON_DELTA_SINE]!;
      const fullHorizon = needsBounds && flatHorizonCosine <= -deltaCosine;
      const horizonCosine = !needsBounds ? flatHorizonCosine : fullHorizon ? -1 :
        flatHorizonCosine * deltaCosine - flatHorizonSine * deltaSine;
      const coneCosine = packedEntries[
        packedIndex + PACKED_CONE_COSINE
      ]!;
      let withinHorizon = true;
      if (coneCosine > -horizonCosine) {
        const horizonSine = !needsBounds ? flatHorizonSine : fullHorizon ? 0 :
          flatHorizonSine * deltaCosine + flatHorizonCosine * deltaSine;
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
          (needsBounds ? packedEntries[packedIndex + PACKED_SPHERE_EXPANSION]! : 0)
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
      eye.localPosition.x * this.bodyGeometry.xzScale,
      eye.localPosition.y * this.bodyGeometry.yScale,
      eye.localPosition.z * this.bodyGeometry.xzScale,
    );
    const radius = eye.ellipsoidDirection.length();
    const flat = surfaceVisibilityHorizonRadians(radius, this.displacementBounds, false);
    eye.horizonCertain = flat !== undefined;
    if (!eye.horizonCertain) {
      eye.ellipsoidDirection.set(0, 1, 0);
      eye.flatHorizonCosine = 1;
      eye.flatHorizonSine = 0;
      return;
    }
    eye.ellipsoidDirection.multiplyScalar(1 / radius);
    eye.flatHorizonCosine = Math.cos(flat!);
    eye.flatHorizonSine = Math.sin(flat!);
  }

  private prepareUnionHorizon(): void {
    const union = this.unionState;
    const left = this.eyeStates[0]!;
    union.horizonCertain = left.horizonCertain;
    union.ellipsoidDirection.copy(left.ellipsoidDirection);
    union.flatHorizonCosine = left.flatHorizonCosine;
    union.flatHorizonSine = left.flatHorizonSine;
    if (this.eyeCount === 1) return;
    const right = this.eyeStates[1]!;
    union.horizonCertain &&= right.horizonCertain;
    union.ellipsoidDirection.add(right.ellipsoidDirection);
    const length = union.ellipsoidDirection.length();
    if (!Number.isFinite(length) || length <= 0) {
      union.horizonCertain = false;
      return;
    }
    union.ellipsoidDirection.multiplyScalar(1 / length);
    if (!union.horizonCertain) return;
    const margin = Math.acos(Math.max(-1, Math.min(1, Math.min(
      union.ellipsoidDirection.dot(left.ellipsoidDirection),
      union.ellipsoidDirection.dot(right.ellipsoidDirection),
    ))));
    const flat = Math.min(Math.PI, Math.acos(Math.min(
      left.flatHorizonCosine, right.flatHorizonCosine,
    )) + margin);
    union.flatHorizonCosine = Math.cos(flat);
    union.flatHorizonSine = Math.sin(flat);
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
    let leftVisible = 0;
    let rightVisible = 0;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      const needsBounds = entry.usesElevationBounds;
      const packedIndex = index * PACKED_ENTRY_STRIDE;
      if (needsBounds && this.packedEntries[packedIndex + PACKED_BOUNDS_FINITE] === 0) {
        leftVisible += 1;
        if (this.eyeCount === 2) rightVisible += 1;
        continue;
      }
      this.expandedSphere.center.copy(entry.baseSphere.center);
      this.expandedSphere.radius = entry.baseSphere.radius +
        (needsBounds ? this.packedEntries[packedIndex + PACKED_SPHERE_EXPANSION]! : 0);
      const left = this.withinHorizon(
        entry,
        this.eyeStates[0]!,
        needsBounds,
        packedIndex,
      ) && this.eyeStates[0]!.frustum.intersectsSphere(this.expandedSphere);
      if (left) leftVisible += 1;
      if (this.eyeCount === 2) {
        const right = this.withinHorizon(
          entry,
          this.eyeStates[1]!,
          needsBounds,
          packedIndex,
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
    packedIndex: number,
  ): boolean {
    if (!eye.horizonCertain) return true;
    const deltaCosine = this.packedEntries[packedIndex + PACKED_HORIZON_DELTA_COSINE]!;
    const deltaSine = this.packedEntries[packedIndex + PACKED_HORIZON_DELTA_SINE]!;
    const fullHorizon = usesElevationBounds && eye.flatHorizonCosine <= -deltaCosine;
    const horizonCosine = !usesElevationBounds ? eye.flatHorizonCosine : fullHorizon ? -1 :
      eye.flatHorizonCosine * deltaCosine - eye.flatHorizonSine * deltaSine;
    const horizonSine = !usesElevationBounds ? eye.flatHorizonSine : fullHorizon ? 0 :
      eye.flatHorizonSine * deltaCosine + eye.flatHorizonCosine * deltaSine;
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
