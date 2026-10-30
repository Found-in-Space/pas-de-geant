import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultSurfaceFactory, createReferenceSurfaceFactory } from "@found-in-space/pas-de-geant/browser";

afterEach(() => vi.unstubAllGlobals());

describe("browser default Earth surface", () => {
  it.each([true, false])("keeps measured terrain available when the Blue Marble descriptor is available=%s", async online => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.includes("mapterhorn")) return new Response(null, { status: 503 });
      if (url.endsWith("product.json")) return online ? Response.json({
        format_version: 2, target: { id: "earth" }, product_identity_sha256: "a".repeat(64),
        grid: { formatVersion: 1, projection: "web-mercator", radiusMetres: 6378137 },
        tiles: { addressing: "XYZ", matrix: "2^z x 2^z", opaque: true, format: "png", tile_size: 256, maximum_zoom: 9 },
        baseTexture: { projection: "equirectangular", path: "base.png", width: 4096, height: 2048, sha256: "b".repeat(64) },
      }) : new Response(null, { status: 503 });
      return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("caches", undefined);
    vi.stubGlobal("createImageBitmap", async () => ({ width: 4096, height: 2048, close() {} }));
    const source = await createDefaultSurfaceFactory()({ body: "earth", renderer: {} as THREE.WebGLRenderer, signal: new AbortController().signal });
    expect(source.surfaceModel?.elevationMetadata.maxSourceZoom).toBe(12);
    expect(source.surfaceModel?.elevationMetadata.elevationBoundsMetres?.minimum).toBeLessThan(0);
    expect(source.elevationProvider?.coverage?.globalMaximumZoom).toBe(12);
    expect(source.elevationProvider?.tilePixels).toBe(512);
    expect(Boolean(source.imageryProvider)).toBe(online);
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("mapterhorn"))).toBe(false);
    await new Promise<void>(resolve => source.elevationProvider!.request({ z: 0, x: 0, y: 0 }, result => {
      if (result.phase !== "in-flight") resolve();
    }));
    expect(fetcher.mock.calls.some(([input]) => String(input) === "https://tiles.mapterhorn.com/0/0/0.webp")).toBe(true);
    source.elevationProvider?.dispose(); source.baseTexture.dispose();
  });

  it("keeps explicit reference surfaces and lunar defaults independent of Earth services", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1])));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("createImageBitmap", async () => ({ width: 2048, height: 1024, close() {} }));
    const context = { renderer: {} as THREE.WebGLRenderer, signal: new AbortController().signal };
    const reference = await createReferenceSurfaceFactory()({ ...context, body: "earth" });
    const moon = await createDefaultSurfaceFactory()({ ...context, body: "moon" });
    expect(reference.elevationProvider).toBeUndefined(); expect(moon.elevationProvider).toBeUndefined();
    expect(fetcher.mock.calls.every(([input]) => !String(input).startsWith("https:"))).toBe(true);
    reference.baseTexture.dispose(); moon.baseTexture.dispose();
  });
});
