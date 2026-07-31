import { describe, expect, it } from "vitest";
import {
  IMAGERY_COARSEN_TILE_WIDTH_M,
  IMAGERY_GPU_PAGE_SIZE,
  IMAGERY_ONION_TARGET_RADIUS_M,
  IMAGERY_PAGE_TABLE_SIZE,
  IMAGERY_REFINE_TILE_WIDTH_M,
  IMAGERY_TARGET_METRES_PER_TEXEL,
  IMAGERY_TARGET_TILE_WIDTH_M,
  ImageryRequestTokenIndex,
  STANDARD_IMAGERY_TEMPLATE,
  WORLD_IMAGERY_TEMPLATES,
  decodePageEntry,
  encodePageEntry,
  imageryKey,
  imageryOnionPlanForContact,
  renderedImageryTileWidthM,
  selectImageryZoom,
  selectUnpinnedLruKey,
} from "../apps/pas-de-geant/src/imagery-core.js";

describe("photographic imagery onion", () => {
  it("changes source z with world scale to keep GPU texels near one centimetre", () => {
    const expectedZooms = new Map([
      [1, 1],
      [2, 2],
      [10, 4],
      [100, 7],
      [250, 9],
      [500, 10],
      [1_000, 11],
      [2_000, 12],
    ]);
    for (const [displayRadiusM, expectedZoom] of expectedZooms) {
      const zoom = selectImageryZoom({
        displayRadiusM,
        latitudeDegrees: 46,
        minZoom: 0,
        maxZoom: 20,
      });
      const width = renderedImageryTileWidthM(
        46,
        displayRadiusM,
        zoom,
      );
      expect(zoom).toBe(expectedZoom);
      expect(width).toBeGreaterThanOrEqual(IMAGERY_COARSEN_TILE_WIDTH_M);
      expect(width).toBeLessThanOrEqual(IMAGERY_REFINE_TILE_WIDTH_M);
    }
    expect(IMAGERY_TARGET_TILE_WIDTH_M).toBe(2.56);
    expect(IMAGERY_TARGET_METRES_PER_TEXEL).toBe(0.01);
    expect(IMAGERY_GPU_PAGE_SIZE).toBe(256);
  });

  it("uses metre-space hysteresis without camera or physical-Earth inputs", () => {
    const displayRadiusForWidth = (
      widthM: number,
      zoom: number,
    ): number => widthM * 2 ** zoom / (2 * Math.PI);
    expect(
      selectImageryZoom({
        displayRadiusM: displayRadiusForWidth(
          IMAGERY_REFINE_TILE_WIDTH_M * 0.99,
          5,
        ),
        latitudeDegrees: 0,
        minZoom: 0,
        maxZoom: 20,
        previousZoom: 5,
      }),
    ).toBe(5);
    expect(
      selectImageryZoom({
        displayRadiusM: displayRadiusForWidth(
          IMAGERY_REFINE_TILE_WIDTH_M * 1.01,
          5,
        ),
        latitudeDegrees: 0,
        minZoom: 0,
        maxZoom: 20,
        previousZoom: 5,
      }),
    ).toBe(6);
    expect(
      selectImageryZoom({
        displayRadiusM: displayRadiusForWidth(
          IMAGERY_COARSEN_TILE_WIDTH_M * 1.01,
          5,
        ),
        latitudeDegrees: 0,
        minZoom: 0,
        maxZoom: 20,
        previousZoom: 5,
      }),
    ).toBe(5);
    expect(
      selectImageryZoom({
        displayRadiusM: displayRadiusForWidth(
          IMAGERY_COARSEN_TILE_WIDTH_M * 0.99,
          5,
        ),
        latitudeDegrees: 0,
        minZoom: 0,
        maxZoom: 20,
        previousZoom: 5,
      }),
    ).toBe(4);
  });

  it("builds a precomputed 4x4 cap and two non-overlapping parent rings", () => {
    const plan = imageryOnionPlanForContact(45, 9, 14);
    expect(plan.mode).toBe("onion");
    expect(STANDARD_IMAGERY_TEMPLATE).toHaveLength(40);
    expect(Object.isFrozen(STANDARD_IMAGERY_TEMPLATE)).toBe(true);
    expect(plan.cells).toHaveLength(40);
    expect(plan.tasks).toHaveLength(40);
    expect(plan.cells.filter((cell) => cell.group === 0)).toHaveLength(16);
    expect(plan.cells.filter((cell) => cell.group === 1)).toHaveLength(12);
    expect(plan.cells.filter((cell) => cell.group === 2)).toHaveLength(12);
    expect(plan.tasks.filter((task) => task.kind === "cap")).toHaveLength(16);
    expect(plan.tasks.filter((task) => task.kind === "middle")).toHaveLength(
      12,
    );
    expect(plan.tasks.filter((task) => task.kind === "outer")).toHaveLength(12);
    expect(
      Math.max(...plan.tasks.filter((task) => task.group === 0)
        .map((task) => task.priority)),
    ).toBeLessThan(
      Math.min(...plan.tasks.filter((task) => task.group === 1)
        .map((task) => task.priority)),
    );
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

  it("keeps the fixed table geometry non-overlapping at the Mercator limits", () => {
    for (const latitudeDegrees of [-85, 85]) {
      const plan = imageryOnionPlanForContact(
        latitudeDegrees,
        9,
        8,
      );
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
      expect([...coverage].every((count) => count <= 1)).toBe(true);
      expect(plan.cells.some((cell) => cell.group === 0)).toBe(true);
    }
  });

  it("covers about 5m, 10m, and 20m with progressively coarser layers", () => {
    const centralRadiusM = IMAGERY_TARGET_TILE_WIDTH_M * 2;
    const middleRadiusM = centralRadiusM * 2;
    expect(centralRadiusM).toBeCloseTo(5.12);
    expect(middleRadiusM).toBeCloseTo(10.24);
    expect(IMAGERY_ONION_TARGET_RADIUS_M).toBeCloseTo(20.48);
  });

  it("keeps photographic world coverage through the smallest scales", () => {
    const expectedCellCounts = [1, 5, 21, 37];
    expect(WORLD_IMAGERY_TEMPLATES.map((template) => template.length)).toEqual(
      [1, 5, 21, 21],
    );
    expect(Object.isFrozen(WORLD_IMAGERY_TEMPLATES)).toBe(true);
    expect(
      WORLD_IMAGERY_TEMPLATES.every((template) => Object.isFrozen(template)),
    ).toBe(true);
    for (let zoom = 0; zoom <= 3; zoom += 1) {
      const expectedCellCount = expectedCellCounts[zoom]!;
      const plan = imageryOnionPlanForContact(46, 9, zoom);
      expect(plan.mode).toBe("world");
      expect(plan.tableOriginX).toBe(0);
      expect(plan.tableOriginY).toBe(0);
      expect(plan.tableSpan).toBe(2 ** zoom);
      expect(plan.groupCount).toBe(zoom + 1);
      expect(plan.cells).toHaveLength(expectedCellCount);
      expect(plan.tasks).toHaveLength(expectedCellCount);
      expect(
        new Set(plan.tasks.map((task) => imageryKey(task.address))).size,
      ).toBe(expectedCellCount);
      expect(plan.tasks.every((task) => task.kind === "world")).toBe(true);
    }
    const zoomThree = imageryOnionPlanForContact(46, 9, 3);
    expect(zoomThree.tasks.filter((task) => task.address.z === 0)).toHaveLength(
      1,
    );
    expect(zoomThree.tasks.filter((task) => task.address.z === 1)).toHaveLength(
      4,
    );
    expect(zoomThree.tasks.filter((task) => task.address.z === 2)).toHaveLength(
      16,
    );
    expect(zoomThree.tasks.filter((task) => task.address.z === 3)).toHaveLength(
      16,
    );
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
