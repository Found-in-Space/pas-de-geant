/// <reference lib="webworker" />

import type {
  ImageryDecoderCommand,
  ImageryDecoderMessage,
} from "./imagery-decoder-protocol.js";
import { generateImageryMipChain } from "./imagery-mip-chain.js";

const scope: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();

function post(message: ImageryDecoderMessage, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

async function decode(
  request: Extract<ImageryDecoderCommand, { kind: "decode" }>,
): Promise<void> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(request.blob);
    if (cancelled.delete(request.requestId)) return;
    if (bitmap.width !== request.tileSize || bitmap.height !== request.tileSize) {
      throw new Error(
        `The imagery tile must be ${request.tileSize} × ${request.tileSize} pixels.`,
      );
    }
    const paddedSize = request.tileSize + request.gutter * 2;
    const canvas = new OffscreenCanvas(paddedSize, paddedSize);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("An offscreen canvas could not stage the imagery tile.");
    const size = request.tileSize;
    const gutter = request.gutter;
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, gutter, gutter);
    context.drawImage(bitmap, 0, 0, size, 1, gutter, 0, size, gutter);
    context.drawImage(bitmap, 0, size - 1, size, 1, gutter, gutter + size, size, gutter);
    context.drawImage(bitmap, 0, 0, 1, size, 0, gutter, gutter, size);
    context.drawImage(bitmap, size - 1, 0, 1, size, gutter + size, gutter, gutter, size);
    for (const [sourceX, sourceY, targetX, targetY] of [
      [0, 0, 0, 0],
      [size - 1, 0, gutter + size, 0],
      [0, size - 1, 0, gutter + size],
      [size - 1, size - 1, gutter + size, gutter + size],
    ]) {
      context.drawImage(
        bitmap,
        sourceX!,
        sourceY!,
        1,
        1,
        targetX!,
        targetY!,
        gutter,
        gutter,
      );
    }
    const pixels = context.getImageData(0, 0, paddedSize, paddedSize).data;
    if (cancelled.delete(request.requestId)) return;
    const buffer = pixels.buffer.slice(
      pixels.byteOffset,
      pixels.byteOffset + pixels.byteLength,
    );
    post({ kind: "decoded", requestId: request.requestId, pixels: buffer }, [buffer]);
  } catch (error) {
    if (cancelled.delete(request.requestId)) return;
    post({
      kind: "failure",
      requestId: request.requestId,
      reason: error instanceof Error ? error.message : "The imagery tile could not be decoded.",
    });
  } finally {
    bitmap?.close();
  }
}

function mip(
  request: Extract<ImageryDecoderCommand, { kind: "mip" }>,
): void {
  try {
    const chain = generateImageryMipChain(
      new Uint8Array(request.pixels),
      request.width,
      request.height,
    );
    const levels = chain.map(({ width, height, pixels }) => ({
      width,
      height,
      // Every level is backed by a dedicated ArrayBuffer: level zero owns the
      // transferred request buffer and subsequent levels are worker-created.
      pixels: pixels.buffer as ArrayBuffer,
    }));
    post(
      {
        kind: "mipped",
        requestId: request.requestId,
        key: request.key,
        revision: request.revision,
        levels,
      },
      levels.map((level) => level.pixels),
    );
  } catch (error) {
    post({
      kind: "failure",
      requestId: request.requestId,
      reason:
        error instanceof Error
          ? error.message
          : "The imagery mip chain could not be generated.",
    });
  }
}

scope.onmessage = ({ data }: MessageEvent<ImageryDecoderCommand>) => {
  if (data.kind === "cancel") {
    cancelled.add(data.requestId);
    return;
  }
  if (data.kind === "mip") {
    mip(data);
    return;
  }
  void decode(data);
};
