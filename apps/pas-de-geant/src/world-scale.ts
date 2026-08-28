export const DEFAULT_SCALE_DENOMINATOR = 60_000;

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

/** Larger positive input enlarges the model, so it reduces the denominator. */
export function scaleDenominatorAfterInput(
  scaleDenominator: number,
  axis: number,
  deltaSeconds: number,
  octavesPerSecond = 0.72,
  detent = DEFAULT_SCALE_DENOMINATOR,
): number {
  const next = validScaleDenominator(scaleDenominator) *
    2 ** (-axis * octavesPerSecond * deltaSeconds);
  const detentDistance = Math.abs(Math.log2(next / detent));
  if (Math.abs(axis) < 0.12 && detentDistance < 0.035) return detent;
  return next;
}

const SCALE_NUMBER_FORMAT = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 0,
});

/** Keeps human-scale ratios exact while simplifying large planetary ratios. */
export function scaleDenominatorForDisplay(scaleDenominator: number): number {
  const denominator = validScaleDenominator(scaleDenominator);
  return denominator < 1_000
    ? Math.round(denominator)
    : Number(denominator.toPrecision(1));
}

export function formatScaleRatio(scaleDenominator: number): string {
  return `1 : ${SCALE_NUMBER_FORMAT.format(
    scaleDenominatorForDisplay(scaleDenominator),
  )}`;
}
