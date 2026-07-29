export const DEFAULT_EYE_HEIGHT_M = 1.7;
export const FALLBACK_MAX_ELEVATION_M = 8_849;
const EARTH_MEAN_RADIUS_KM = 6_371.0088;

export function terrainHorizonRadians(
  displayRadiusM: number,
  radialMultiplier: number,
  eyeHeightM = DEFAULT_EYE_HEIGHT_M,
  maximumElevationM = FALLBACK_MAX_ELEVATION_M,
): number {
  const radius = Math.max(0.001, displayRadiusM);
  const horizonAngle = (heightM: number): number =>
    Math.acos(radius / (radius + Math.max(0, heightM)));
  const maximumElevationWorldM =
    Math.max(0, maximumElevationM) /
    1_000 *
    radius /
    EARTH_MEAN_RADIUS_KM *
    Math.max(0, radialMultiplier);
  return horizonAngle(eyeHeightM) + horizonAngle(maximumElevationWorldM);
}

export function terrainHorizonDegrees(
  displayRadiusM: number,
  radialMultiplier: number,
  eyeHeightM = DEFAULT_EYE_HEIGHT_M,
  maximumElevationM = FALLBACK_MAX_ELEVATION_M,
): number {
  return (
    terrainHorizonRadians(
      displayRadiusM,
      radialMultiplier,
      eyeHeightM,
      maximumElevationM,
    ) *
    180 /
    Math.PI
  );
}

export function terrainHorizonDiameterM(
  displayRadiusM: number,
  radialMultiplier: number,
  eyeHeightM = DEFAULT_EYE_HEIGHT_M,
  maximumElevationM = FALLBACK_MAX_ELEVATION_M,
): number {
  return (
    2 *
    Math.max(0.001, displayRadiusM) *
    terrainHorizonRadians(
      displayRadiusM,
      radialMultiplier,
      eyeHeightM,
      maximumElevationM,
    )
  );
}
