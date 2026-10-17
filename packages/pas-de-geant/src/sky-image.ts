import * as THREE from "three";
import type { SkykitPlugin } from "./skykit-runtime.js";
import { getGeantContext } from "./viewer.js";
import { j2000ToWorldQuaternion } from "./worlds/stellar-coordinate-frame.js";
import { backgroundRenderHooks } from "./plugins/background-render.js";

const SKY_IMAGE_BASE = "https://data.foundin.space/textures/sky/deep-star-maps-2020/20261017.2/";
const POLAR_EXTENT = Math.tan(35 * Math.PI / 180);

export interface GeantSkyImagePolarCaps {
  /** Gnomonic images with a 35-degree half-angle; +J2000 X right, +Y top.
   * Centred on +Z (north) and -Z (south). Supplied textures remain caller-owned. */
  readonly north: string | URL | THREE.Texture;
  readonly south: string | URL | THREE.Texture;
}

export interface GeantSkyImageOptions {
  /** A celestial plate-carree image: RA 0 at centre, RA increasing left, north at top.
   * Defaults to the immutable catalog publication on data.foundin.space. */
  readonly url?: string | URL;
  /** Borrow an already decoded texture instead of fetching an image. The caller owns it. */
  readonly texture?: THREE.Texture;
  /** Matching caps; included for the default map, omitted for custom maps unless supplied.
   * Set false to sample only the main map. Caps blend in at absolute declination 60–65°. */
  readonly polarCaps?: GeantSkyImagePolarCaps | false;
  readonly signal?: AbortSignal;
}

/** Deep Star Maps 2020 celestial projection; v=1 is the top of the image. */
export function deepStarMapUv(directionJ2000: { x: number; y: number; z: number }): THREE.Vector2 {
  const { x, y, z } = directionJ2000;
  return new THREE.Vector2(0.5 - Math.atan2(y, x) / (2 * Math.PI),
    0.5 + Math.atan2(z, Math.hypot(x, y)) / Math.PI);
}

/** Gnomonic cap UV for either pole; +J2000 X right, +Y top, image top at v=1. */
export function deepStarMapPolarUv(directionJ2000: { x: number; y: number; z: number }): THREE.Vector2 {
  const { x, y, z } = directionJ2000;
  return new THREE.Vector2(0.5 + x / (2 * Math.abs(z) * POLAR_EXTENT),
    0.5 + y / (2 * Math.abs(z) * POLAR_EXTENT));
}

/** Static, infinitely distant sky. Construction and import perform no acquisition. */
export function createGeantSkyImagePlugin(options: GeantSkyImageOptions = {}): SkykitPlugin {
  return { id: "geant:sky-image", async setup(context) {
    const geant = getGeantContext(context);
    const abort = new AbortController();
    const ownedTextures = new Set<THREE.Texture>();
    let geometry: THREE.BufferGeometry | undefined;
    let material: THREE.ShaderMaterial | undefined;
    let remove: (() => void) | undefined;
    let disposed = false;
    const cancel = () => { abort.abort(options.signal?.reason); dispose(); };
    const dispose = () => {
      if (disposed) return;
      disposed = true; abort.abort(); remove?.();
      options.signal?.removeEventListener("abort", cancel);
      geometry?.dispose(); material?.dispose();
      for (const texture of ownedTextures) texture.dispose();
      ownedTextures.clear();
    };
    context.addDisposable(dispose);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      abort.signal.throwIfAborted();
      const acquire = async (source: string | URL | THREE.Texture, repeatLongitude: boolean) => {
        if (source instanceof THREE.Texture) return source;
        const texture = await loadTexture(source, abort.signal, repeatLongitude);
        if (disposed || abort.signal.aborted) { texture.dispose(); abort.signal.throwIfAborted(); }
        ownedTextures.add(texture);
        return texture;
      };
      const caps = options.polarCaps === false ? undefined : options.polarCaps ??
        (options.url === undefined && options.texture === undefined ? {
          north: SKY_IMAGE_BASE + "deep-star-map-2020-north-1024.webp",
          south: SKY_IMAGE_BASE + "deep-star-map-2020-south-1024.webp",
        } : undefined);
      const [texture, north, south] = await Promise.all([
        acquire(options.texture ?? options.url ?? SKY_IMAGE_BASE + "deep-star-map-2020-4k.webp", true),
        caps ? acquire(caps.north, false) : undefined,
        caps ? acquire(caps.south, false) : undefined,
      ]);
      abort.signal.throwIfAborted();
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
      material = new THREE.ShaderMaterial({
        uniforms: { skyMap: { value: texture },
          ...(caps ? { skyNorth: { value: north }, skySouth: { value: south } } : {}),
          skyProjectionInverse: { value: new THREE.Matrix4() }, skyViewToJ2000: { value: new THREE.Matrix3() } },
        defines: caps ? { SKY_POLAR_CAPS: 1 } : {},
        depthTest: false, depthWrite: false, toneMapped: false,
        vertexShader: `uniform mat4 skyProjectionInverse;
          uniform mat3 skyViewToJ2000;
          varying vec3 skyDirection;
          void main() {
            // Use each eye's orientation and projection, without its translation.
            skyDirection = skyViewToJ2000 * (skyProjectionInverse * vec4(position.xy, 1.0, 1.0)).xyz;
            gl_Position = vec4(position.xy, 1.0, 1.0);
          }`,
        fragmentShader: `uniform sampler2D skyMap;
          #ifdef SKY_POLAR_CAPS
          uniform sampler2D skyNorth;
          uniform sampler2D skySouth;
          #endif
          varying vec3 skyDirection;
          void main() {
            vec3 d = normalize(skyDirection);
            float longitude = dot(d.xy, d.xy) > 0.0 ? atan(d.y, d.x) : 0.0;
            vec2 uv = vec2(0.5 - longitude / 6.283185307179586,
              0.5 + atan(d.z, length(d.xy)) / 3.141592653589793);
            // Longitude wraps at the seam; a whole-map derivative would select
            // the wrong mip level and create a blurred stripe in the sky.
            vec2 dx = dFdx(uv), dy = dFdy(uv);
            dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);
            vec3 color = texture2DGradEXT(skyMap, uv, dx, dy).rgb;
            #ifdef SKY_POLAR_CAPS
            // A regular projection at each pole gives the caps their own mip
            // footprint. Keep the unused equatorial coordinates finite too.
            vec2 capUv = 0.5 + 0.5 * d.xy / (max(abs(d.z), 0.5) * ${POLAR_EXTENT});
            vec2 capDx = dFdx(capUv), capDy = dFdy(capUv);
            vec3 cap = d.z >= 0.0
              ? texture2DGradEXT(skyNorth, capUv, capDx, capDy).rgb
              : texture2DGradEXT(skySouth, capUv, capDx, capDy).rgb;
            float polarWeight = smoothstep(${Math.sin(Math.PI / 3)}, ${Math.sin(65 * Math.PI / 180)}, abs(d.z));
            color = mix(color, cap, polarWeight);
            #endif
            gl_FragColor = vec4(color, 1.0);
            #include <colorspace_fragment>
          }`,
      });
      const sky = new THREE.Mesh(geometry, material);
      sky.name = "geant:sky-image"; sky.frustumCulled = false;
      const viewToJ2000 = new THREE.Matrix4();
      sky.onBeforeRender = (_renderer, _scene, camera) => {
        // Three calls this with the actual eye camera during WebXR rendering.
        material!.uniforms.skyProjectionInverse!.value.copy(camera.projectionMatrixInverse);
        viewToJ2000.makeRotationFromQuaternion(sky.quaternion).invert().multiply(camera.matrixWorld);
        material!.uniforms.skyViewToJ2000!.value.setFromMatrix4(viewToJ2000);
      };
      const scene = new THREE.Scene(); scene.add(sky);
      const hooks = backgroundRenderHooks(geant.renderer, () => {
        j2000ToWorldQuaternion(geant.presentation.systemRotation, sky.quaternion);
        geant.renderer.render(scene, geant.camera);
      });
      remove = context.addPart({ id: "geant:sky-image", priority: -100,
        ...hooks,
        getSnapshot: () => ({ source: options.texture ? "host texture" : options.url ? String(options.url) : "Deep Star Maps 2020", static: true, polarCaps: !!caps }),
      });
      return dispose;
    } catch (error) { dispose(); throw error; }
  } };
}

async function loadTexture(url: string | URL, signal: AbortSignal, repeatLongitude: boolean): Promise<THREE.Texture> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Sky image unavailable (HTTP ${response.status}).`);
  // ImageBitmap ignores Texture.flipY; flip during decoding instead.
  const bitmap = await createImageBitmap(await response.blob(), {
    imageOrientation: "flipY", colorSpaceConversion: "none", premultiplyAlpha: "none",
  });
  if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
  const texture = new THREE.Texture(bitmap);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = repeatLongitude ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  texture.addEventListener("dispose", () => bitmap.close());
  return texture;
}
