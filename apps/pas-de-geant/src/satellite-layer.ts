import {
  eciToGeodetic,
  gstime,
  json2satrec,
  propagate,
  type GeodeticLocation,
  type OMMJsonObject,
  type SatRec,
} from "satellite.js";
import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  normalizedRadialOffsetForKilometres,
  WGS84_A_KM,
  WGS84_B_KM,
} from "./planet-state.js";
import {
  SATELLITE_GROUPS,
  satelliteGroupConfiguration,
  type SatelliteGroupId,
} from "./satellite-groups.js";

const SATELLITE_SYMBOL_SIZE_M = 0.075;
const WGS84_ECCENTRICITY_SQUARED =
  1 - (WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);

interface TrackedSatellite {
  readonly catalogId: string;
  readonly name: string;
  readonly record: SatRec;
}

interface SatelliteGroupMesh {
  readonly mesh: THREE.InstancedMesh;
  satellites: TrackedSatellite[];
  visible: boolean;
}

const identityRotation = new THREE.Quaternion();
const markerScale = new THREE.Vector3();
const markerPosition = new THREE.Vector3();
const surfaceNormal = new THREE.Vector3();
const instanceMatrix = new THREE.Matrix4();

export function satelliteNormalizedPosition(
  geodetic: GeodeticLocation,
  radialMultiplier: number,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const sineLatitude = Math.sin(geodetic.latitude);
  const cosineLatitude = Math.cos(geodetic.latitude);
  const sineLongitude = Math.sin(geodetic.longitude);
  const cosineLongitude = Math.cos(geodetic.longitude);
  const primeVerticalRadius =
    WGS84_A_KM /
    Math.sqrt(
      1 - WGS84_ECCENTRICITY_SQUARED * sineLatitude * sineLatitude,
    );
  target.set(
    primeVerticalRadius * cosineLatitude * cosineLongitude,
    primeVerticalRadius *
      (1 - WGS84_ECCENTRICITY_SQUARED) * sineLatitude,
    -primeVerticalRadius * cosineLatitude * sineLongitude,
  ).multiplyScalar(1 / EARTH_MEAN_RADIUS_KM);
  surfaceNormal.set(
    cosineLatitude * cosineLongitude,
    sineLatitude,
    -cosineLatitude * sineLongitude,
  );
  return target.addScaledVector(
    surfaceNormal,
    normalizedRadialOffsetForKilometres(
      Math.max(0, geodetic.height),
      radialMultiplier,
    ),
  );
}

function createGroupMesh(color: number, capacity: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(0.5, 0),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    }),
    Math.max(1, capacity),
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 13;
  mesh.count = 0;
  return mesh;
}

function trackedSatellite(
  elements: OMMJsonObject,
): TrackedSatellite | undefined {
  try {
    return {
      catalogId: String(elements.NORAD_CAT_ID),
      name: elements.OBJECT_NAME.trim(),
      record: json2satrec(elements),
    };
  } catch {
    return undefined;
  }
}

export class SatelliteLayer {
  readonly group = new THREE.Group();
  private readonly groups = new Map<SatelliteGroupId, SatelliteGroupMesh>();

  constructor() {
    this.group.name = "satellites";
    for (const configuration of SATELLITE_GROUPS) {
      const mesh = createGroupMesh(configuration.color, 1);
      mesh.name = `satellites-${configuration.id}`;
      mesh.visible = false;
      this.group.add(mesh);
      this.groups.set(configuration.id, {
        mesh,
        satellites: [],
        visible: false,
      });
    }
  }

  setSatellites(
    group: SatelliteGroupId,
    elements: readonly OMMJsonObject[],
  ): number {
    const current = this.groups.get(group)!;
    const satellites = elements.flatMap((value) => {
      const satellite = trackedSatellite(value);
      return satellite ? [satellite] : [];
    });
    const replacement = createGroupMesh(
      satelliteGroupConfiguration(group).color,
      satellites.length,
    );
    replacement.name = current.mesh.name;
    replacement.visible = current.visible;
    this.group.remove(current.mesh);
    current.mesh.geometry.dispose();
    (current.mesh.material as THREE.Material).dispose();
    this.group.add(replacement);
    this.groups.set(group, {
      mesh: replacement,
      satellites,
      visible: current.visible,
    });
    return satellites.length;
  }

  setGroupVisible(group: SatelliteGroupId, visible: boolean): void {
    const current = this.groups.get(group)!;
    current.visible = visible;
    current.mesh.visible = visible;
    if (!visible) current.mesh.count = 0;
  }

  groupVisible(group: SatelliteGroupId): boolean {
    return this.groups.get(group)!.visible;
  }

  update(
    atMs: number,
    displayRadiusM: number,
    radialMultiplier: number,
  ): void {
    let anyVisible = false;
    for (const current of this.groups.values()) {
      if (current.visible) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible) return;
    const date = new Date(atMs);
    const siderealTime = gstime(date);
    const symbolScale = SATELLITE_SYMBOL_SIZE_M / displayRadiusM;
    markerScale.setScalar(symbolScale);
    const claimedCatalogIds = new Set<string>();
    const priority: readonly SatelliteGroupId[] = [
      "stations",
      "science-education",
      "visual",
    ];
    for (const id of priority) {
      const current = this.groups.get(id)!;
      if (!current.visible) continue;
      let count = 0;
      for (const satellite of current.satellites) {
        if (claimedCatalogIds.has(satellite.catalogId)) continue;
        const state = propagate(satellite.record, date);
        if (!state) continue;
        satelliteNormalizedPosition(
          eciToGeodetic(state.position, siderealTime),
          radialMultiplier,
          markerPosition,
        );
        instanceMatrix.compose(markerPosition, identityRotation, markerScale);
        current.mesh.setMatrixAt(count, instanceMatrix);
        claimedCatalogIds.add(satellite.catalogId);
        count += 1;
      }
      current.mesh.count = count;
      current.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
