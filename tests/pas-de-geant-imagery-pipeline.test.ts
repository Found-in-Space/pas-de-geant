import { describe, expect, it } from "vitest";
import {
  ancestorAtZoom,
  selectImageryZoom,
} from "../apps/pas-de-geant/src/imagery-core.js";
import {
  ImageryWorkerClient,
  ScheduledImageryProvider,
  imageryLayerUploadPlan,
  imageryMigrationReady,
  type ImageryWorkerPort,
} from "../apps/pas-de-geant/src/imagery.js";
import {
  generateImageryMipChain,
  imageryMipDimensions,
} from "../apps/pas-de-geant/src/imagery-mip-chain.js";
import type {
  ImageryDecoderCommand,
  ImageryDecoderMessage,
} from "../apps/pas-de-geant/src/imagery-decoder-protocol.js";
import {
  BLUE_MARBLE_IMAGERY_KEY,
  buildDesiredImageryTree,
  encodeImageryTree,
  imageryTreeImageAtGlobalUv,
  imageryTreeNodeCount,
  imageryTreeSourceKeys,
  reconcileImageryTree,
  type DesiredImageryTree,
  type ImageryImageNode,
  type ImageryTreeNode,
} from "../apps/pas-de-geant/src/imagery-tree.js";
import { ImageryRequestError, type ImageryProvider } from "../apps/pas-de-geant/src/imagery-provider.js";
import { terrainTargetForView } from "../apps/pas-de-geant/src/terrain-surface.js";
import { TileTransitionScheduler } from "../apps/pas-de-geant/src/tile-transition-scheduler.js";
import type { TileIdentity } from "../apps/pas-de-geant/src/tile-transition-planner.js";

function tileKey(tile: TileIdentity): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

function parseTileKey(key: string): TileIdentity {
  const [z, x, y] = key.split("/").map(Number);
  return { z: z!, x: x!, y: y! };
}

function reconcileForTest(
  committed: ImageryTreeNode,
  desired: DesiredImageryTree,
  resident: ReadonlySet<string>,
): ImageryTreeNode {
  const nodes = new Map<string, ImageryImageNode>();
  return reconcileImageryTree(committed, desired, {
    isResident: (image) => resident.has(image),
    sourceZoom: (image) => parseTileKey(image).z,
    imageNode: (image) => {
      let node = nodes.get(image);
      if (!node) {
        node = Object.freeze({ image });
        nodes.set(image, node);
      }
      return node;
    },
  });
}

describe("independent photographic imagery pipeline", () => {
  it("builds a complete padded mip chain with averaged pixels through 1 x 1", () => {
    const base = new Uint8Array([
      0, 10, 20, 255, 20, 30, 40, 255, 40, 50, 60, 255, 60, 70, 80, 255,
    ]);
    const chain = generateImageryMipChain(base, 2, 2);

    expect(imageryMipDimensions(2, 2)).toEqual([
      { width: 2, height: 2 },
      { width: 1, height: 1 },
    ]);
    expect([...chain[1]!.pixels]).toEqual([30, 40, 50, 255]);

    const odd = generateImageryMipChain(
      new Uint8Array([
        0, 0, 0, 255, 0, 0, 0, 255, 90, 0, 0, 255,
      ]),
      3,
      1,
    );
    expect([...odd[1]!.pixels]).toEqual([30, 0, 0, 255]);
  });

  it("plans every mip upload and refuses to publish an incomplete layer", () => {
    const chain = generateImageryMipChain(new Uint8Array(4 * 4 * 4), 4, 4);
    const plan = imageryLayerUploadPlan(7, 4, chain);

    expect(
      plan?.map(({ slot, destinationMip, width, height }) => ({
        slot,
        destinationMip,
        width,
        height,
      })),
    ).toEqual([
      { slot: 7, destinationMip: 0, width: 4, height: 4 },
      { slot: 7, destinationMip: 1, width: 2, height: 2 },
      { slot: 7, destinationMip: 2, width: 1, height: 1 },
    ]);
    expect(imageryLayerUploadPlan(7, 4, chain.slice(0, -1))).toBeUndefined();
  });

  it("coalesces worker remips and ignores a stale stitched-base revision", () => {
    class FakeWorker implements ImageryWorkerPort {
      readonly commands: ImageryDecoderCommand[] = [];
      onmessage:
        | ((event: MessageEvent<ImageryDecoderMessage>) => void)
        | null = null;
      postMessage(message: ImageryDecoderCommand): void {
        this.commands.push(message);
      }
      terminate(): void {}
      emit(message: ImageryDecoderMessage): void {
        this.onmessage?.(
          { data: message } as MessageEvent<ImageryDecoderMessage>,
        );
      }
    }
    const worker = new FakeWorker();
    const client = new ImageryWorkerClient(worker);
    const completed: number[] = [];
    const complete = (revision: number): void => {
      completed.push(revision);
    };
    const fail = (): void => {};
    client.requestMip("4/2/3", 1, new Uint8Array(16), 2, 2, complete, fail);
    client.requestMip(
      "4/2/3",
      2,
      new Uint8Array(16).fill(9),
      2,
      2,
      complete,
      fail,
    );

    expect(worker.commands).toHaveLength(1);
    const first = worker.commands[0] as Extract<
      ImageryDecoderCommand,
      { kind: "mip" }
    >;
    worker.emit({
      kind: "mipped",
      requestId: first.requestId,
      key: first.key,
      revision: first.revision,
      levels: [{ width: 1, height: 1, pixels: new Uint8Array(4).buffer }],
    });

    expect(completed).toEqual([]);
    expect(worker.commands).toHaveLength(2);
    const second = worker.commands[1] as Extract<
      ImageryDecoderCommand,
      { kind: "mip" }
    >;
    expect(second.revision).toBe(2);
    worker.emit({
      kind: "mipped",
      requestId: second.requestId,
      key: second.key,
      revision: second.revision,
      levels: [{ width: 1, height: 1, pixels: new Uint8Array(4).buffer }],
    });
    expect(completed).toEqual([2]);
    client.dispose();
  });

  it("keeps a staged pool hidden until every retained and desired chain is complete", () => {
    const demand = new Set(["active-west", "active-east", "replacement"]);
    const uploads = new Map([
      ["active-west", 3],
      ["active-east", 2],
    ]);

    expect(imageryMigrationReady(demand, uploads)).toBe(false);
    uploads.set("replacement", 1);
    expect(imageryMigrationReady(demand, uploads)).toBe(true);
  });

  it("traverses a mixed global cut by normalized Mercator UV, including the antimeridian", () => {
    const cut: TileIdentity[] = [
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
      { z: 2, x: 0, y: 0 },
      { z: 2, x: 1, y: 0 },
      { z: 2, x: 0, y: 1 },
      { z: 2, x: 1, y: 1 },
    ];
    const desired = buildDesiredImageryTree(cut, (tile) => ({
      image: `${tile.z}/${tile.x}/${tile.y}`,
      fallbackFromNotFound: false,
    }));
    const nodes = new Map<string, ImageryImageNode>();
    const root = reconcileImageryTree(
      { image: BLUE_MARBLE_IMAGERY_KEY },
      desired,
      {
        isResident: () => true,
        sourceZoom: (image) => Number(image.split("/")[0]),
        imageNode: (image) => {
          let node = nodes.get(image);
          if (!node) {
            node = Object.freeze({ image });
            nodes.set(image, node);
          }
          return node;
        },
      },
    );

    expect(imageryTreeImageAtGlobalUv(root, 0.125, 0.125)).toBe("2/0/0");
    expect(imageryTreeImageAtGlobalUv(root, 0.375, 0.375)).toBe("2/1/1");
    expect(imageryTreeImageAtGlobalUv(root, 0.75, 0.25)).toBe("1/1/0");
    expect(imageryTreeImageAtGlobalUv(root, 0.999999, 0.25)).toBe("1/1/0");
    expect(imageryTreeImageAtGlobalUv(root, -0.000001, 0.25)).toBe("1/1/0");
    expect(imageryTreeImageAtGlobalUv(root, 1.000001, 0.125)).toBe("2/0/0");
  });

  it("selects imagery finer than the terrain mesh", () => {
    const view = {
      latitudeDegrees: 46,
      longitudeDegrees: 9,
      displayRadiusM: 1_000,
      radialMultiplier: 1,
      observerHeightWorldM: 1.65,
      focalLengthPixels: 250,
      footprint: [],
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

  it("keeps tree depth independent from a provider-capped source zoom", () => {
    const cut = Array.from({ length: 16 }, (_, index) => ({
      z: 2,
      x: index % 4,
      y: Math.floor(index / 4),
    }));
    const desired = buildDesiredImageryTree(cut, (tile) => ({
      image: tileKey(ancestorAtZoom(tile, 1)),
      fallbackFromNotFound: false,
    }));
    const resident = new Set(cut.map((tile) => tileKey(ancestorAtZoom(tile, 1))));
    const root = reconcileForTest(
      { image: BLUE_MARBLE_IMAGERY_KEY },
      desired,
      resident,
    );
    const layers = new Map([...resident].map((key, index) => [key, index]));
    const encoded = encodeImageryTree(root, 9, (image) => ({
      poolGeneration: 9,
      layer: layers.get(image)!,
      revision: 1,
      sourceTile: parseTileKey(image),
    }));

    expect(encoded?.maximumDepth).toBe(2);
    expect(encoded?.imageCount).toBe(4);
    expect(encoded && [...encoded.imageData].filter((_, i) => i % 4 === 1))
      .toEqual([1, 1, 1, 1]);
  });

  it("publishes parent-to-children refinement only after all four children are ready", () => {
    const parent = Object.freeze({ image: "10/510/340" });
    const childTiles: TileIdentity[] = [
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ];
    const desired = buildDesiredImageryTree(childTiles, (tile) => ({
      image: `11/${tile.x}/${tile.y}`,
      fallbackFromNotFound: false,
    }));
    const resident = new Set(["11/0/0", "11/1/0", "11/0/1"]);

    expect(reconcileForTest(parent, desired, resident)).toBe(parent);
    resident.add("11/1/1");
    const refined = reconcileForTest(parent, desired, resident);
    expect("children" in refined).toBe(true);
    if (!("children" in refined)) throw new Error("Expected refinement.");
    expect(refined.children.map((child) => "image" in child && child.image))
      .toEqual(["11/0/0", "11/1/0", "11/0/1", "11/1/1"]);
  });

  it("inherits the active parent for a 404 child without blocking its siblings", () => {
    const parent = Object.freeze({ image: "10/510/340" });
    const childTiles: TileIdentity[] = [
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ];
    const desired = buildDesiredImageryTree(childTiles, (tile) => ({
      image: tile.x === 1 && tile.y === 0
        ? BLUE_MARBLE_IMAGERY_KEY
        : `11/${tile.x}/${tile.y}`,
      fallbackFromNotFound: tile.x === 1 && tile.y === 0,
    }));
    const resident = new Set(["11/0/0", "11/0/1"]);

    expect(reconcileForTest(parent, desired, resident)).toBe(parent);
    resident.add("11/1/1");
    const refined = reconcileForTest(parent, desired, resident);
    if (!("children" in refined)) throw new Error("Expected refinement.");
    expect(refined.children[1]).toBe(parent);
    expect(refined.children[0]).not.toBe(parent);
    expect(refined.children[2]).not.toBe(parent);
    expect(refined.children[3]).not.toBe(parent);
  });

  it("coarsens atomically but refuses a 404 fallback that would lower active detail", () => {
    const fine: ImageryTreeNode = Object.freeze({
      children: Object.freeze([
        Object.freeze({ image: "11/0/0" }),
        Object.freeze({ image: "11/1/0" }),
        Object.freeze({ image: "11/0/1" }),
        Object.freeze({ image: "11/1/1" }),
      ] as const),
    });
    const resident = new Set(["10/0/0", "9/0/0"]);

    const normal = reconcileForTest(
      fine,
      { image: "10/0/0", fallbackFromNotFound: false },
      resident,
    );
    expect(normal).toEqual({ image: "10/0/0" });
    const fallback = reconcileForTest(
      fine,
      { image: "9/0/0", fallbackFromNotFound: true },
      resident,
    );
    expect(fallback).toBe(fine);
  });

  it("evicts committed photography when Blue Marble is an intentional residency fallback", () => {
    const committed = Object.freeze({ image: "12/1200/1500" });
    const transient = reconcileForTest(
      committed,
      { image: BLUE_MARBLE_IMAGERY_KEY, fallbackFromNotFound: true },
      new Set(),
    );
    expect(transient).toBe(committed);

    const evicted = reconcileForTest(
      committed,
      {
        image: BLUE_MARBLE_IMAGERY_KEY,
        fallbackFromNotFound: true,
        evictCommitted: true,
      },
      new Set(),
    );
    expect(imageryTreeSourceKeys(evicted)).toEqual(new Set());
  });

  it("path-copies only the refined branch and retains unchanged subtree identity", () => {
    const committedChildren = [
      Object.freeze({ image: "10/0/0" }),
      Object.freeze({ image: "10/1/0" }),
      Object.freeze({ image: "10/0/1" }),
      Object.freeze({ image: "10/1/1" }),
    ] as const;
    const committed: ImageryTreeNode = Object.freeze({
      children: Object.freeze(committedChildren),
    });
    const cut: TileIdentity[] = [
      { z: 2, x: 0, y: 0 },
      { z: 2, x: 1, y: 0 },
      { z: 2, x: 0, y: 1 },
      { z: 2, x: 1, y: 1 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ];
    const desired = buildDesiredImageryTree(cut, (tile) => ({
      image: tile.z === 1
        ? `10/${tile.x}/${tile.y}`
        : `11/${tile.x}/${tile.y}`,
      fallbackFromNotFound: false,
    }));
    const resident = new Set([
      "10/1/0",
      "10/0/1",
      "10/1/1",
      "11/0/0",
      "11/1/0",
      "11/0/1",
      "11/1/1",
    ]);
    const refined = reconcileForTest(committed, desired, resident);

    if (!("children" in refined)) throw new Error("Expected global branch.");
    expect(refined).not.toBe(committed);
    expect(refined.children[0]).not.toBe(committedChildren[0]);
    expect(refined.children[1]).toBe(committedChildren[1]);
    expect(refined.children[2]).toBe(committedChildren[2]);
    expect(refined.children[3]).toBe(committedChildren[3]);
  });

  it("encodes contiguous NW/NE/SW/SE children and generation-qualified images", () => {
    const root: ImageryTreeNode = Object.freeze({
      children: Object.freeze([
        Object.freeze({ image: "4/0/0" }),
        Object.freeze({ image: "4/1/0" }),
        Object.freeze({ image: "4/0/1" }),
        Object.freeze({ image: "4/1/1" }),
      ] as const),
    });
    const encoded = encodeImageryTree(root, 17, (image) => {
      const sourceTile = parseTileKey(image);
      return {
        poolGeneration: 17,
        layer: sourceTile.y * 2 + sourceTile.x,
        revision: 3,
        sourceTile,
      };
    });

    expect(imageryTreeNodeCount(root)).toBe(5);
    expect(encoded?.nodeCount).toBe(5);
    expect([...encoded!.nodeData]).toEqual([
      1, 0,
      0, 1,
      0, 2,
      0, 3,
      0, 4,
    ]);
    expect([...encoded!.imageData]).toEqual([
      0, 4, 0, 0,
      1, 4, 1, 0,
      2, 4, 0, 1,
      3, 4, 1, 1,
    ]);
    expect(encodeImageryTree(root, 18, (image) => ({
      poolGeneration: 17,
      layer: 0,
      revision: 3,
      sourceTile: parseTileKey(image),
    }))).toBeUndefined();
  });

  it("rejects malformed cuts instead of encoding holes in global coverage", () => {
    const leaf = (tile: TileIdentity) => ({
      image: tileKey(tile),
      fallbackFromNotFound: false,
    });
    expect(() => buildDesiredImageryTree([
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
    ], leaf)).toThrow(/complete globe/);
    expect(() => buildDesiredImageryTree([
      { z: 0, x: 0, y: 0 },
      { z: 1, x: 0, y: 0 },
    ], leaf)).toThrow(/ancestor and descendant/);
  });

  it("derives a staged pool solely from its immutable candidate tree", () => {
    const active: ImageryTreeNode = Object.freeze({
      children: Object.freeze([
        { image: "8/0/0" },
        { image: "8/1/0" },
        { image: "8/0/1" },
        { image: "8/1/1" },
      ] as const),
    });
    const candidate: ImageryTreeNode = Object.freeze({
      children: Object.freeze([
        { image: "9/0/0" },
        { image: "9/1/0" },
        { image: "9/0/1" },
        { image: "9/1/1" },
      ] as const),
    });
    const demand = imageryTreeSourceKeys(candidate);

    expect(demand).toEqual(new Set([
      "9/0/0",
      "9/1/0",
      "9/0/1",
      "9/1/1",
    ]));
    expect([...imageryTreeSourceKeys(active)].some((key) => demand.has(key)))
      .toBe(false);
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

  it("marks a successful ancestor response as a 404 fallback", async () => {
    const provider: ImageryProvider = {
      id: "ancestor-fallback-fixture",
      attribution: "fixture",
      tileSize: 512,
      minZoom: 1,
      maxZoom: 2,
      async load(tile) {
        if (tile.z === 2) {
          throw new ImageryRequestError("missing", "not-found", 404);
        }
        return new Blob([tileKey(tile)], { type: "image/png" });
      },
    };
    const scheduled = new ScheduledImageryProvider(
      provider,
      async () => new Uint8Array([1, 2, 3, 4]),
    );
    const resource = await new Promise<{
      sourceTile?: TileIdentity;
      fallbackFromNotFound?: boolean;
    }>((resolve, reject) => {
      scheduled.request({ z: 2, x: 3, y: 2 }, (result) => {
        if (result.phase === "response") resolve(result.resource);
        if (result.phase === "failure") reject(new Error(result.reason));
      });
    });

    expect(resource.sourceTile).toEqual({ z: 1, x: 1, y: 1 });
    expect(resource.fallbackFromNotFound).toBe(true);
    scheduled.dispose();
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
