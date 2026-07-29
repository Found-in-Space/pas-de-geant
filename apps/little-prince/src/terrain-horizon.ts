export const DEFAULT_EYE_HEIGHT_M = 2;
const EARTH_MEAN_RADIUS_KM = 6_371.0088;

export function terrainHorizonRadians(
  displayRadiusM: number,
  eyeHeightM = DEFAULT_EYE_HEIGHT_M,
): number {
  const radius = Math.max(0.001, displayRadiusM);
  return Math.acos(radius / (radius + Math.max(0, eyeHeightM)));
}

export function terrainHorizonDegrees(
  displayRadiusM: number,
  eyeHeightM = DEFAULT_EYE_HEIGHT_M,
): number {
  return (terrainHorizonRadians(displayRadiusM, eyeHeightM) * 180) / Math.PI;
}

export function terrainHorizonDiameterM(
  displayRadiusM: number,
  eyeHeightM = DEFAULT_EYE_HEIGHT_M,
): number {
  return (
    2 *
    Math.max(0.001, displayRadiusM) *
    terrainHorizonRadians(displayRadiusM, eyeHeightM)
  );
}

export function terrainHorizonSourceDistanceKm(
  displayRadiusM: number,
  eyeHeightM = DEFAULT_EYE_HEIGHT_M,
): number {
  return (
    EARTH_MEAN_RADIUS_KM * terrainHorizonRadians(displayRadiusM, eyeHeightM)
  );
}
