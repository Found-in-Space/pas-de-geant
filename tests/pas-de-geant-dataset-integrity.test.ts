import { createHash } from "node:crypto";
import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBodySurfaceDatasets, type BodySurfaceDatasets } from "../packages/pas-de-geant/src/worlds/datasets.js";

afterEach(() => vi.unstubAllGlobals());
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const grid = { formatVersion: 1, projection: "web-mercator", radiusMetres: 6378137 };
function inputs() {
  const bases = { imagery: "original day pixels", nightImagery: "original night pixels" };
  const datasets: BodySurfaceDatasets = {};
  const documents: Record<string, string> = {};
  for (const name of ["imagery", "nightImagery", "elevation"] as const) {
    const value = name === "elevation" ? { kind: "elevation-xyz", formatVersion: 2, target: "earth", grid,
      identity: hash("height producer"), units: "metres", verticalDatum: { kind: "reference-surface", radiusMetres: 6378137 },
      encoding: { kind: "terrarium" }, tileSize: 256, maximumZoom: 2, elevationBoundsMetres: { minimum: -20, maximum: 2000 } }
      : { format_version: 2, target: { id: "earth" }, product_identity_sha256: hash(name), grid,
        tiles: { addressing: "XYZ", matrix: "2^z x 2^z", opaque: true, format: "png", tile_size: 256, maximum_zoom: 2 },
        baseTexture: { projection: "equirectangular", path: "base.png", width: 2, height: 1, sha256: hash(bases[name]) } };
    const productUrl = `https://fixtures.test/${name}/product.json`, bytes = JSON.stringify(value, null, 2) + "\n";
    Object.assign(datasets, { [name]: { productUrl, productSha256: hash(bytes), urlTemplate: "./tiles/{z}/{x}/{y}.png", attribution: name } });
    documents[productUrl] = bytes;
  }
  return { bases, datasets, documents };
}

describe("surface dataset byte admission", () => {
  it("authenticates all descriptor bytes and passes base identities to a custom loader", async () => {
    const { bases, datasets, documents } = inputs();
    const fetcher = vi.fn<typeof fetch>(async url => new Response(documents[String(url)]));
    const loadTexture = vi.fn(async (_url: string, _signal?: AbortSignal, _sha256?: string) => new THREE.Texture());
    const fallback = new THREE.Texture();
    const source = await resolveBodySurfaceDatasets({ body: "earth", datasets, baseTexture: fallback, fetcher, loadTexture });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(loadTexture.mock.calls.map(([, , pin]) => pin)).toEqual([hash(bases.imagery), hash(bases.nightImagery)]);
    expect(source.elevationProvider?.tilePixels).toBe(256);
    source.elevationProvider?.dispose(); source.baseTexture.dispose(); source.nightTexture?.dispose(); fallback.dispose();
  });

  it.each(["imagery", "nightImagery", "elevation"] as const)("rejects changed %s bytes before loading any base", async name => {
    const { datasets, documents } = inputs(), fallback = new THREE.Texture();
    const dispose = vi.spyOn(fallback, "dispose"), loadTexture = vi.fn(async () => new THREE.Texture());
    const fetcher = vi.fn<typeof fetch>(async url => new Response(documents[String(url)] + (url === datasets[name]!.productUrl ? " " : "")));
    await expect(resolveBodySurfaceDatasets({ body: "earth", datasets, baseTexture: fallback, disposeBaseTexture: true, fetcher, loadTexture }))
      .rejects.toThrow("SHA-256 differs");
    expect(loadTexture).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled(); fallback.dispose();
  });

  it("rejects malformed pins before fetching and mismatched bytes before parsing", async () => {
    const { datasets } = inputs(), fallback = new THREE.Texture();
    const fetcher = vi.fn<typeof fetch>(async () => new Response("not JSON"));
    await expect(resolveBodySurfaceDatasets({ body: "earth", datasets: { imagery: { ...datasets.imagery!, productSha256: "bad" } }, baseTexture: fallback, fetcher }))
      .rejects.toThrow("64 lowercase hexadecimal");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(resolveBodySurfaceDatasets({ body: "earth", datasets, baseTexture: fallback, fetcher })).rejects.toThrow("SHA-256 differs");
    fallback.dispose();
  });

  it.each(["imagery", "nightImagery"] as const)("keeps corrupt %s base bytes out of image decoding", async corrupt => {
    const { bases, datasets, documents } = inputs(), fallback = new THREE.Texture();
    const close = vi.fn(), decode = vi.fn(async (_blob: Blob) => ({ width: 2, height: 1, close }));
    vi.stubGlobal("createImageBitmap", decode);
    const fetcher = vi.fn<typeof fetch>(async url => {
      const path = String(url);
      if (path.endsWith("product.json")) return new Response(documents[path]);
      const name = path.includes("/nightImagery/") ? "nightImagery" : "imagery";
      return new Response(bases[name] + (name === corrupt ? "changed" : ""), { headers: { "content-type": "image/png" } });
    });
    const source = await resolveBodySurfaceDatasets({ body: "earth", datasets, baseTexture: fallback, fetcher });
    expect(decode).toHaveBeenCalledOnce();
    expect(await (decode.mock.calls[0]![0] as Blob).text()).toBe(bases[corrupt === "imagery" ? "nightImagery" : "imagery"]);
    expect(source.baseFallback).toBe(true);
    expect(source.imageryProvider).toBeDefined(); expect(source.nightImageryProvider).toBeDefined();
    if (corrupt === "imagery") expect(source.baseTexture).toBe(fallback);
    else expect((source.nightTexture as THREE.DataTexture).image.data).toEqual(new Uint8Array([0, 0, 0, 255]));
    source.elevationProvider?.dispose(); source.baseTexture.dispose(); source.nightTexture?.dispose();
    expect(close).toHaveBeenCalledOnce(); if (source.baseTexture !== fallback) fallback.dispose();
  });

  it("honours cancellation after a descriptor body arrives without acquiring bases", async () => {
    const { datasets, documents } = inputs(), abort = new AbortController(), fallback = new THREE.Texture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>(async url => { await pending; return new Response(documents[String(url)]); });
    const loadTexture = vi.fn(async () => new THREE.Texture());
    const result = resolveBodySurfaceDatasets({ body: "earth", datasets, baseTexture: fallback, signal: abort.signal, fetcher, loadTexture });
    abort.abort(); release();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(loadTexture).not.toHaveBeenCalled(); fallback.dispose();
  });
});
