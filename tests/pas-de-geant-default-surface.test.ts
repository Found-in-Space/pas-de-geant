import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultSurfaceFactory, createReferenceSurfaceFactory } from "@found-in-space/pas-de-geant/browser";

afterEach(() => vi.unstubAllGlobals());
const products = {
  day: readFileSync(new URL("./fixtures/earth-products/blue-marble-200407-500m.json", import.meta.url), "utf8"),
  night: readFileSync(new URL("./fixtures/earth-products/black-marble-2016-500m.json", import.meta.url), "utf8"),
};

describe("browser default Earth surface", () => {
  it.each(["admitted", "changed", "unavailable"])("keeps measured terrain with %s imagery descriptors", async status => {
    const fetcher = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.includes("mapterhorn")) return new Response(null, { status: 503 });
      if (url.endsWith("product.json")) return status === "unavailable" ? new Response(null, { status: 503 })
        : new Response(products[url.includes("black-marble") ? "night" : "day"] + (status === "changed" ? " " : ""));
      return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("caches", undefined);
    vi.stubGlobal("createImageBitmap", async () => ({ width: 4096, height: 2048, close() {} }));
    const source = await createDefaultSurfaceFactory({ night: true })({ body: "earth", renderer: {} as THREE.WebGLRenderer, signal: new AbortController().signal });
    expect(source.surfaceModel?.elevationMetadata.maxSourceZoom).toBe(12);
    expect(source.surfaceModel?.elevationMetadata.elevationBoundsMetres?.minimum).toBeLessThan(0);
    expect(source.elevationProvider?.coverage?.globalMaximumZoom).toBe(12);
    expect(source.elevationProvider?.tilePixels).toBe(512);
    expect(Boolean(source.imageryProvider)).toBe(status === "admitted");
    expect(Boolean(source.nightImageryProvider)).toBe(status === "admitted");
    expect(source.baseFallback).toBe(true); // The fixture has no admitted base pixels.
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("mapterhorn"))).toBe(false);
    await new Promise<void>(resolve => source.elevationProvider!.request({ z: 0, x: 0, y: 0 }, result => {
      if (result.phase !== "in-flight") resolve();
    }));
    expect(fetcher.mock.calls.some(([input]) => String(input) === "https://tiles.mapterhorn.com/0/0/0.webp")).toBe(true);
    source.elevationProvider?.dispose(); source.baseTexture.dispose(); source.nightTexture?.dispose();
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
import { readFileSync } from "node:fs";
