export interface ImageryMipLevel {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** Dimensions of a complete mip chain, including the base level and 1 x 1. */
export function imageryMipDimensions(
  width: number,
  height: number,
): readonly { width: number; height: number }[] {
  const dimensions: { width: number; height: number }[] = [];
  let levelWidth = width;
  let levelHeight = height;
  while (true) {
    dimensions.push({ width: levelWidth, height: levelHeight });
    if (levelWidth === 1 && levelHeight === 1) return dimensions;
    levelWidth = Math.max(1, Math.floor(levelWidth / 2));
    levelHeight = Math.max(1, Math.floor(levelHeight / 2));
  }
}

/**
 * Builds every mip from the already-padded base. Neighbour pixels therefore
 * participate in minification before a layer can become visible.
 */
export function generateImageryMipChain(
  basePixels: Uint8Array,
  width: number,
  height: number,
): readonly ImageryMipLevel[] {
  if (basePixels.byteLength !== width * height * 4) {
    throw new Error("The imagery mip base has unexpected dimensions.");
  }
  const levels: ImageryMipLevel[] = [
    { width, height, pixels: basePixels },
  ];
  let source = basePixels;
  let sourceWidth = width;
  let sourceHeight = height;
  while (sourceWidth > 1 || sourceHeight > 1) {
    const nextWidth = Math.max(1, Math.floor(sourceWidth / 2));
    const nextHeight = Math.max(1, Math.floor(sourceHeight / 2));
    const next = new Uint8Array(nextWidth * nextHeight * 4);
    for (let y = 0; y < nextHeight; y += 1) {
      const sourceY0 = Math.floor((y * sourceHeight) / nextHeight);
      const sourceY1 = Math.max(
        sourceY0 + 1,
        Math.floor(((y + 1) * sourceHeight) / nextHeight),
      );
      for (let x = 0; x < nextWidth; x += 1) {
        const sourceX0 = Math.floor((x * sourceWidth) / nextWidth);
        const sourceX1 = Math.max(
          sourceX0 + 1,
          Math.floor(((x + 1) * sourceWidth) / nextWidth),
        );
        const destinationOffset = (y * nextWidth + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          let sum = 0;
          let samples = 0;
          for (let sourceY = sourceY0; sourceY < sourceY1; sourceY += 1) {
            for (let sourceX = sourceX0; sourceX < sourceX1; sourceX += 1) {
              sum += source[(sourceY * sourceWidth + sourceX) * 4 + channel]!;
              samples += 1;
            }
          }
          next[destinationOffset + channel] = Math.round(sum / samples);
        }
      }
    }
    levels.push({ width: nextWidth, height: nextHeight, pixels: next });
    source = next;
    sourceWidth = nextWidth;
    sourceHeight = nextHeight;
  }
  return levels;
}
