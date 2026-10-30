import { afterEach, expect, it, vi } from "vitest";
import * as T from "three";
import { createGeantViewer, createGeantWorldsPlugin, createGeantMovementPlugin, createGeantSurfaceMovementModel, GEANT_ACTIONS } from "@found-in-space/pas-de-geant";
import { createGuidedJourneyController } from "@found-in-space/guided-journey";
import { assessSurfaceReadiness, XyzImageryProvider, SparseImageryProvider,
  type WorldWorkerKind, type TerrainElevationProvider } from "@found-in-space/pas-de-geant/worlds";
import { waitForGeantSurface, GeantSurfaceReadinessError, createGeantJourneyDriver } from "@found-in-space/pas-de-geant/journey";
import { FlatElevationTileProvider } from "../packages/pas-de-geant/src/worlds/elevation-tile-provider.js";
import { tileLayerReadiness } from "../packages/pas-de-geant/src/worlds/surface-readiness.js";
import { ScheduledImageryProvider } from "../packages/pas-de-geant/src/worlds/imagery.js";
import { generateImageryMipChain } from "../packages/pas-de-geant/src/worlds/imagery-mip-chain.js";
import type { TileSchedulerCommand, TileSchedulerMessage } from "../packages/pas-de-geant/src/worlds/tile-scheduler-protocol.js";
import type { ImageryDecoderCommand, ImageryDecoderMessage } from "../packages/pas-de-geant/src/worlds/imagery-decoder-protocol.js";
import type { TileLayoutTarget } from "../packages/pas-de-geant/src/worlds/tile-layout-source.js";
import type { TileProviderResult } from "../packages/pas-de-geant/src/worlds/tile-provider.js";
import type { ElevationTileResource } from "../packages/pas-de-geant/src/worlds/elevation-tile-provider.js";

const tile = {z: 0, x: 0, y: 0};
const target = {maxZoom: 0, latitudeDegrees: 0, longitudeDegrees: 0};
const snapshot = () => ({revision: 1, target, committedCut: [tile], requestedCut: [tile],
  graph: {retained: [tile], groups: [], batches: []}, requirements: []});
const scheduling = () => ({planner_requests: {requested: 0, in_flight: 0, total_outstanding: 0},
  target_submission: {pending: false, in_flight: false}});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals();});
const flush = async () => {for (let i = 0; i < 40; i++) await Promise.resolve();};

// Scripted platform boundary: one admitted tile, explicit decoder/publication
// responses. Real providers, scheduler bridge, virtual textures and worlds run.
class ControlledWorker {
  onmessage: ((event: MessageEvent<any>) => void) | null = null;
  private target: TileLayoutTarget = target;
  private requested = false;
  private failed = false;
  terminated = false;
  constructor(readonly kind: WorldWorkerKind) {}
  emit(data: TileSchedulerMessage | ImageryDecoderMessage) {
    if (!this.terminated) this.onmessage?.({data} as MessageEvent<any>);
  }
  postMessage(data: TileSchedulerCommand | ImageryDecoderCommand) {
    queueMicrotask(() => {
      if (this.terminated) return;
      if (data.kind === "initialize") {this.target = data.target; this.publish();}
      else if (data.kind === "target") {this.target = data.target; this.publish(); this.emit({kind: "target-applied", target: this.target});}
      else if (data.kind === "horizon-culling" && !this.requested) {
        this.requested = true; this.emit({kind: "resource-request", key: "0/0/0", tile, requestId: 1});
      } else if (data.kind === "resource-result") {
        if (data.result.phase === "in-flight") return;
        this.failed = data.result.phase === "failure";
        // Failure progress does not carry a fresh topology snapshot in the real worker.
        if (!this.failed) this.publish();
        this.emit({kind: "event", event: {kind: this.failed ? "failure" : "response", sequence: 1, revision: 1, tile}});
      } else if (data.kind === "decode") {
        this.emit({kind: "decoded", requestId: data.requestId,
          pixels: new Uint8Array((data.tileSize + data.gutter * 2) ** 2 * 4).buffer});
      } else if (data.kind === "mip") {
        this.emit({kind: "mipped", requestId: data.requestId, key: data.key, revision: data.revision,
          levels: generateImageryMipChain(new Uint8Array(data.pixels), data.width, data.height)
            .map(level => ({...level, pixels: level.pixels.slice().buffer}))});
      }
    });
  }
  publish() {this.emit({kind: "snapshot", snapshot: {...snapshot(), target: this.target,
    requirements: this.failed ? [{tile, state: "failed", requestId: 1, reason: "Controlled source unavailable"}] : []}});}
  terminate() {this.terminated = true;}
}

async function hostFixture(immersive = false) {
  vi.stubGlobal("document", {createElement: () => ({getContext: () => ({clearRect() {}, drawImage() {},
    getImageData: () => ({width: 1, height: 1, data: new Uint8ClampedArray([128, 0, 0, 255])})})})});
  const eye = new T.PerspectiveCamera(80); eye.viewport = new T.Vector4(0, 0, 1600, 2000);
  const head = new T.ArrayCamera([eye]); head.position.y = 1.65;
  const reference = new EventTarget(), session = {};
  const renderer = {xr: {isPresenting: immersive, getCamera: () => head, getSession: () => session, getReferenceSpace: () => reference,
    getFrame: () => ({getViewerPose: () => ({transform: {position: head.position, orientation: head.quaternion}})}),
    updateCamera(camera: T.Camera) {
      head.matrix.compose(head.position, head.quaternion, new T.Vector3(1, 1, 1));
      head.matrixWorld.multiplyMatrices(camera.parent!.matrixWorld, head.matrix); eye.matrixWorld.copy(head.matrixWorld);
    }}, render() {}, initTexture() {}, copyTextureToTexture() {},
    capabilities: {getMaxAnisotropy: () => 1}, getDrawingBufferSize: (v: T.Vector2) => v.set(800, 600)} as unknown as T.WebGLRenderer;
  const pending: Array<(blob: Blob) => void> = [];
  const failures: Array<(error: Error) => void> = [];
  const source = (id: string) => ({id, attribution: "Controlled fixture", tileSize: 256, minZoom: 0, maxZoom: 0,
    load: () => new Promise<Blob>((resolve, reject) => {pending.push(resolve); failures.push(reject);})});
  let terrainReply: (result: TileProviderResult<ElevationTileResource>) => void = () => {};
  const terrain: TerrainElevationProvider = {tilePixels: 1, metrics: new FlatElevationTileProvider().metrics, failureTotal: 0,
    retainSourceTiles() {}, resumeDeferred() {}, dispose() {},
    request(_tile, observer) {terrainReply = observer; return {requestId: 1, cancel() {}};}};
  const workers: ControlledWorker[] = [];
  const host = await createGeantViewer({renderer, bodies: ["earth"], mode: "surface", time: "2026-10-30T12:00:00Z", timeRate: 0,
    scaleDenominator: 1000000, location: {latitudeDegrees: 20, longitudeDegrees: 30, altitudeM: 10000}});
  cleanups.push(() => host.dispose());
  host.camera.position.y = 1.65;
  const movement = createGeantMovementPlugin({model: createGeantSurfaceMovementModel()}); await host.install(movement);
  await host.install(createGeantWorldsPlugin({surfaces: {earth: async () => ({baseTexture: new T.Texture(), disposeBaseTexture: true,
    nightTexture: new T.Texture(), disposeNightTexture: true, imageryProvider: source("day"), nightImageryProvider: source("night"),
    elevationProvider: terrain, workers: kind => {const worker = new ControlledWorker(kind); workers.push(worker); return worker as unknown as Worker;}})}}));
  const world = host.worlds.get("earth")!;
  async function frame() {await flush(); host.frame(0); await flush(); host.frame(0); await flush();}
  await frame();
  return {host, world, movement, workers, pending, failures, frame, terrainReply: (resource: ElevationTileResource) => terrainReply({phase: "response", resource})};
}

it("tracks target acknowledgement and publication without treating outgoing fallback as new-view failure", () => {
  const options = {snapshot: snapshot(), scheduling: scheduling(), workingSet: [tile, {z: 1, x: 0, y: 0}],
    suspended: false, published: false, failedTileCount: 0, fallbackTileCount: 0};
  expect(tileLayerReadiness(options).status).toBe("loading");
  options.published = true; expect(tileLayerReadiness(options).status).toBe("ready");
  options.scheduling.target_submission.pending = true; expect(tileLayerReadiness(options).status).toBe("loading");
  options.scheduling.target_submission.pending = false; options.fallbackTileCount = 1;
  expect(tileLayerReadiness(options).status).toBe("degraded");
  options.snapshot.requestedCut = [{z: 1, x: 0, y: 0}]; expect(tileLayerReadiness(options).status).toBe("loading");
  options.suspended = true; expect(tileLayerReadiness(options).status).toBe("suspended");
});

it("does not wait for off-horizon refinements or classify them as missing current-view data", () => {
  const visible = {z: 1, x: 0, y: 0}, behind = {z: 1, x: 1, y: 0}, refinedBehind = {z: 2, x: 2, y: 0};
  const state = {...snapshot(), committedCut: [visible, behind], requestedCut: [visible, refinedBehind]};
  const options = {snapshot: state, scheduling: scheduling(), workingSet: [visible],
    suspended: false, published: true, failedTileCount: 0, fallbackTileCount: 0};
  expect(tileLayerReadiness(options)).toMatchObject({status: "ready", requiredTileCount: 1});
  options.workingSet = [visible, behind, refinedBehind]; expect(tileLayerReadiness(options).status).toBe("loading");
  options.workingSet = []; expect(tileLayerReadiness(options)).toMatchObject({status: "degraded", requiredTileCount: 0});
});

it("preserves temporary fallback quality through sparse selection, shared acquisition and decoding", async () => {
  const provider = new XyzImageryProvider({id: "temporary", attribution: "Fixture", tileSize: 256, minZoom: 0, maxZoom: 0,
    urlTemplate: "/controlled/{z}/{x}/{y}"}, {cacheStorage: null, fetcher: vi.fn(async () => new Response(new Uint8Array([0]), {
      headers: {"content-type": "image/png", "x-tile-cache": "FALLBACK"}}))});
  const source = new ScheduledImageryProvider(new SparseImageryProvider(provider, [])); cleanups.push(() => source.dispose());
  const resource = await new Promise(resolve => source.request(tile, result => {if (result.phase === "response") resolve(result.resource);}));
  expect(resource).toMatchObject({temporaryFallback: true, sourceTile: tile});
  expect(source.metrics.failureTotal).toBe(0); expect(source.retryDiagnostics).toMatchObject({state: "closed"});
});

it.each([false, true])("reports independent current-view publication through the public world and gate, XR=%s", async immersive => {
  const f = await hostFixture(immersive), initial = f.world.getSurfaceReadiness();
  expect(initial.base.usable).toBe(true); expect(initial.view.latitudeDegrees).toBeCloseTo(20, 6);
  expect(initial.view.focalLengthPixels).toBeCloseTo(immersive ? 1000 / Math.tan(40 * Math.PI / 180)
    : 300 * f.host.camera.projectionMatrix.elements[5]!, 8);
  expect(initial.layers.imagery.status).toBe("loading"); expect(initial.layers.nightImagery.status).toBe("loading");
  const count = f.host.viewer.getSnapshot().partCount, abort = new AbortController();
  let settled = false;
  const promise = waitForGeantSurface({browser: f.host, body: "earth", required: ["imagery", "nightImagery", "terrain"],
    signal: abort.signal, onDegraded: "continue"}); void promise.then(() => {settled = true;});
  f.pending[0]!(new Blob(["day"])); await f.frame();
  expect(f.world.getSurfaceReadiness().layers.imagery.status).toBe("ready");
  expect(f.world.getSurfaceReadiness().layers.nightImagery.status).toBe("loading"); expect(settled).toBe(false);
  f.pending[1]!(new Blob(["night"])); await f.frame();
  expect(f.world.getSurfaceReadiness().layers.nightImagery.status).toBe("ready"); expect(settled).toBe(false);
  // A successful no-data response renders flat but cannot establish measured terrain.
  f.terrainReply({kind: "elevation", tile}); await f.frame();
  const result = await promise;
  expect(result.assessment).toEqual({status: "degraded", unmet: ["terrain"]});
  expect(result.readiness.layers.terrain).toMatchObject({status: "degraded", fallbackTileCount: 1});
  expect(f.host.viewer.getSnapshot().partCount).toBe(count);
  await expect(waitForGeantSurface({browser: f.host, body: "earth", required: ["terrain"], signal: abort.signal, onDegraded: "fail"}))
    .rejects.toBeInstanceOf(GeantSurfaceReadinessError);
  expect(f.host.viewer.getSnapshot().partCount).toBe(count);
  expect(assessSurfaceReadiness(f.world.getSurfaceReadiness(), ["imagery", "nightImagery"]).status).toBe("ready");
});

it("holds chapter completion for detail, then supersedes that wait through the shared controller", async () => {
  const f = await hostFixture(), driver = createGeantJourneyDriver({browser: {...f.host, movement: f.movement}});
  const scene = {camera: {kind: "surface" as const, body: "earth" as const, latitudeDegrees: 20, longitudeDegrees: 30,
    altitudeM: 10000, altitudeReference: "reference" as const, scaleDenominator: 1000000}, readiness: "none" as const};
  const journey = createGuidedJourneyController({driver, definition: {id: "readiness", transition: {durationSecs: 0}, chapters: [
    {id: "detail", scene, arrive: async context => {
      await waitForGeantSurface({browser: f.host, body: "earth", required: ["imagery"], onDegraded: "fail",
        signal: context.signal, onProgress: context.reportProgress});
    }}, {id: "base", scene},
  ]}});
  cleanups.push(async () => {await journey.dispose(); driver.dispose();});
  const baseline = f.host.viewer.getSnapshot().partCount;
  const first = journey.start(); await f.frame();
  expect(driver.navigation.getSnapshot().holding).toBe(true);
  expect(journey.getSnapshot()).toMatchObject({status: "transitioning", enteredChapterId: "detail", arrivedChapterId: null,
    progress: {assessment: {status: "loading"}}});
  const second = journey.goTo("base"); await f.frame();
  expect((await first.finished).status).toBe("superseded"); expect((await second.finished).status).toBe("completed");
  expect(journey.getSnapshot().arrivedChapterId).toBe("base");
  expect(f.host.viewer.getSnapshot().partCount).toBe(baseline);
});

it("reports newly failed source progress without waiting for a topology change", async () => {
  const f = await hostFixture();
  const wait = waitForGeantSurface({browser: f.host, body: "earth", required: ["nightImagery"],
    signal: new AbortController().signal, onDegraded: "fail"});
  const rejected = expect(wait).rejects.toMatchObject({name: "GeantSurfaceReadinessError",
    result: {readiness: {layers: {nightImagery: {status: "degraded", failedTileCount: 1}}}}});
  f.failures[1]!(new Error("Controlled network outage")); await f.frame(); await rejected;
  expect(f.world.getSurfaceReadiness().layers.imagery.status).toBe("loading");
});

it("requires bound measured terrain and completed imagery, and exposes suspended detail after a view change", async () => {
  const f = await hostFixture();
  f.pending[0]!(new Blob(["day"])); f.pending[1]!(new Blob(["night"]));
  f.terrainReply({kind: "elevation", tile, elevation: {kind: "image", mode: "terrain", tile, sourceTile: tile,
    image: {naturalWidth: 1, naturalHeight: 1} as HTMLImageElement, tilePixels: 1,
    sourceScale: 1, sourceOffsetX: 0, sourceOffsetY: 0, cacheStatus: "provider", loadDurationMs: 0, byteLength: 4}});
  await f.frame();
  expect(assessSurfaceReadiness(f.world.getSurfaceReadiness(), ["imagery", "nightImagery", "terrain"]))
    .toEqual({status: "ready", unmet: []});
  f.world.surface!.setLoadingSuspended(true);
  f.host.navigation.dispatch(GEANT_ACTIONS.setLocation, {latitudeDegrees: -20, longitudeDegrees: -30}); await f.frame();
  const suspended = f.world.getSurfaceReadiness();
  expect(suspended.view.latitudeDegrees).toBeCloseTo(-20, 6);
  expect(suspended.base.usable).toBe(true);
  expect(Object.values(suspended.layers).every(layer => layer.status === "suspended")).toBe(true);
  expect(assessSurfaceReadiness(suspended, ["terrain"]).status).toBe("loading");
  f.world.surface!.setLoadingSuspended(false); await f.frame();
  expect(assessSurfaceReadiness(f.world.getSurfaceReadiness(), ["terrain"]).status).toBe("ready");
});

it("removes waiting frame work on cancellation and rejects pending gates on host disposal", async () => {
  const f = await hostFixture(), count = f.host.viewer.getSnapshot().partCount;
  const abort = new AbortController();
  const first = waitForGeantSurface({browser: f.host, body: "earth", required: ["imagery"], signal: abort.signal, onDegraded: "fail"});
  const cancelled = expect(first).rejects.toThrow("Superseded chapter"); abort.abort(new Error("Superseded chapter")); await cancelled;
  expect(f.host.viewer.getSnapshot().partCount).toBe(count);
  const second = waitForGeantSurface({browser: f.host, body: "earth", required: ["nightImagery"], signal: new AbortController().signal, onDegraded: "fail"});
  const disposed = expect(second).rejects.toThrow("disposed"); await f.host.dispose(); await disposed;
  expect(f.workers.every(worker => worker.terminated)).toBe(true);
});
