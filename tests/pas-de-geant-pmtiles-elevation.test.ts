import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Texture } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBodySurfaceDatasets, type EarthPmtilesDatasetBinding } from "../packages/pas-de-geant/src/worlds/datasets.js";
import type { ElevationTileResource, TerrainElevationProvider } from "../packages/pas-de-geant/src/worlds/elevation-tile-provider.js";
import type { TileProviderResult } from "../packages/pas-de-geant/src/worlds/tile-provider.js";
import type { TileIdentity } from "../packages/pas-de-geant/src/worlds/tile-transition-planner.js";

const archive = readFileSync(new URL("./fixtures/earth-pmtiles/earth.pmtiles", import.meta.url));
const descriptor = readFileSync(new URL("./fixtures/earth-pmtiles/product.json", import.meta.url), "utf8");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const productUrl = "https://fixtures.test/earth/product.json";
const binding: EarthPmtilesDatasetBinding = { transport: "pmtiles", productUrl, productSha256: sha256(descriptor),
  attribution: "Synthetic terrain", verticalReference: "preserve-upstream" };
const header = new DataView(archive.buffer, archive.byteOffset, 127);
const tileEnd = Number(header.getBigUint64(56, true) + header.getBigUint64(64, true));

class MemoryCache {
  readonly values = new Map<string, Response>();
  async open() { return this; }
  async match(key: RequestInfo | URL) { return this.values.get(String(key))?.clone(); }
  async put(key: RequestInfo | URL, value: Response) { this.values.set(String(key), value.clone()); }
  async delete(key: RequestInfo | URL) { return this.values.delete(String(key)); }
}

// Exercise byte transport and mapping in Node. Native image/GPU decoding remains
// browser acceptance; this fixture only reads a real PNG's dimensions and bytes.
class FixtureImage {
  naturalWidth = 0; naturalHeight = 0;
  bytes = new Uint8Array();
  onload?: () => void; onerror?: () => void;
  private current = "";
  set src(url: string) {
    this.current = url;
    if (!url) return;
    void fetch(url).then(response => response.arrayBuffer()).then(data => {
      if (this.current !== url) return;
      const view = new DataView(data);
      if (view.byteLength < 24 || view.getUint32(0) !== 0x89504e47) { this.onerror?.(); return; }
      this.bytes = new Uint8Array(data);
      this.naturalWidth = view.getUint32(16); this.naturalHeight = view.getUint32(20); this.onload?.();
    });
  }
}
beforeEach(() => { vi.stubGlobal("Image", FixtureImage); vi.stubGlobal("caches", new MemoryCache()); });
afterEach(() => vi.unstubAllGlobals());

function server() {
  const state = { document: descriptor, offline: false, outage: false, etag: '"fixture"',
    holdTiles: false, holdDirectory: false, aborted: false, corruptRange: "" };
  const ranges: number[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === productUrl) return new Response(state.document);
    expect(String(url)).toBe("https://fixtures.test/earth/earth.pmtiles");
    if (state.offline) throw new TypeError("offline");
    const range = new Headers(init?.headers).get("range")!;
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(first), end = Number(last), isTile = start >= 16384 && start < tileEnd;
    ranges.push(start);
    if ((state.holdTiles && isTile) || (state.holdDirectory && start !== 0 && !isTile)) {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => {
        state.aborted = true; reject(init.signal!.reason);
      }, { once: true }));
    }
    if (state.outage && isTile) return new Response("unavailable", { status: 503 });
    const bytes = new Uint8Array(archive.subarray(start, end + 1 - (state.corruptRange === "truncated" ? 1 : 0)));
    return new Response(bytes, { status: state.corruptRange === "status" ? 200 : 206, headers: {
      "content-range": state.corruptRange === "range" ? "bytes 0-1/2" : `bytes ${start}-${end}/${archive.byteLength}`,
      etag: state.corruptRange === "etag" ? 'W/"weak"' : state.etag,
    } });
  });
  return { state, ranges, fetcher };
}

async function surface(fetcher: typeof fetch, selected = binding, signal?: AbortSignal) {
  const fallback = new Texture();
  try { return await resolveBodySurfaceDatasets({ body: "earth", datasets: { elevation: selected }, baseTexture: fallback, fetcher, signal }); }
  catch (error) { fallback.dispose(); throw error; }
}
function tile(provider: TerrainElevationProvider, requested: TileIdentity) {
  return new Promise<TileProviderResult<ElevationTileResource>>(resolve => {
    provider.request(requested, result => { if (result.phase !== "in-flight") resolve(result); });
  });
}
async function image(provider: TerrainElevationProvider, requested: TileIdentity) {
  const result = await tile(provider, requested);
  expect(result.phase).toBe("response");
  if (result.phase !== "response" || !result.resource.elevation) throw new Error("Missing real height payload");
  return result.resource.elevation;
}

describe("Earth PMTiles dataset composition", () => {
  it("calls a receiver-sensitive browser fetch function without binding it to the range reader", async () => {
    const fixture = server();
    const fetcher: typeof fetch = function(this: unknown, ...args) {
      // Window.fetch rejects an arbitrary object receiver; Node fetch does not.
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return fixture.fetcher(...args);
    };
    const source = await surface(fetcher);
    try {
      const result = await image(source.elevationProvider!, { z: 2, x: 0, y: 0 });
      expect(result.sourceTile).toEqual({ z: 2, x: 0, y: 0 });
      expect(fixture.ranges.length).toBeGreaterThan(2);
    } finally { source.elevationProvider!.dispose(); source.baseTexture.dispose(); }
  });

  it("uses the producer's sparse directory and shared ancestor UVs, including present zero tiles", async () => {
    const fixture = server(), source = await surface(fixture.fetcher), provider = source.elevationProvider!;
    try {
      expect(sha256(archive)).toBe(JSON.parse(descriptor).transport.sha256);
      expect(source.surfaceModel?.elevationMetadata.attribution).toContain("unresolved upstream height reference");
      const fallback = await image(provider, { z: 3, x: 5, y: 1 });
      expect(fallback).toMatchObject({ sourceTile: { z: 1, x: 1, y: 0 }, sourceScale: 4, sourceOffsetX: 1, sourceOffsetY: 1, tilePixels: 256 });
      expect(sha256((fallback.image as unknown as FixtureImage).bytes)).toBe("794622265bbc7f41a77c26c066d48c8a49228b401eed36db674b7d1207827426");
      const zero = await image(provider, { z: 3, x: 1, y: 1 });
      expect(zero).toMatchObject({ sourceTile: { z: 2, x: 0, y: 0 }, sourceScale: 2, sourceOffsetX: 1, sourceOffsetY: 1 });
      expect(sha256((zero.image as unknown as FixtureImage).bytes)).toBe("4fcfdd8fbc702879e491242fc08d77e6305ca6c6847fb360c6e0994e40adf9bc");
      expect(provider.failureTotal).toBe(0);
      expect(provider.coverage?.ranges.some(([z, minX, minY, maxX, maxY]) => z === 2 && minX <= 2 && maxX >= 2 && minY <= 0 && maxY >= 0)).toBe(false);
    } finally { provider.dispose(); source.baseTexture.dispose(); }
  });

  it("requires the explicit height policy and authenticated descriptor before reading the archive", async () => {
    const fixture = server();
    await expect(surface(fixture.fetcher, { ...binding, verticalReference: undefined } as any)).rejects.toThrow("height policy");
    expect(fixture.ranges).toHaveLength(0);
    fixture.state.document += " ";
    await expect(surface(fixture.fetcher)).rejects.toThrow("SHA-256 differs");
    expect(fixture.ranges).toHaveLength(0);
    fixture.state.document = "null";
    await expect(surface(fixture.fetcher, { ...binding, productSha256: sha256("null") })).rejects.toThrow("PMTiles source");
    expect(fixture.ranges).toHaveLength(0);
  });

  it("rejects a descriptor that disagrees with actual archive coverage", async () => {
    const fixture = server(), altered = JSON.parse(descriptor);
    altered.coverage.addressedTiles += 1; fixture.state.document = JSON.stringify(altered);
    await expect(surface(fixture.fetcher, { ...binding, productSha256: sha256(fixture.state.document) })).rejects.toThrow("header differs");
  });

  it.each(["status", "range", "etag", "truncated"])("rejects invalid %s range responses instead of supplying flat terrain", async corruptRange => {
    const fixture = server(); fixture.state.corruptRange = corruptRange;
    await expect(surface(fixture.fetcher)).rejects.toThrow(/PMTiles/);
  });

  it("reopens retained directories and tile bytes offline with the same source mapping", async () => {
    const fixture = server(), first = await surface(fixture.fetcher);
    const requested = { z: 3, x: 5, y: 1 };
    const original = await image(first.elevationProvider!, requested);
    first.elevationProvider!.dispose(); first.baseTexture.dispose();
    const count = fixture.ranges.length; fixture.state.offline = true;
    const second = await surface(fixture.fetcher);
    try {
      const retained = await image(second.elevationProvider!, requested);
      expect(retained.cacheStatus).toBe("persistent-hit");
      expect(retained.sourceTile).toEqual(original.sourceTile);
      expect(sha256((retained.image as unknown as FixtureImage).bytes)).toBe(sha256((original.image as unknown as FixtureImage).bytes));
      expect(fixture.ranges).toHaveLength(count);
    } finally { second.elevationProvider!.dispose(); second.baseTexture.dispose(); }
  });

  it("serves persistent terrain during provider backoff and fails a changed server version", async () => {
    const fixture = server(), source = await surface(fixture.fetcher), provider = source.elevationProvider!;
    try {
      await image(provider, { z: 3, x: 5, y: 1 }); provider.retainSourceTiles([]);
      fixture.state.outage = true;
      expect(await tile(provider, { z: 2, x: 0, y: 0 })).toMatchObject({ phase: "failure", status: 503 });
      expect((await image(provider, { z: 3, x: 5, y: 1 })).cacheStatus).toBe("persistent-hit");
      fixture.state.outage = false; fixture.state.etag = '"changed"'; provider.resumeDeferred();
      expect(await tile(provider, { z: 2, x: 3, y: 3 })).toMatchObject({ phase: "failure", reason: expect.stringContaining("identity changed") });
    } finally { provider.dispose(); source.baseTexture.dispose(); }
  });

  it("evicts undecodable cached payloads and recovers through the shared queue's network retry", async () => {
    const fixture = server(), source = await surface(fixture.fetcher), provider = source.elevationProvider!;
    try {
      const requested = { z: 2, x: 0, y: 0 };
      const original = await image(provider, requested); provider.retainSourceTiles([]);
      const storage = caches as unknown as MemoryCache, offset = fixture.ranges.at(-1)!;
      const [key, response] = [...storage.values].find(([key]) =>
        new URL(key).searchParams.get("geant-pmtiles-range")?.startsWith(`${offset}-`))!;
      storage.values.set(key, new Response(new Uint8Array(original.byteLength), { headers: response.headers }));
      const remove = vi.spyOn(storage, "delete"), count = fixture.ranges.length;
      expect(sha256(((await image(provider, requested)).image as unknown as FixtureImage).bytes))
        .toBe(sha256((original.image as unknown as FixtureImage).bytes));
      expect(remove).toHaveBeenCalledWith(key);
      expect(fixture.ranges).toHaveLength(count + 1);
      expect(provider.failureTotal).toBe(0);
    } finally { provider.dispose(); source.baseTexture.dispose(); }
  });

  it("cancels directory admission and pending tile acquisition without a stale response", async () => {
    const fixture = server(), abort = new AbortController(); fixture.state.holdDirectory = true;
    const pending = surface(fixture.fetcher, binding, abort.signal);
    await vi.waitFor(() => expect(fixture.ranges.length).toBeGreaterThan(1)); abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.state.aborted).toBe(true);
    fixture.state.holdDirectory = false; fixture.state.aborted = false;
    const source = await surface(fixture.fetcher), provider = source.elevationProvider!;
    try {
      fixture.state.holdTiles = true;
      const responses: TileProviderResult<ElevationTileResource>[] = [];
      const handle = provider.request({ z: 2, x: 0, y: 0 }, result => responses.push(result));
      await vi.waitFor(() => expect(provider.metrics.acquisitionActive).toBe(1)); handle.cancel();
      await vi.waitFor(() => expect(fixture.state.aborted).toBe(true));
      expect(responses.filter(result => result.phase !== "in-flight")).toEqual([]);
    } finally { provider.dispose(); source.baseTexture.dispose(); }
  });
});
