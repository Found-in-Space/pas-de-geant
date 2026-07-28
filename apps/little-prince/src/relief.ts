import {
  DataTexture,
  NearestFilter,
  RGFormat,
  UnsignedByteType,
} from "three";

export const RELIEF_WIDTH = 4096;
export const RELIEF_HEIGHT = 2048;
export const RELIEF_OFFSET_METRES = -12000;
export const RELIEF_SCALE_METRES = 1;

export interface ReliefDatasetMetadata {
  width: number;
  height: number;
  offsetMetres: number;
  scaleMetres: number;
  datum: string;
  source: string;
  checksum: string;
}

export interface ReliefDataset {
  metadata: ReliefDatasetMetadata;
  samples: Uint16Array;
  texture: DataTexture;
  fallback: boolean;
}

export function decodeReliefSample(encoded: number): number {
  return encoded * RELIEF_SCALE_METRES + RELIEF_OFFSET_METRES;
}

export function packReliefSamples(samples: Uint16Array): Uint8Array {
  const packed = new Uint8Array(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    packed[index * 2] = value & 0xff;
    packed[index * 2 + 1] = value >>> 8;
  }
  return packed;
}

export function reliefPixel(
  longitudeDegrees: number,
  latitudeDegrees: number,
  width = RELIEF_WIDTH,
  height = RELIEF_HEIGHT,
): { x: number; y: number } {
  const longitude = ((longitudeDegrees + 180) % 360 + 360) % 360;
  const latitude = Math.max(-90, Math.min(90, latitudeDegrees));
  return {
    x: longitude / 360 * width,
    y: (90 - latitude) / 180 * (height - 1),
  };
}

export function sampleRelief(
  samples: Uint16Array,
  longitudeDegrees: number,
  latitudeDegrees: number,
  width = RELIEF_WIDTH,
  height = RELIEF_HEIGHT,
): number {
  const pixel = reliefPixel(
    longitudeDegrees,
    latitudeDegrees,
    width,
    height,
  );
  const x0 = Math.floor(pixel.x) % width;
  const x1 = (x0 + 1) % width;
  const y0 = Math.floor(pixel.y);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = pixel.x - Math.floor(pixel.x);
  const ty = pixel.y - y0;
  const northWest = samples[y0 * width + x0] ?? -RELIEF_OFFSET_METRES;
  const northEast = samples[y0 * width + x1] ?? northWest;
  const southWest = samples[y1 * width + x0] ?? northWest;
  const southEast = samples[y1 * width + x1] ?? southWest;
  const north = northWest + (northEast - northWest) * tx;
  const south = southWest + (southEast - southWest) * tx;
  return decodeReliefSample(north + (south - north) * ty);
}

function textureForSamples(
  samples: Uint16Array,
  width: number,
  height: number,
): DataTexture {
  const texture = new DataTexture(
    packReliefSamples(samples),
    width,
    height,
    RGFormat,
    UnsignedByteType,
  );
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function fallbackRelief(): ReliefDataset {
  const samples = new Uint16Array([
    -RELIEF_OFFSET_METRES,
    -RELIEF_OFFSET_METRES,
    -RELIEF_OFFSET_METRES,
    -RELIEF_OFFSET_METRES,
    -RELIEF_OFFSET_METRES,
    -RELIEF_OFFSET_METRES,
    -RELIEF_OFFSET_METRES,
    -RELIEF_OFFSET_METRES,
  ]);
  return {
    metadata: {
      width: 4,
      height: 2,
      offsetMetres: RELIEF_OFFSET_METRES,
      scaleMetres: RELIEF_SCALE_METRES,
      datum: "mean sea level",
      source: "flat emergency fallback",
      checksum: "",
    },
    samples,
    texture: textureForSamples(samples, 4, 2),
    fallback: true,
  };
}

export async function loadReliefDataset(
  baseUrl = "./relief",
): Promise<ReliefDataset> {
  try {
    const [metadataResponse, dataResponse] = await Promise.all([
      fetch(`${baseUrl}/gebco-2026-r16.json`),
      fetch(`${baseUrl}/gebco-2026-r16.bin`),
    ]);
    if (!metadataResponse.ok || !dataResponse.ok) {
      throw new Error("The relief asset is unavailable.");
    }
    const metadata =
      await metadataResponse.json() as ReliefDatasetMetadata;
    const buffer = await dataResponse.arrayBuffer();
    const samples = new Uint16Array(buffer);
    if (samples.length !== metadata.width * metadata.height) {
      throw new Error("The relief asset has an unexpected size.");
    }
    return {
      metadata,
      samples,
      texture: textureForSamples(
        samples,
        metadata.width,
        metadata.height,
      ),
      fallback: false,
    };
  } catch (error) {
    console.warn("Using flat emergency relief:", error);
    return fallbackRelief();
  }
}
