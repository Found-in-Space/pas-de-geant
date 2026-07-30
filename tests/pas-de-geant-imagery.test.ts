import { describe, expect, it } from "vitest";
import {
  IMAGERY_GPU_PAGE_SIZE,
  IMAGERY_PAGE_TABLE_SIZE,
  ImageryRequestTokenIndex,
  decodePageEntry,
  encodePageEntry,
  imageryKey,
  imageryOnionPlanForContact,
  projectedImageryTexelPixels,
  selectImageryZoom,
  selectUnpinnedLruKey,
} from "../apps/pas-de-geant/src/imagery-core.js";

describe("photographic imagery onion", () => {
  it("selects source zoom from projected texel size with hysteresis", () => {
    const options = {
      displayRadiusM: 500,
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      eyeHeightWorldM: 1.65,
      focalLengthPixels: 1_000,
      tileSize: 512,
      minZoom: 4,
      maxZoom: 20,
    };
    const zoom = selectImageryZoom(options);
    const pixels = projectedImageryTexelPixels(options, zoom, options.tileSize);
    expect(zoom).toBeGreaterThanOrEqual(12);
    expect(pixels).toBeLessThanOrEqual(1.25);
    expect(
      selectImageryZoom({
        ...options,
        displayRadiusM: 560,
        previousZoom: zoom,
      }),
    ).toBe(zoom);
    expect(IMAGERY_GPU_PAGE_SIZE).toBe(256);
  });

  it("builds a non-overlapping 4x4 cap and two parent rings", () => {
    const plan = imageryOnionPlanForContact(45, 9, 14);
    expect(plan.cells).toHaveLength(40);
    expect(plan.tasks).toHaveLength(40);
    expect(plan.cells.filter((cell) => cell.ring === 0)).toHaveLength(16);
    expect(plan.cells.filter((cell) => cell.ring === 1)).toHaveLength(12);
    expect(plan.cells.filter((cell) => cell.ring === 2)).toHaveLength(12);
    expect(
      [...new Set(plan.cells.map((cell) => cell.address.z))],
    ).toEqual([14, 13, 12]);

    const coverage = new Uint8Array(
      IMAGERY_PAGE_TABLE_SIZE * IMAGERY_PAGE_TABLE_SIZE,
    );
    for (const cell of plan.cells) {
      for (let y = 0; y < cell.tableSpan; y += 1) {
        for (let x = 0; x < cell.tableSpan; x += 1) {
          const index =
            (cell.tableY + y) * IMAGERY_PAGE_TABLE_SIZE +
            cell.tableX +
            x;
          coverage[index] = (coverage[index] ?? 0) + 1;
        }
      }
    }
    expect([...coverage].every((count) => count === 1)).toBe(true);
  });

  it("snaps nearby contacts to the same plan and moves as one onion", () => {
    const first = imageryOnionPlanForContact(45, 9, 14);
    const nearby = imageryOnionPlanForContact(45.0001, 9.0001, 14);
    const shifted = imageryOnionPlanForContact(45, 10, 14);
    expect(nearby.signature).toBe(first.signature);
    expect(shifted.signature).not.toBe(first.signature);
  });

  it("wraps source addresses across the antimeridian without duplicates", () => {
    const plan = imageryOnionPlanForContact(0, 179.999, 8);
    expect(plan.cells).toHaveLength(40);
    expect(new Set(plan.cells.map((cell) => imageryKey(cell.address))).size)
      .toBe(40);
    expect(
      plan.cells.every(
        (cell) =>
          cell.address.x >= 0 && cell.address.x < 2 ** cell.address.z,
      ),
    ).toBe(true);
    expect(plan.tableOriginX).toBeGreaterThan(2 ** plan.finestZoom - 16);
  });

  it("encodes coarse onion pages across their finest-cell footprint", () => {
    const target = { z: 10, x: 731, y: 512 };
    const source = { z: 8, x: 182, y: 128 };
    const encoded = encodePageEntry(target, source, 17);
    expect(decodePageEntry(encoded)).toEqual({
      layer: 17,
      scale: 4,
      offsetX: 3,
      offsetY: 0,
    });
  });

  it("allows A to restart after an A-to-B-to-A cancellation", () => {
    const requests = new ImageryRequestTokenIndex();
    const firstA = requests.begin("A");
    requests.cancel("A");
    requests.begin("B");
    requests.cancel("B");
    const replacementA = requests.begin("A");
    expect(replacementA).not.toBe(firstA);
    expect(requests.isCurrent("A", firstA)).toBe(false);
    expect(requests.isCurrent("A", replacementA)).toBe(true);
    expect(requests.complete("A", firstA)).toBe(false);
    expect(requests.complete("A", replacementA)).toBe(true);
  });

  it("evicts only the least-recently-used unpinned page", () => {
    expect(
      selectUnpinnedLruKey([
        { key: "visible", usedAt: 1, pinned: true },
        { key: "candidate", usedAt: 2, pinned: true },
        { key: "old", usedAt: 3, pinned: false },
        { key: "newer", usedAt: 4, pinned: false },
      ]),
    ).toBe("old");
  });
});
