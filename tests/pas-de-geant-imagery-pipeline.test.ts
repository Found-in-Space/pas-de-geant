import { describe, expect, it, vi } from "vitest";
import {
  ancestorAtZoom,
  selectImageryZoom,
} from "../apps/pas-de-geant/src/imagery-core.js";
import {
  ImageryMovementAdmission,
  ImageryWorkerClient,
  ScheduledImageryProvider,
  imageryDemandForAdmission,
  imageryLayerUploadPlan,
  imageryMigrationReady,
  imageryPoolGrowthCapacity,
  imageryTargetForView,
  planImageryMigrationUploadDemand,
  planImageryPoolMigration,
  planImageryPoolMigrationRetarget,
  type ImageryWorkerPort,
} from "../apps/pas-de-geant/src/imagery.js";
import {
  classifyHotAndForecastResidency,
} from "../apps/pas-de-geant/src/view-residency.js";
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
import {
  createTileDebugControls,
  tileTopologySelectionChanged,
  withTilePixelRatio,
} from "../apps/pas-de-geant/src/tile-debug-controls.js";
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
  it("keeps planner topology at the desired zoom throughout movement", () => {
    const radius = 1_000;
    const initial = {
      displayRadiusM: radius,
      latitudeDegrees: 0,
      longitudeDegrees: 0,
    };
    const admission = new ImageryMovementAdmission(initial);
    admission.update(initial, 13, 1_000, 0);
    const moved = {
      ...initial,
      longitudeDegrees: 100 / radius * 180 / Math.PI,
    };

    const forecast = admission.update(moved, 13, 1_000, 1_000);

    expect(forecast.predictedTravelTileSpans).toBeGreaterThan(1);
    expect(forecast.deferSpeculativeWarm).toBe(true);
    expect(forecast.topologyZoom).toBe(13);
    expect(imageryTargetForView(moved, forecast.topologyZoom).maxZoom).toBe(13);
  });

  it("keeps current-hot, predicted, resident, and in-flight warm demand", () => {
    const hot = { z: 3, x: 0, y: 0 };
    const predictedWarm = { z: 3, x: 1, y: 0 };
    const residentWarm = { z: 3, x: 2, y: 0 };
    const inFlightWarm = { z: 3, x: 3, y: 0 };
    const speculativeWarm = { z: 3, x: 4, y: 0 };
    const full = [
      hot,
      predictedWarm,
      residentWarm,
      inFlightWarm,
      speculativeWarm,
    ];

    expect(imageryDemandForAdmission(
      full,
      new Set([tileKey(hot)]),
      new Set([tileKey(predictedWarm)]),
      true,
      (tile) => [residentWarm, inFlightWarm].some((retained) =>
        tileKey(tile) === tileKey(retained)
      ),
    )).toEqual([hot, predictedWarm, residentWarm, inFlightWarm]);
  });

  it("admits the full warm working set below one predicted tile span", () => {
    const stationary = {
      displayRadiusM: 1_000,
      latitudeDegrees: 0,
      longitudeDegrees: 0,
    };
    const admission = new ImageryMovementAdmission(stationary);
    const forecast = admission.update(stationary, 3, 1_000, 0);
    const full = [
      { z: 3, x: 0, y: 0 },
      { z: 3, x: 1, y: 0 },
      { z: 3, x: 2, y: 0 },
    ];

    expect(imageryDemandForAdmission(
      full,
      new Set(),
      new Set(),
      forecast.deferSpeculativeWarm,
      () => false,
    )).toBe(full);
    expect(forecast.predictedTravelTileSpans).toBeLessThan(1);
  });

  it("admits forward forecast tiles while leaving side and behind warm tiles speculative", () => {
    const cut = [
      { z: 4, x: 5, y: 8 },
      { z: 4, x: 8, y: 8 },
      { z: 4, x: 11, y: 8 },
      { z: 4, x: 8, y: 4 },
    ];
    const input = {
      underfoot: { latitudeDegrees: 0, longitudeDegrees: 0 },
      footprint: [] as const,
      displayRadiusM: 1_000,
      observerHeightWorldM: 0,
    };

    const classified = classifyHotAndForecastResidency(
      cut,
      input,
      { x: 3 / 16, y: 0 },
    );
    const demanded = imageryDemandForAdmission(
      cut,
      classified.hot,
      classified.forecast,
      true,
      () => false,
    );

    expect(demanded).toContainEqual({ z: 4, x: 8, y: 8 });
    expect(demanded).toContainEqual({ z: 4, x: 11, y: 8 });
    expect(demanded).not.toContainEqual({ z: 4, x: 5, y: 8 });
    expect(demanded).not.toContainEqual({ z: 4, x: 8, y: 4 });
  });

  it("wraps eastward velocity at the antimeridian and quantizes its forecast signature", () => {
    const radius = 1_000;
    const initial = {
      displayRadiusM: radius,
      latitudeDegrees: 0,
      longitudeDegrees: 179.9,
    };
    const admission = new ImageryMovementAdmission(initial);
    admission.update(initial, 12, 1_000, 0);
    const moved = { ...initial, longitudeDegrees: -179.9 };
    const forecast = admission.update(moved, 12, 1_000, 1_000);
    const velocityEastMps = forecast.velocityEastMps;
    const displacementX = forecast.displacement.x;
    const forecastSignature = forecast.signature;
    const jitteredSignature =
      admission.update(moved, 12, 1_001, 1_000).signature;
    const materiallyLaterSignature =
      admission.update(moved, 12, 2_000, 1_000).signature;

    expect(velocityEastMps).toBeGreaterThan(0);
    expect(displacementX).toBeGreaterThan(0);
    expect(jitteredSignature).toBe(forecastSignature);
    expect(materiallyLaterSignature).not.toBe(forecastSignature);

    const antimeridian = classifyHotAndForecastResidency(
      [
        { z: 4, x: 15, y: 8 },
        { z: 4, x: 1, y: 8 },
      ],
      {
        underfoot: { latitudeDegrees: 0, longitudeDegrees: 179.9 },
        footprint: [],
        displayRadiusM: radius,
        observerHeightWorldM: 0,
      },
      { x: 2 / 16, y: 0 },
    );
    expect(antimeridian.hot).toContain("4/15/8");
    expect(antimeridian.forecast).toContain("4/1/8");
  });

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

  it("reuses retained layers and stages only incoming or changed pages", () => {
    const plan = planImageryPoolMigration(
      new Map([
        ["retained", 5],
        ["changed", 6],
        ["outgoing", 7],
      ]),
      new Map([
        ["retained", 3],
        ["changed", 2],
        ["outgoing", 4],
      ]),
      ["retained", "changed", "incoming"],
      new Map([
        ["retained", 3],
        ["changed", 4],
        ["incoming", 1],
      ]),
    );

    // The existing valid page keeps its slot and upload revision, so it is
    // absent from the upload work. Changed and incoming pages need fresh
    // slots, keeping the currently visible mapping valid until publication.
    expect(plan.slots).toEqual(new Map([["retained", 5]]));
    expect(plan.uploadedRevisions).toEqual(new Map([["retained", 3]]));
    expect(plan.requiredAdditionalSlots).toBe(2);
    expect(imageryMigrationReady(
      ["retained", "changed", "incoming"],
      plan.uploadedRevisions,
    )).toBe(false);
    plan.uploadedRevisions.set("changed", 4);
    plan.uploadedRevisions.set("incoming", 1);
    expect(imageryMigrationReady(
      ["retained", "changed", "incoming"],
      plan.uploadedRevisions,
    )).toBe(true);
  });

  it("grows pool capacity only by unstaged demand and never shrinks", () => {
    // The active capacity remains the growth floor, with only the unstaged
    // demand added as slack in the separately prepared replacement pool.
    expect(imageryPoolGrowthCapacity(1, 5, 5)).toBe(6);

    // A later overlapping transition adds room for only its two incoming or
    // changed pages; a smaller fully retained cut keeps existing capacity.
    expect(imageryPoolGrowthCapacity(6, 5, 2)).toBe(8);
    expect(imageryPoolGrowthCapacity(8, 3, 0)).toBe(8);
  });

  it("reuses partial uploads across repeated migration supersedes without releasing visible slots", () => {
    const visible = new Map([
      ["retained", 0],
      ["visible-outgoing", 1],
    ]);
    const first = planImageryPoolMigrationRetarget(
      new Map([
        ["retained", 0],
        ["visible-outgoing", 1],
        ["staged", 2],
        ["obsolete", 3],
      ]),
      new Map([
        ["retained", 3],
        ["staged", 1],
      ]),
      visible,
      new Set(["retained", "staged", "incoming"]),
    );
    expect(first.releasedCandidateSlots).toEqual([3]);
    expect(first.releasedCandidateSlots).not.toContain(1);
    expect(first.missingKeys).toEqual(["incoming"]);
    first.slots.set("incoming", 3);
    first.uploadedRevisions.set("incoming", 1);

    const second = planImageryPoolMigrationRetarget(
      first.slots,
      first.uploadedRevisions,
      visible,
      new Set(["retained", "incoming", "next"]),
    );
    expect(second.slots).toEqual(new Map([
      ["retained", 0],
      ["incoming", 3],
    ]));
    expect(second.uploadedRevisions).toEqual(new Map([
      ["retained", 3],
      ["incoming", 1],
    ]));
    expect(second.releasedCandidateSlots).toEqual([2]);
  });

  it("queues the one unsatisfied migration page ahead of many reused uploads", () => {
    const reused = Array.from({ length: 256 }, (_, index) => `reused-${index}`);
    const demanded = [...reused, "missing"];
    const required = new Map(demanded.map((key) => [key, 4]));
    const uploaded = new Map(reused.map((key) => [key, 4]));

    expect(planImageryMigrationUploadDemand(
      demanded,
      uploaded,
      required,
    )).toEqual({
      pendingKeys: ["missing"],
      validReusedUploadCount: 256,
    });

    uploaded.set(reused[0]!, 3);
    expect(planImageryMigrationUploadDemand(
      demanded,
      uploaded,
      required,
    )).toEqual({
      pendingKeys: [reused[0], "missing"],
      validReusedUploadCount: 255,
    });
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

    expect(imageryZoom).toBeGreaterThan(terrain.maxZoom);
    expect(imageryTargetForView(view, imageryZoom)).toEqual({
      maxZoom: imageryZoom,
      latitudeDegrees: view.latitudeDegrees,
      longitudeDegrees: view.longitudeDegrees,
    });
    expect(terrain).toMatchObject({
      latitudeDegrees: view.latitudeDegrees,
      longitudeDegrees: view.longitudeDegrees,
    });
  });

  it("keeps actual polar coordinates while terrain and imagery select independent zooms", () => {
    const view = {
      latitudeDegrees: 89,
      longitudeDegrees: -138,
      displayRadiusM: 1_000,
      radialMultiplier: 1,
      observerHeightWorldM: 1.65,
      focalLengthPixels: 250,
      footprint: [],
    };
    const terrain = terrainTargetForView(view, 512);
    const imagery = imageryTargetForView(view, terrain.maxZoom + 3);

    expect(terrain).toMatchObject({
      latitudeDegrees: 89,
      longitudeDegrees: -138,
    });
    expect(imagery).toEqual({
      maxZoom: terrain.maxZoom + 3,
      latitudeDegrees: 89,
      longitudeDegrees: -138,
    });
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

  it("coarsens one topology zoom when the requested screen-pixel ratio doubles", () => {
    const common = {
      displayRadiusM: 1_000,
      latitudeDegrees: 46,
      longitudeDegrees: 9,
      minZoom: 0,
      maxZoom: 1,
      tilePixels: 512,
    };
    const dense = selectImageryZoom({
      ...common,
      targetScreenPixelsPerSourcePixel: 1,
    });
    const coarse = selectImageryZoom({
      ...common,
      targetScreenPixelsPerSourcePixel: 2,
    });

    expect(coarse).toBe(dense - 1);
    expect(dense).toBeGreaterThan(common.maxZoom);
    expect(selectImageryZoom({
      ...common,
      maxTopologyZoom: 7,
    })).toBe(7);
  });

  it("rebases texture hysteresis after a dynamic density change", () => {
    const common = {
      displayRadiusM: 3.2353562342649442,
      latitudeDegrees: 46,
      longitudeDegrees: 9,
      minZoom: 0,
      maxZoom: 22,
      tilePixels: 512,
    };
    const ratioOne = createTileDebugControls().textures;
    const ratioTwo = withTilePixelRatio(
      createTileDebugControls(),
      { target: "textures", screenPixelsPerSourcePixel: 2 },
    ).textures;
    const initialZoom = selectImageryZoom({
      ...common,
      targetScreenPixelsPerSourcePixel:
        ratioOne.screenPixelsPerSourcePixel,
    });

    expect(initialZoom).toBe(2);
    expect(selectImageryZoom({
      ...common,
      targetScreenPixelsPerSourcePixel:
        ratioTwo.screenPixelsPerSourcePixel,
      previousZoom: initialZoom,
    })).toBe(2);
    expect(tileTopologySelectionChanged(ratioOne, ratioTwo)).toBe(true);
    expect(selectImageryZoom({
      ...common,
      targetScreenPixelsPerSourcePixel:
        ratioTwo.screenPixelsPerSourcePixel,
      previousZoom: tileTopologySelectionChanged(ratioOne, ratioTwo)
        ? undefined
        : initialZoom,
    })).toBe(1);
  });

  it("applies terrain density and topology caps independently from elevation source zoom", () => {
    const view = {
      latitudeDegrees: 46,
      longitudeDegrees: 9,
      displayRadiusM: 1_000,
      radialMultiplier: 1,
      observerHeightWorldM: 1.65,
      focalLengthPixels: 250,
      footprint: [],
    };
    const dense = terrainTargetForView(view, 512, {
      targetScreenPixelsPerSourcePixel: 1,
    });
    const coarse = terrainTargetForView(view, 512, {
      targetScreenPixelsPerSourcePixel: 2,
    });

    expect(coarse.maxZoom).toBe(dense.maxZoom - 1);
    expect(terrainTargetForView(view, 512, {
      targetScreenPixelsPerSourcePixel: 1,
      maxTopologyZoom: 6,
    }).maxZoom).toBe(6);
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

  it("updates its bounded readiness estimate when source and decode complete", async () => {
    let nowMs = 0;
    let resolveLoad!: (blob: Blob) => void;
    const provider: ImageryProvider = {
      id: "readiness-fixture",
      attribution: "fixture",
      tileSize: 512,
      minZoom: 0,
      maxZoom: 0,
      load: async () => await new Promise<Blob>((resolve) => {
        resolveLoad = resolve;
      }),
    };
    const scheduled = new ScheduledImageryProvider(
      provider,
      async () => {
        nowMs = 500;
        return new Uint8Array([1, 2, 3, 4]);
      },
      () => nowMs,
    );
    const seededEstimate = scheduled.estimatedAssetReadyMs;
    const completed = new Promise<void>((resolve) => {
      scheduled.request({ z: 0, x: 0, y: 0 }, (result) => {
        if (result.phase === "response") resolve();
      });
    });

    resolveLoad(new Blob(["tile"], { type: "image/png" }));
    await completed;

    expect(scheduled.estimatedAssetReadyMs).toBeLessThan(seededEstimate);
    expect(scheduled.estimatedAssetReadyMs).toBeGreaterThan(500);
    scheduled.dispose();
  });

  it("marks a consumer joining an active shared source fetch as in-flight", async () => {
    let loads = 0;
    let resolveLoad!: (blob: Blob) => void;
    const provider: ImageryProvider = {
      id: "active-join-fixture",
      attribution: "fixture",
      tileSize: 512,
      minZoom: 0,
      maxZoom: 2,
      load: async () => {
        loads += 1;
        return await new Promise<Blob>((resolve) => {
          resolveLoad = resolve;
        });
      },
    };
    const scheduled = new ScheduledImageryProvider(
      provider,
      async () => new Uint8Array([1, 2, 3, 4]),
    );
    const firstPhases: string[] = [];
    const secondPhases: string[] = [];
    const firstComplete = new Promise<void>((resolve) => {
      scheduled.request({ z: 4, x: 0, y: 0 }, (result) => {
        firstPhases.push(result.phase);
        if (result.phase === "response") resolve();
      });
    });
    const secondComplete = new Promise<void>((resolve) => {
      scheduled.request({ z: 4, x: 1, y: 0 }, (result) => {
        secondPhases.push(result.phase);
        if (result.phase === "response") resolve();
      });
    });

    expect(loads).toBe(1);
    expect(firstPhases).toEqual(["in-flight"]);
    expect(secondPhases).toEqual([]);
    await Promise.resolve();
    expect(secondPhases).toEqual(["in-flight"]);

    resolveLoad(new Blob(["shared"], { type: "image/png" }));
    await Promise.all([firstComplete, secondComplete]);
    expect(firstPhases).toEqual(["in-flight", "response"]);
    expect(secondPhases).toEqual(["in-flight", "response"]);
    expect(scheduled.metrics).toMatchObject({
      requestTotal: 2,
      sourceLoadTotal: 1,
    });
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
    const cancelledQueued = scheduled.request(
      { z: 3, x: 6, y: 7 },
      () => {},
    );
    const nextQueued = scheduled.request({ z: 3, x: 7, y: 7 }, () => {});

    expect(started).toHaveLength(6);
    cancelledQueued.cancel();
    first.cancel();
    expect(started[0]!.aborted).toBe(false);
    shared.cancel();
    expect(started[0]!.aborted).toBe(true);
    expect(scheduled.metrics.sourceCancellationTotal).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toHaveLength(7);
    nextQueued.cancel();
    for (const handle of fillers) handle.cancel();
    scheduled.dispose();
  });

  it("ramps actual warm source starts while allowing hot work to preempt", async () => {
    const pending = new Map<string, (blob: Blob) => void>();
    const started: string[] = [];
    const provider: ImageryProvider = {
      id: "warm-ramp-fixture",
      attribution: "fixture",
      tileSize: 512,
      minZoom: 3,
      maxZoom: 3,
      load: async (tile) => {
        const key = tileKey(tile);
        started.push(key);
        return await new Promise<Blob>((resolve) => pending.set(key, resolve));
      },
    };
    const scheduled = new ScheduledImageryProvider(
      provider,
      async () => new Uint8Array([1, 2, 3, 4]),
    );
    const hot = { z: 3, x: 7, y: 0 };
    scheduled.updatePriority([hot]);
    scheduled.beginWarmRamp();
    for (let x = 0; x < 4; x += 1) {
      scheduled.request({ z: 3, x, y: 0 }, () => {});
    }
    expect(started).toEqual(["3/0/0"]);

    scheduled.request(hot, () => {});
    expect(started).toEqual(["3/0/0", "3/7/0"]);
    pending.get("3/0/0")!(new Blob(["warm"], { type: "image/png" }));
    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started.slice(2).sort()).toEqual(["3/1/0", "3/2/0"]);
    expect(scheduled.metrics).toMatchObject({
      warmRampActive: true,
      warmRampLimit: 2,
      sourceLoadTotal: 4,
    });

    for (const key of started.slice(1)) {
      pending.get(key)?.(new Blob(["image"], { type: "image/png" }));
    }
    scheduled.dispose();
  });

  it("does not start planned imagery jobs after a systemic failure", async () => {
    const pending: Array<{
      resolve(blob: Blob): void;
      reject(error: unknown): void;
    }> = [];
    const failures: number[] = [];
    const provider: ImageryProvider = {
      id: "systemic-failure-fixture",
      attribution: "fixture",
      tileSize: 512,
      minZoom: 3,
      maxZoom: 3,
      load: async () =>
        await new Promise<Blob>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    };
    const scheduled = new ScheduledImageryProvider(
      provider,
      async () => new Uint8Array([1, 2, 3, 4]),
    );
    for (let index = 0; index < 8; index += 1) {
      scheduled.request({ z: 3, x: index, y: 0 }, (result) => {
        if (result.phase === "failure") failures.push(index);
      });
    }

    expect(pending).toHaveLength(6);
    pending[0]!.reject(new TypeError("Failed to fetch"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pending).toHaveLength(6);
    expect(scheduled.metrics).toMatchObject({ queued: 0, sourceLoadTotal: 6 });
    expect(failures).toEqual(expect.arrayContaining([0, 6, 7]));
    for (const load of pending.slice(1)) load.resolve(
      new Blob(["image"], { type: "image/png" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduled.dispose();
  });

  it("uses one imagery probe before restoring source-request concurrency", async () => {
    let attempts = 0;
    let rejectInitial!: (error: unknown) => void;
    let resolveProbe!: (blob: Blob) => void;
    const provider: ImageryProvider = {
      id: "half-open-probe-fixture",
      attribution: "fixture",
      tileSize: 512,
      minZoom: 3,
      maxZoom: 3,
      load: async () => {
        attempts += 1;
        if (attempts === 1) {
          return await new Promise<Blob>((_resolve, reject) => {
            rejectInitial = reject;
          });
        }
        if (attempts === 2) {
          return await new Promise<Blob>((resolve) => {
            resolveProbe = resolve;
          });
        }
        return new Blob(["image"], { type: "image/png" });
      },
    };
    const scheduled = new ScheduledImageryProvider(
      provider,
      async () => new Uint8Array([1, 2, 3, 4]),
    );
    scheduled.request({ z: 3, x: 0, y: 0 }, () => {});
    expect(attempts).toBe(1);
    rejectInitial(new ImageryRequestError("limited", "transient", 429, 0));
    await vi.waitFor(() =>
      expect(scheduled.retryDiagnostics.state).toBe("open"),
    );

    const responses: number[] = [];
    for (let x = 1; x <= 3; x += 1) {
      scheduled.request({ z: 3, x, y: 0 }, (result) => {
        if (result.phase === "response") responses.push(x);
      });
    }
    expect(attempts).toBe(2);
    expect(scheduled.retryDiagnostics).toMatchObject({
      state: "half-open",
      probe_in_flight: true,
    });

    resolveProbe(new Blob(["image"], { type: "image/png" }));
    await vi.waitFor(() => expect(attempts).toBe(4));
    await vi.waitFor(() => expect(responses).toHaveLength(3));
    expect(scheduled.retryDiagnostics.state).toBe("closed");
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
