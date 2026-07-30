import { describe, expect, it } from "vitest";
import {
  IMAGERY_BASE_COMMIT_SCALE,
  IMAGERY_BASE_PREFETCH_SCALE,
  IMAGERY_BASE_RELEASE_SCALE,
  IMAGERY_COMMIT_SCALE,
  IMAGERY_INTERMEDIATE_MAX_ZOOM,
  IMAGERY_PAGE_TABLE_SIZE,
  IMAGERY_PREFETCH_SCALE,
  IMAGERY_RELEASE_SCALE,
  ancestorAtZoom,
  decodePageEntry,
  encodePageEntry,
  imageryActivationForScale,
  imageryBaseActivationForScale,
  imageryKey,
  imageryPlanForWindow,
  imageryWindowForContact,
  projectedImageryTexelPixels,
  resolvedImagerySource,
  selectImageryZoom,
  siblingGroup,
} from "../apps/pas-de-geant/src/imagery-core.js";

describe("photographic imagery planning", () => {
  it("activates the photographic base before local refinement", () => {
    expect(
      imageryBaseActivationForScale(
        IMAGERY_BASE_PREFETCH_SCALE - 0.01,
        "inactive",
      ),
    ).toBe("inactive");
    expect(
      imageryBaseActivationForScale(
        IMAGERY_BASE_PREFETCH_SCALE,
        "inactive",
      ),
    ).toBe("prefetching");
    expect(
      imageryBaseActivationForScale(
        IMAGERY_BASE_COMMIT_SCALE,
        "prefetching",
      ),
    ).toBe("active");
    expect(
      imageryBaseActivationForScale(
        IMAGERY_BASE_RELEASE_SCALE,
        "active",
      ),
    ).toBe("active");
    expect(
      imageryBaseActivationForScale(
        IMAGERY_BASE_RELEASE_SCALE - 0.01,
        "active",
      ),
    ).toBe("inactive");
  });

  it("uses distinct local-refinement thresholds", () => {
    expect(
      imageryActivationForScale(IMAGERY_PREFETCH_SCALE - 1, "inactive"),
    ).toBe("inactive");
    expect(
      imageryActivationForScale(IMAGERY_PREFETCH_SCALE, "inactive"),
    ).toBe("prefetching");
    expect(
      imageryActivationForScale(IMAGERY_COMMIT_SCALE, "prefetching"),
    ).toBe("active");
    expect(
      imageryActivationForScale(IMAGERY_RELEASE_SCALE, "active"),
    ).toBe("active");
    expect(
      imageryActivationForScale(IMAGERY_RELEASE_SCALE - 1, "active"),
    ).toBe("inactive");
  });

  it("selects imagery zoom from projected texel size with hysteresis", () => {
    const options = {
      displayRadiusM: 500,
      latitudeDegrees: 0,
      longitudeDegrees: 0,
      eyeHeightWorldM: 1.65,
      focalLengthPixels: 1_000,
      tileSize: 256,
      minZoom: 0,
      maxZoom: 20,
    };
    const zoom = selectImageryZoom(options);
    const pixels = projectedImageryTexelPixels(options, zoom, options.tileSize);
    expect(zoom).toBeGreaterThan(12);
    expect(pixels).toBeLessThanOrEqual(1.25);
    expect(
      selectImageryZoom({
        ...options,
        displayRadiusM: 560,
        previousZoom: zoom,
      }),
    ).toBe(zoom);
  });

  it("holds a snapped window through movement inside its dead band", () => {
    const initial = imageryWindowForContact(45, 9, 14);
    const nearby = imageryWindowForContact(45.0001, 9.0001, 14, initial);
    expect(nearby).toBe(initial);
    const moved = imageryWindowForContact(45, 10, 14, initial);
    expect(moved).not.toBe(initial);
    expect(moved.originX % 4).toBe(0);
    expect(moved.originY % 4).toBe(0);
  });

  it("wraps requests across the antimeridian without duplicating cells", () => {
    const window = imageryWindowForContact(0, 179.999, 4);
    const plan = imageryPlanForWindow(window);
    expect(plan.cells).toHaveLength(IMAGERY_PAGE_TABLE_SIZE ** 2);
    expect(new Set(plan.cells.map((cell) => imageryKey(cell.address))).size).toBe(
      IMAGERY_PAGE_TABLE_SIZE ** 2,
    );
    expect(
      plan.cells.every(
        (cell) => cell.address.x >= 0 && cell.address.x < 2 ** cell.address.z,
      ),
    ).toBe(true);
  });

  it("shrinks the virtual window for low-zoom providers", () => {
    const window = imageryWindowForContact(0, 0, 2);
    const plan = imageryPlanForWindow(window);
    expect(window.size).toBe(4);
    expect(plan.cells).toHaveLength(16);
    expect(new Set(plan.cells.map((cell) => imageryKey(cell.address))).size).toBe(
      16,
    );
  });

  it("keeps an exact sibling group at its resident parent until complete", () => {
    const target = { z: 8, x: 40, y: 60 };
    const parent = ancestorAtZoom(target, 7);
    const resident = new Set([imageryKey(parent)]);
    resident.add(imageryKey(target));
    expect(resolvedImagerySource(target, resident)).toEqual(parent);
    for (const sibling of siblingGroup(target)) {
      resident.add(imageryKey(sibling));
    }
    expect(resolvedImagerySource(target, resident)).toEqual(target);
  });

  it("loads a coarse-to-fine photographic ancestor ladder", () => {
    const window = imageryWindowForContact(45, 9, 14, undefined, 4);
    const plan = imageryPlanForWindow(window);
    const requestedZooms = [
      ...new Set(plan.tasks.map((task) => task.address.z)),
    ];
    expect(requestedZooms).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(plan.tasks[0]?.kind).toBe("parent");
    expect(plan.tasks.at(-1)?.kind).toBe("exact");
  });

  it("holds precise pages behind the intermediate zoom ceiling", () => {
    const target = { z: IMAGERY_INTERMEDIATE_MAX_ZOOM + 1, x: 2_100, y: 1_400 };
    const parent = ancestorAtZoom(
      target,
      IMAGERY_INTERMEDIATE_MAX_ZOOM,
    );
    const resident = new Set([imageryKey(parent)]);
    for (const sibling of siblingGroup(target)) {
      resident.add(imageryKey(sibling));
    }
    expect(
      resolvedImagerySource(
        target,
        resident,
        0,
        IMAGERY_INTERMEDIATE_MAX_ZOOM,
      ),
    ).toEqual(parent);
    expect(resolvedImagerySource(target, resident)).toEqual(target);
  });

  it("encodes the physical layer and ancestor sub-rectangle", () => {
    const target = { z: 10, x: 731, y: 512 };
    const source = ancestorAtZoom(target, 8);
    const encoded = encodePageEntry(target, source, 17);
    expect(decodePageEntry(encoded)).toEqual({
      layer: 17,
      scale: 4,
      offsetX: 3,
      offsetY: 0,
    });
  });
});
