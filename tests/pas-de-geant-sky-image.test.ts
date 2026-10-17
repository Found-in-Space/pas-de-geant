import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createGeantViewer } from "@found-in-space/pas-de-geant";
import { createGeantSkyImagePlugin, deepStarMapUv, deepStarMapPolarUv } from "@found-in-space/pas-de-geant/sky-image";
import { j2000ToWorldQuaternion } from "@found-in-space/pas-de-geant/worlds";

function renderer() {
  return { render: vi.fn(), clearDepth: vi.fn(), clear: vi.fn(), autoClear: true, xr: { isPresenting: false } } as unknown as THREE.WebGLRenderer;
}
afterEach(() => vi.unstubAllGlobals());

describe("optional static sky", () => {
  it("maps celestial directions to the NASA image without mirroring or reversing north", () => {
    expect(deepStarMapUv({ x: 1, y: 0, z: 0 }).toArray()).toEqual([0.5, 0.5]);
    expect(deepStarMapUv({ x: 0, y: 2, z: 0 }).toArray()).toEqual([0.25, 0.5]);
    expect(deepStarMapUv({ x: 0, y: -2, z: 0 }).toArray()).toEqual([0.75, 0.5]);
    expect(deepStarMapUv({ x: -1, y: 0, z: 0 }).x).toBe(0);
    expect(deepStarMapUv({ x: 0, y: 0, z: 1 }).y).toBe(1);
    expect(deepStarMapUv({ x: 0, y: 0, z: -1 }).y).toBe(0);
    expect(deepStarMapUv({ x: 1, y: 0, z: 1 }).y).toBeCloseTo(0.75);
  });

  it("keeps both polar projections continuous across longitude and aligned with J2000 X/Y", () => {
    const extent = Math.tan(35 * Math.PI / 180);
    for (const z of [-1, 1]) {
      expect(deepStarMapPolarUv({ x: 0, y: 0, z }).toArray()).toEqual([0.5, 0.5]);
      expect(deepStarMapPolarUv({ x: extent, y: 0, z }).toArray()).toEqual([1, 0.5]);
      expect(deepStarMapPolarUv({ x: 0, y: extent, z }).toArray()).toEqual([0.5, 1]);
      for (let ra = -Math.PI; ra <= Math.PI; ra += Math.PI / 8) {
        const uv = deepStarMapPolarUv({ x: 1e-7 * Math.cos(ra), y: 1e-7 * Math.sin(ra), z });
        expect(uv.distanceTo(new THREE.Vector2(0.5, 0.5))).toBeLessThan(1e-6);
        const edge = deepStarMapPolarUv({ x: 0.5 * Math.cos(ra), y: 0.5 * Math.sin(ra), z: z * Math.sin(Math.PI / 3) });
        expect(Math.min(edge.x, edge.y)).toBeGreaterThan(0);
        expect(Math.max(edge.x, edge.y)).toBeLessThan(1);
      }
    }
  });

  it("uses the Geant celestial rotation, draws before worlds, and releases only owned resources", async () => {
    const borrowed = new THREE.Texture(); const textureDispose = vi.spyOn(borrowed, "dispose");
    const graphics = renderer(); const viewer = await createGeantViewer({ renderer: graphics });
    const uninstall = await viewer.install(createGeantSkyImagePlugin({ texture: borrowed }));
    viewer.context.presentation.systemRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    viewer.camera.position.set(100, -30, 400);
    viewer.render();
    expect(graphics.clear).toHaveBeenCalledOnce(); expect(graphics.autoClear).toBe(true);
    const [skyScene, camera] = vi.mocked(graphics.render).mock.calls[0]!;
    const sky = skyScene.getObjectByName("geant:sky-image") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(camera).toBe(viewer.camera);
    expect(sky.quaternion.angleTo(j2000ToWorldQuaternion(viewer.context.presentation.systemRotation))).toBeLessThan(1e-7);
    expect(sky.position.toArray()).toEqual([0, 0, 0]);
    expect(sky.material.uniforms.skyMap!.value).toBe(borrowed);
    expect(sky.material.depthWrite).toBe(false);
    expect(vi.mocked(graphics.render).mock.calls[1]![0]).toBe(viewer.scene);
    const prepareEye = () => {
      viewer.camera.updateMatrixWorld(true);
      sky.onBeforeRender(graphics, skyScene as THREE.Scene, viewer.camera, sky.geometry, sky.material, new THREE.Group());
      return (sky.material.uniforms.skyViewToJ2000!.value as THREE.Matrix3).clone();
    };
    const firstEye = prepareEye();
    viewer.camera.position.x += 0.064;
    expect(prepareEye().equals(firstEye)).toBe(true);
    viewer.camera.rotateY(0.2);
    expect(prepareEye().equals(firstEye)).toBe(false);
    expect((sky.material.uniforms.skyProjectionInverse!.value as THREE.Matrix4).equals(viewer.camera.projectionMatrixInverse)).toBe(true);
    const geometryDispose = vi.spyOn(sky.geometry, "dispose"), materialDispose = vi.spyOn(sky.material, "dispose");
    await uninstall();
    expect(viewer.viewer.getSnapshot().parts).toHaveLength(0);
    graphics.render = vi.fn(); viewer.render(); expect(graphics.render).toHaveBeenCalledOnce();
    await viewer.dispose();
    expect(geometryDispose).toHaveBeenCalledOnce(); expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).not.toHaveBeenCalled();
  });

  it("fetches the immutable published image only on installation, and closes its bitmap on removal", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Blob(["fixture"])));
    const bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[] = [];
    const decode = vi.fn(async (_image: ImageBitmapSource, _options?: ImageBitmapOptions) => {
      const bitmap = { width: 4, height: 2, close: vi.fn() }; bitmaps.push(bitmap); return bitmap;
    });
    vi.stubGlobal("fetch", fetcher); vi.stubGlobal("createImageBitmap", decode);
    const plugin = createGeantSkyImagePlugin();
    const graphics = renderer(); const viewer = await createGeantViewer({ renderer: graphics });
    expect(fetcher).not.toHaveBeenCalled();
    const uninstall = await viewer.install(plugin);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const base = "https://data.foundin.space/textures/sky/deep-star-maps-2020/20261017.2/";
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      base + "deep-star-map-2020-4k.webp", base + "deep-star-map-2020-north-1024.webp", base + "deep-star-map-2020-south-1024.webp",
    ]);
    expect(decode.mock.calls[0]?.[1]).toMatchObject({ imageOrientation: "flipY", colorSpaceConversion: "none" });
    viewer.render();
    const scene = vi.mocked(graphics.render).mock.calls[0]![0] as THREE.Scene;
    const sky = scene.getObjectByName("geant:sky-image") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(sky.material.uniforms.skyNorth!.value.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(sky.material.uniforms.skySouth!.value.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(sky.material.uniforms.skyMap!.value.wrapS).toBe(THREE.RepeatWrapping);
    await uninstall(); await viewer.dispose();
    expect(bitmaps).toHaveLength(3); for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("uses a caller-hosted image without contacting the publication server", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Blob(["fixture"])));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4, height: 2, close() {} })));
    const viewer = await createGeantViewer({ renderer: renderer() });
    await viewer.install(createGeantSkyImagePlugin({ url: "/offline/sky.webp" }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("/offline/sky.webp");
    await viewer.dispose();
  });

  it("cancels pending decoding during viewer disposal and discards a late bitmap", async () => {
    const bitmap = { width: 4, height: 2, close: vi.fn() };
    let finish!: (value: typeof bitmap) => void;
    const decode = vi.fn(() => new Promise<typeof bitmap>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["fixture"]))));
    vi.stubGlobal("createImageBitmap", decode);
    const viewer = await createGeantViewer({ renderer: renderer() });
    const installation = viewer.install(createGeantSkyImagePlugin({ url: "/pending.webp" }));
    const rejected = expect(installation).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    await viewer.dispose(); finish(bitmap); await rejected;
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(viewer.viewer.getSnapshot().parts).toHaveLength(0);
  });

  it("releases loaded images and discards late cap decoding if another cap fails", async () => {
    let failNorth!: (response: Response) => void;
    let finishSouth!: (bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }) => void;
    const mapBitmap = { width: 4, height: 2, close: vi.fn() }, southBitmap = { width: 2, height: 2, close: vi.fn() };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("north")
      ? new Promise<Response>(resolve => { failNorth = resolve; })
      : new Response(new Blob([url.includes("south") ? "south" : "main"]))));
    const decode = vi.fn(async (blob: Blob) => await blob.text() === "main" ? mapBitmap
      : new Promise<typeof southBitmap>(resolve => { finishSouth = resolve; }));
    vi.stubGlobal("createImageBitmap", decode);
    const viewer = await createGeantViewer({ renderer: renderer() });
    const rejected = expect(viewer.install(createGeantSkyImagePlugin())).rejects.toThrow(/HTTP 404/);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
    failNorth(new Response(null, { status: 404 })); await rejected;
    expect(mapBitmap.close).toHaveBeenCalledOnce();
    finishSouth(southBitmap);
    await vi.waitFor(() => expect(southBitmap.close).toHaveBeenCalledOnce());
    expect(viewer.viewer.getSnapshot().parts).toHaveLength(0); await viewer.dispose();
  });

  it("borrows supplied cap textures and can disable default caps", async () => {
    const map = new THREE.Texture(), north = new THREE.Texture(), south = new THREE.Texture();
    const disposals = [map, north, south].map(texture => vi.spyOn(texture, "dispose"));
    const fetcher = vi.fn(async () => new Response(new Blob(["fixture"])));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4, height: 2, close() {} })));
    const graphics = renderer(); const viewer = await createGeantViewer({ renderer: graphics });
    const remove = await viewer.install(createGeantSkyImagePlugin({ texture: map, polarCaps: { north, south } }));
    viewer.render();
    const sky = (vi.mocked(graphics.render).mock.calls[0]![0] as THREE.Scene)
      .getObjectByName("geant:sky-image") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(sky.material.uniforms.skyNorth!.value).toBe(north);
    expect(sky.material.uniforms.skySouth!.value).toBe(south);
    await remove(); for (const disposal of disposals) expect(disposal).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await viewer.install(createGeantSkyImagePlugin({ polarCaps: false }));
    expect(fetcher).toHaveBeenCalledOnce(); await viewer.dispose();
  });

  it("leaves the viewer usable after an image failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const graphics = renderer(); const viewer = await createGeantViewer({ renderer: graphics });
    await expect(viewer.install(createGeantSkyImagePlugin())).rejects.toThrow(/HTTP 404/);
    expect(viewer.viewer.getSnapshot().parts).toHaveLength(0);
    viewer.render(); expect(graphics.render).toHaveBeenCalledOnce(); await viewer.dispose();
  });
});
