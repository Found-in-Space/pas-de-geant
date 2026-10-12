import * as THREE from "three";
import { celestialBody } from "@found-in-space/worlds";
import type { TerrainSurface } from "@found-in-space/worlds/terrain-surface";
import { eclipseEarthSurfaceObservation } from "./eclipse-earth-surface.js";

export interface BodySurfaceView {
  latitudeDegrees: number;
  longitudeDegrees: number;
  /** Distance above loaded terrain, in the rendered world's metres. */
  observerHeightWorldM: number;
  referenceSurfaceHeightWorldM: number;
  elevationMetres: number;
  displayRadiusM: number;
}

/** Measures from the posed camera to loaded terrain, including negative relief. */
export function observeBodySurface(options: {
  bodyId: "earth" | "moon";
  root: THREE.Object3D;
  camera: THREE.Camera;
  surface: Pick<TerrainSurface, "sampleElevationMetres">;
  terrainMultiplier: number;
}): BodySurfaceView {
  const { bodyId, root, camera, surface, terrainMultiplier } = options;
  camera.updateWorldMatrix(true, false);
  root.updateWorldMatrix(true, false);
  const headLocal = root.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
  const displayRadiusM = root.getWorldScale(new THREE.Vector3()).x;
  const referenceRadiusM = celestialBody(bodyId).referenceRadiusM;
  let latitudeDegrees: number;
  let longitudeDegrees: number;
  let referenceHeightPhysicalM: number;
  if (bodyId === "earth") {
    const observation = eclipseEarthSurfaceObservation(
      headLocal.multiplyScalar(referenceRadiusM),
    );
    latitudeDegrees = observation.latitudeDegrees;
    longitudeDegrees = observation.longitudeDegrees;
    referenceHeightPhysicalM = observation.signedHeadHeightPhysicalM;
  } else {
    const distance = Math.max(Number.EPSILON, headLocal.length());
    latitudeDegrees = THREE.MathUtils.radToDeg(Math.asin(
      THREE.MathUtils.clamp(headLocal.y / distance, -1, 1),
    ));
    longitudeDegrees = THREE.MathUtils.radToDeg(Math.atan2(-headLocal.z, headLocal.x));
    referenceHeightPhysicalM = (distance - 1) * referenceRadiusM;
  }
  const elevationMetres = surface.sampleElevationMetres(latitudeDegrees, longitudeDegrees);
  const renderMetresPerPhysicalMetre = displayRadiusM / referenceRadiusM;
  return {
    latitudeDegrees,
    longitudeDegrees,
    observerHeightWorldM: Math.max(0.001,
      (referenceHeightPhysicalM - elevationMetres * terrainMultiplier) * renderMetresPerPhysicalMetre,
    ),
    referenceSurfaceHeightWorldM: referenceHeightPhysicalM * renderMetresPerPhysicalMetre,
    elevationMetres,
    displayRadiusM,
  };
}
