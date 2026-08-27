export interface EarthMapRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface EarthCoordinates {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export function parseEarthCoordinatePair(
  value: string,
): EarthCoordinates | undefined {
  const parts = value.split(",");
  if (parts.length !== 2) return undefined;
  const latitudeText = parts[0]?.trim() ?? "";
  const longitudeText = parts[1]?.trim() ?? "";
  if (!latitudeText || !longitudeText) return undefined;
  const latitudeDegrees = Number(latitudeText);
  const longitudeDegrees = Number(longitudeText);
  if (
    !Number.isFinite(latitudeDegrees) ||
    latitudeDegrees < -90 ||
    latitudeDegrees > 90 ||
    !Number.isFinite(longitudeDegrees) ||
    longitudeDegrees < -180 ||
    longitudeDegrees > 180
  ) return undefined;
  return { latitudeDegrees, longitudeDegrees };
}

export function normalizeLongitudeDegrees(longitudeDegrees: number): number {
  return ((longitudeDegrees + 180) % 360 + 360) % 360 - 180;
}

export function earthMapImageRects(
  latitudeDegrees: number,
  longitudeDegrees: number,
  rect: EarthMapRect,
  zoom = 4,
): EarthMapRect[] {
  const latitude = Math.max(-90, Math.min(90, latitudeDegrees));
  const longitude = normalizeLongitudeDegrees(longitudeDegrees);
  const resolvedZoom = Math.max(1, zoom);
  const width = rect.width * resolvedZoom;
  const height = width / 2;
  const centreX = rect.x + rect.width / 2;
  const centreY = rect.y + rect.height / 2;
  const x = centreX - (longitude + 180) / 360 * width;
  const y = centreY - (90 - latitude) / 180 * height;
  return [0, -1, 1].map((wrap) => ({
    x: x + wrap * width,
    y,
    width,
    height,
  }));
}

export function earthMapPoint(
  latitudeDegrees: number,
  longitudeDegrees: number,
  rect: EarthMapRect,
): { x: number; y: number } {
  const latitude = Math.max(-90, Math.min(90, latitudeDegrees));
  const longitude = normalizeLongitudeDegrees(longitudeDegrees);
  return {
    x: rect.x + (longitude + 180) / 360 * rect.width,
    y: rect.y + (90 - latitude) / 180 * rect.height,
  };
}

export function earthMapCoordinates(
  x: number,
  y: number,
  rect: EarthMapRect,
): EarthCoordinates {
  if (rect.width <= 0 || rect.height <= 0) {
    throw new RangeError("Earth map dimensions must be positive.");
  }
  const horizontal = Math.max(0, Math.min(1, (x - rect.x) / rect.width));
  const vertical = Math.max(0, Math.min(1, (y - rect.y) / rect.height));
  return {
    latitudeDegrees: 90 - vertical * 180,
    longitudeDegrees: horizontal * 360 - 180,
  };
}
