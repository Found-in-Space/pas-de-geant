

export function validScaleDenominator(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("Scale denominator must be positive and finite.");
  }
  return value;
}

/** Headset metres occupied by a physical distance at a conventional 1:N scale. */
export function headsetMetresForPhysicalMetres(
  physicalMetres: number,
  scaleDenominator: number,
): number {
  return physicalMetres / validScaleDenominator(scaleDenominator);
}

/** Physical metres represented by a distance measured in headset space. */
export function physicalMetresForHeadsetMetres(
  headsetMetres: number,
  scaleDenominator: number,
): number {
  return headsetMetres * validScaleDenominator(scaleDenominator);
}

export function displayRadiusMetres(
  referenceRadiusM: number,
  scaleDenominator: number,
): number {
  return headsetMetresForPhysicalMetres(referenceRadiusM, scaleDenominator);
}

/** Keeps a physical offset fixed while re-expressing it in headset metres. */
export function headsetScaleFactorForDenominatorChange(
  oldScaleDenominator: number,
  newScaleDenominator: number,
): number {
  return validScaleDenominator(oldScaleDenominator) /
    validScaleDenominator(newScaleDenominator);
}
