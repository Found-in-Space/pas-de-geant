import { describe, expect, it } from "vitest";
import {
  ancestorAtZoom,
  resolvePageEntry,
  selectImageryZoom,
} from "../apps/pas-de-geant/src/imagery-core.js";
import {
  ScheduledImageryProvider,
  imageryMappingTarget,
  imageryResidencyKeys,
  preservingImagerySource,
} from "../apps/pas-de-geant/src/imagery.js";
import { ImageryRequestError, type ImageryProvider } from "../apps/pas-de-geant/src/imagery-provider.js";
import { terrainTargetForView } from "../apps/pas-de-geant/src/terrain-surface.js";
import { TileOnionLayoutSource } from "../apps/pas-de-geant/src/tile-layout-source.js";
import { TileTransitionScheduler } from "../apps/pas-de-geant/src/tile-transition-scheduler.js";
import type { TileIdentity } from "../apps/pas-de-geant/src/tile-transition-planner.js";

describe("independent photographic imagery pipeline", () => {
  it("selects imagery finer than the terrain mesh", () => {
    const view = {
      latitudeDegrees: 46,
      longitudeDegrees: 9,
      displayRadiusM: 1_000,
      radialMultiplier: 1,
      observerHeightWorldM: 1.65,
      focalLengthPixels: 250,
    };
    const terrain = terrainTargetForView(view, 512);
    const imageryZoom = selectImageryZoom({
      ...view,
      minZoom: 0,
      maxZoom: 22,
      tilePixels: 512,
    });

    expect(imageryZoom).toBeGreaterThan(terrain.z);
  });

  it("selects imagery z from native provider texel density", () => {
    const common = {
      displayRadiusM: 1_000,
      latitudeDegrees: 46,
      longitudeDegrees: 9,
      minZoom: 0,
      maxZoom: 22,
    };
    const zoom256 = selectImageryZoom({ ...common, tilePixels: 256 });
    const zoom512 = selectImageryZoom({ ...common, tilePixels: 512 });
    const zoom1024 = selectImageryZoom({ ...common, tilePixels: 1_024 });

    expect(zoom256).toBe(zoom512 + 1);
    expect(zoom1024).toBe(zoom512 - 1);
  });

  it("maps a draw page above the provider cap into its source ancestor", () => {
    const target = { z: 20, x: 312_345, y: 401_234 };
    const source = ancestorAtZoom(target, 12);
    const mapping = resolvePageEntry(target, source, 7);

    expect(source.z).toBe(12);
    expect(mapping.scale).toBe(256);
    expect(mapping.offsetX).toBeGreaterThanOrEqual(0);
    expect(mapping.offsetX).toBeLessThan(mapping.scale);
    expect(mapping.offsetY).toBeGreaterThanOrEqual(0);
    expect(mapping.offsetY).toBeLessThan(mapping.scale);
  });

  it("keeps a fine page grid while a coarsening transition still retains fine leaves", () => {
    const mapping = imageryMappingTarget(
      { z: 8, x: 100, y: 90 },
      [
        { z: 8, x: 100, y: 90 },
        { z: 10, x: 405, y: 361 },
      ],
    );

    expect(mapping).toEqual({ z: 10, x: 402, y: 362 });
  });

  it("retains photographic coverage during pan and refinement until replacement is resident", () => {
    const active = { z: 12, x: 2_100, y: 1_430 };
    const samePage = { ...active };
    const refinedPage = { z: 14, x: active.x * 4 + 2, y: active.y * 4 + 1 };
    const replacement = { z: 14, x: refinedPage.x, y: refinedPage.y };

    expect(preservingImagerySource(samePage, undefined, [active])).toEqual(active);
    expect(preservingImagerySource(refinedPage, undefined, [active])).toEqual(active);
    expect(
      preservingImagerySource(refinedPage, replacement, [active]),
    ).toEqual(replacement);
  });

  it("keeps same-zoom photographic coverage while a recentered replacement is pending", () => {
    const active = { z: 10, x: 511, y: 340 };
    const stillCoveredPage = { z: 10, x: 511, y: 340 };
    const newlyExposedPage = { z: 10, x: 512, y: 340 };

    expect(
      preservingImagerySource(stillCoveredPage, undefined, [active]),
    ).toEqual(active);
    expect(
      preservingImagerySource(newlyExposedPage, undefined, [active]),
    ).toBeUndefined();
  });

  it("refines ready children while retaining their parent under pending and 404 children", () => {
    const parent = { z: 10, x: 510, y: 340 };
    const children = [
      { z: 11, x: 1_020, y: 680 },
      { z: 11, x: 1_021, y: 680 },
      { z: 11, x: 1_020, y: 681 },
      { z: 11, x: 1_021, y: 681 },
    ];

    expect(preservingImagerySource(children[0]!, children[0], [parent])).toEqual(
      children[0],
    );
    expect(preservingImagerySource(children[1]!, undefined, [parent])).toEqual(
      parent,
    );
    expect(preservingImagerySource(children[2]!, undefined, [parent])).toEqual(
      parent,
    );
    expect(preservingImagerySource(children[3]!, children[3], [parent])).toEqual(
      children[3],
    );
  });

  it("selects every child after a complete parent-to-children replacement", () => {
    const parent = { z: 10, x: 510, y: 340 };
    const children = [
      { z: 11, x: 1_020, y: 680 },
      { z: 11, x: 1_021, y: 680 },
      { z: 11, x: 1_020, y: 681 },
      { z: 11, x: 1_021, y: 681 },
    ];

    expect(
      children.map((child) =>
        preservingImagerySource(child, child, [parent]),
      ),
    ).toEqual(children);
  });

  it("does not downgrade an active source when a 404 resolves to a coarser ancestor", () => {
    const page = { z: 11, x: 1_021, y: 681 };
    const active = { z: 10, x: 510, y: 340 };
    const desiredFallback = { z: 9, x: 255, y: 170 };

    expect(
      preservingImagerySource(page, desiredFallback, [active]),
    ).toEqual(active);
  });

  it("keeps fine children through coarsening until the resident parent can replace them", () => {
    const finePage = { z: 11, x: 1_021, y: 681 };
    const activeChild = { ...finePage };
    const coarseParent = { z: 10, x: 510, y: 340 };

    expect(
      preservingImagerySource(finePage, undefined, [activeChild]),
    ).toEqual(activeChild);
    expect(
      preservingImagerySource(finePage, coarseParent, [activeChild]),
    ).toEqual(activeChild);
    expect(
      preservingImagerySource(coarseParent, coarseParent, [activeChild]),
    ).toEqual(coarseParent);
  });

  it("cannot let an abandoned partial transition clear coverage from the last active cut", () => {
    const pageFromA = { z: 12, x: 2_100, y: 1_430 };
    const activeFromA = { ...pageFromA };
    const partialB = { z: 12, x: 2_101, y: 1_430 };

    expect(
      preservingImagerySource(pageFromA, partialB, [activeFromA]),
    ).toEqual(activeFromA);
    expect(
      preservingImagerySource(pageFromA, undefined, [activeFromA]),
    ).toEqual(activeFromA);
  });

  it("preserves normalized photographic pages on both sides of the antimeridian", () => {
    const westOfSeam = { z: 4, x: 15, y: 7 };
    const eastOfSeam = { z: 4, x: 0, y: 7 };
    const westSource = { z: 3, x: 7, y: 3 };
    const eastSource = { z: 3, x: 0, y: 3 };

    expect(
      preservingImagerySource(westOfSeam, undefined, [westSource, eastSource]),
    ).toEqual(westSource);
    expect(
      preservingImagerySource(eastOfSeam, undefined, [westSource, eastSource]),
    ).toEqual(eastSource);
    expect(
      imageryMappingTarget({ z: 3, x: 0, y: 3 }, [eastOfSeam]),
    ).toEqual({ z: 4, x: 1, y: 7 });
  });

  it("does not pretend finer active coverage fits a coarse cell", () => {
    const coarsePage = { z: 10, x: 525, y: 357 };
    const fineActive = { z: 12, x: 2_100, y: 1_430 };

    expect(
      preservingImagerySource(coarsePage, undefined, [fineActive]),
    ).toBeUndefined();
  });

  it("derives residency exactly from active and planner-desired source demand", () => {
    const layout = new TileOnionLayoutSource();
    const active = layout.calculate({ z: 8, x: 120, y: 90 });
    const desired = layout.calculate({ z: 10, x: 482, y: 361 });
    const activeKeys = active.map((tile) => `${tile.z}/${tile.x}/${tile.y}`);
    const desiredKeys = desired.map((tile) => `${tile.z}/${tile.x}/${tile.y}`);
    const residency = imageryResidencyKeys(activeKeys, desiredKeys);

    expect(residency).toEqual(new Set([...activeKeys, ...desiredKeys]));
    expect([...activeKeys, ...desiredKeys].every((key) => residency.has(key))).toBe(true);
  });

  it("commits an imagery sibling group when one cell is a 404", async () => {
    const provider: ImageryProvider = {
      id: "fixture",
      attribution: "fixture",
      tileSize: 512,
      minZoom: 1,
      maxZoom: 1,
      async load(tile) {
        if (tile.x === 1 && tile.y === 0) {
          throw new ImageryRequestError("missing", "not-found", 404);
        }
        return new Blob([String(tile.x), String(tile.y)], { type: "image/png" });
      },
    };
    const parent = [{ z: 0, x: 0, y: 0 }];
    const children: TileIdentity[] = [
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ];
    const source = new ScheduledImageryProvider(provider);
    const scheduler = new TileTransitionScheduler(
      "parent" as "parent" | "children",
      {
        calculate(target: "parent" | "children") {
          return target === "parent" ? parent : children;
        },
      },
      source,
    );

    scheduler.updateTarget("children");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scheduler.snapshot.committedCut).toEqual(children);
    expect(scheduler.committedResource({ z: 1, x: 1, y: 0 })).toEqual({
      kind: "imagery",
      tile: { z: 1, x: 1, y: 0 },
    });
    source.dispose();
  });

  it("coalesces concurrent overzoomed consumers of one source ancestor", async () => {
    let loads = 0;
    const provider: ImageryProvider = {
      id: "coalescing-fixture",
      attribution: "fixture",
      tileSize: 512,
      minZoom: 0,
      maxZoom: 2,
      async load() {
        loads += 1;
        await Promise.resolve();
        return new Blob(["shared"], { type: "image/png" });
      },
    };
    const scheduled = new ScheduledImageryProvider(provider);
    const resources = await Promise.all(
      [
        { z: 4, x: 0, y: 0 },
        { z: 4, x: 1, y: 0 },
        { z: 4, x: 0, y: 1 },
        { z: 4, x: 1, y: 1 },
      ].map(
        (tile) =>
          new Promise<{ sourceTile?: TileIdentity }>((resolve, reject) => {
            scheduled.request(tile, (result) => {
              if (result.phase === "response") resolve(result.resource);
              if (result.phase === "failure") reject(new Error(result.reason));
            });
          }),
      ),
    );

    expect(loads).toBe(1);
    expect(resources.every(({ sourceTile }) => sourceTile?.z === 2)).toBe(true);
    await new Promise<void>((resolve, reject) => {
      scheduled.request({ z: 4, x: 0, y: 0 }, (result) => {
        if (result.phase === "response") resolve();
        if (result.phase === "failure") reject(new Error(result.reason));
      });
    });
    expect(loads).toBe(2);
    scheduled.dispose();
  });

  it("drops zero-consumer queued jobs and aborts active shared work only after its last consumer", async () => {
    const started: AbortSignal[] = [];
    const provider: ImageryProvider = {
      id: "cancellation-fixture",
      attribution: "fixture",
      tileSize: 512,
      minZoom: 3,
      maxZoom: 3,
      load: async (_tile, signal) => {
        started.push(signal);
        return await new Promise<Blob>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const scheduled = new ScheduledImageryProvider(provider);
    const first = scheduled.request({ z: 4, x: 0, y: 0 }, () => {});
    const shared = scheduled.request({ z: 4, x: 1, y: 1 }, () => {});
    const fillers = Array.from({ length: 5 }, (_, index) =>
      scheduled.request({ z: 3, x: index + 1, y: 2 }, () => {}),
    );
    const queued = scheduled.request({ z: 3, x: 7, y: 7 }, () => {});

    expect(started).toHaveLength(6);
    first.cancel();
    expect(started[0]!.aborted).toBe(false);
    shared.cancel();
    expect(started[0]!.aborted).toBe(true);
    queued.cancel();
    await Promise.resolve();
    expect(started).toHaveLength(6);
    for (const handle of fillers) handle.cancel();
    scheduled.dispose();
  });

  it("keeps malformed decode failures retryable before imagery topology commits", async () => {
    let decodeAttempts = 0;
    const provider: ImageryProvider = {
      id: "decode-retry-fixture",
      attribution: "fixture",
      tileSize: 512,
      minZoom: 1,
      maxZoom: 1,
      async load() {
        return new Blob(["image"], { type: "image/png" });
      },
    };
    const scheduled = new ScheduledImageryProvider(provider, async () => {
      decodeAttempts += 1;
      if (decodeAttempts === 1) {
        throw new ImageryRequestError("malformed", "malformed");
      }
      return new Uint8Array([1, 2, 3, 4]);
    });
    const parent = [{ z: 0, x: 0, y: 0 }];
    const child = [
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ];
    const scheduler = new TileTransitionScheduler(
      "parent" as "parent" | "child",
      {
        calculate(target: "parent" | "child") {
          return target === "parent" ? parent : child;
        },
      },
      scheduled,
    );

    scheduler.updateTarget("child");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.snapshot.committedCut).toEqual(parent);
    expect(scheduler.snapshot.requirements[0]?.state).toBe("failed");

    scheduler.retryFailed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.snapshot.committedCut).toEqual(child);
    expect(decodeAttempts).toBe(5);
    scheduled.dispose();
  });
});
