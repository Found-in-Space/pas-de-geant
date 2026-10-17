import * as THREE from "three";
import type { BodyAppearance, BodyAppearanceContext } from "../body-appearance.js";

export interface SunAppearanceOptions {
  /** Simulation time is the default. Presentation time explicitly permits decorative motion while paused. */
  readonly animationTime?: "simulation" | "presentation";
}

function hash(value: number): number {
  let bits = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b);
  bits = Math.imul(bits ^ bits >>> 13, 0xc2b2ae35);
  return ((bits ^ bits >>> 16) >>> 0) / 0x1_0000_0000;
}

/** Tileable cells with dark intergranular lanes, a per-cell phase and fine grain. */
function granulationTexture(): THREE.DataTexture {
  const size = 256, cells = 8;
  const points = Array.from({ length: cells * cells }, (_, index) => ({
    x: 0.2 + 0.6 * hash(index * 2 + 1), y: 0.2 + 0.6 * hash(index * 2 + 2),
  }));
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) * cells / size, v = (y + 0.5) * cells / size;
    const cellX = Math.floor(u), cellY = Math.floor(v);
    let first = Infinity, second = Infinity, nearest = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = cellX + dx, cy = cellY + dy;
      const index = ((cy + cells) % cells) * cells + (cx + cells) % cells;
      const point = points[index]!;
      const distance = (cx + point.x - u) ** 2 + (cy + point.y - v) ** 2;
      if (distance < first) { second = first; first = distance; nearest = index; }
      else if (distance < second) second = distance;
    }
    const offset = (y * size + x) * 4;
    pixels[offset] = Math.round(255 * Math.min(1, 1.6 * (Math.sqrt(second) - Math.sqrt(first))));
    pixels[offset + 1] = Math.round(255 * hash(nearest + 117));
    pixels[offset + 2] = Math.round(255 * hash(y * size + x + 701));
    pixels[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}

const vertexShader = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 surfaceDirection;
  varying vec3 viewNormal;
  varying vec3 eyeDirection;
  void main() {
    surfaceDirection = position;
    viewNormal = normalMatrix * normal;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    eyeDirection = -viewPosition.xyz;
    gl_Position = projectionMatrix * viewPosition;
    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D granules;
  uniform vec2 warpPhase;
  uniform vec2 drift;
  uniform float boilPhase;
  uniform float activityPhase;
  uniform float haloRadius;
  varying vec3 surfaceDirection;
  varying vec3 viewNormal;
  varying vec3 eyeDirection;

  vec3 cellsAt(vec3 direction) {
    vec3 warp = 0.035 * sin(direction.yzx * 183.0 + direction.zxy * 97.0 + warpPhase.x) +
      0.018 * sin(direction.zxy * 421.0 - direction.xyz * 127.0 - warpPhase.y);
    vec3 p = direction * 42.0 + warp;
    vec3 weights = pow(abs(direction), vec3(8.0));
    weights /= weights.x + weights.y + weights.z;
    // Triplanar sampling keeps cells continuous around the sphere and its poles.
    vec3 x = texture2D(granules, p.yz + vec2(drift.x, -drift.y)).rgb;
    vec3 y = texture2D(granules, p.zx + vec2(-drift.y, drift.x)).rgb;
    vec3 z = texture2D(granules, p.xy + vec2(drift.y, drift.x)).rgb;
    return x * weights.x + y * weights.y + z * weights.z;
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 direction = normalize(surfaceDirection);
    vec3 cells = cellsAt(direction);
    // Each eye supplies its own view transform; no camera-facing billboard.
    float mu = abs(dot(normalize(viewNormal), normalize(eyeDirection)));
    float boil = sin(boilPhase + cells.g * 6.28318530718);
    #ifdef SOLAR_CORONA
      float impact = haloRadius * sqrt(max(0.0, 1.0 - mu * mu));
      float height = max(0.0, impact - 1.0);
      float fade = 1.0 - smoothstep(0.008, haloRadius - 1.0, height);
      float rays = 0.45 + 0.55 * smoothstep(0.1, 0.8, cells.r);
      float alpha = 0.72 * exp(-height * 80.0) * fade * rays * (0.9 + 0.1 * boil);
      gl_FragColor = vec4(1.8, 0.24, 0.012, alpha);
    #else
      float heat = clamp(0.1 + 0.85 * pow(cells.r, 0.55) + 0.06 * boil +
        0.12 * (cells.g - 0.5) + 0.09 * (cells.b - 0.5), 0.0, 1.0);
      float activity = 0.9 + 0.1 * sin(direction.x * 15.0 + direction.z * 9.0) *
        sin(direction.y * 13.0 - activityPhase);
      vec3 colour = mix(vec3(0.95, 0.11, 0.008), vec3(2.7, 0.85, 0.08), heat);
      colour += vec3(0.8, 0.5, 0.15) * pow(heat, 8.0);
      // Darken the photosphere toward the limb; the outer shell supplies glow.
      colour *= activity * (0.35 + 0.65 * pow(mu, 0.45));
      gl_FragColor = vec4(colour, 1.0);
    #endif
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** An illustrative photosphere and corona, independent of placement and ephemerides. */
export function createSunAppearance(context: BodyAppearanceContext, options: SunAppearanceOptions = {}): BodyAppearance {
  context.signal.throwIfAborted();
  const object3d = new THREE.Group(); object3d.name = "sun-appearance";
  const { shape, referenceRadiusM } = context.body;
  if (shape.kind === "sphere") object3d.scale.setScalar(shape.radiusM / referenceRadiusM);
  else object3d.scale.set(shape.equatorialRadiusM / referenceRadiusM, shape.polarRadiusM / referenceRadiusM, shape.equatorialRadiusM / referenceRadiusM);
  const granules = granulationTexture();
  const uniforms = { granules: { value: granules }, warpPhase: { value: new THREE.Vector2() }, drift: { value: new THREE.Vector2() },
    boilPhase: { value: 0 }, activityPhase: { value: 0 }, haloRadius: { value: 1.025 } };
  const geometry = new THREE.SphereGeometry(1, 192, 96);
  const surface = new THREE.ShaderMaterial({ name: "comparison:solar-granulation", uniforms, vertexShader, fragmentShader });
  const corona = new THREE.ShaderMaterial({ name: "comparison:solar-corona", uniforms, vertexShader, fragmentShader,
    defines: { SOLAR_CORONA: 1 }, side: THREE.BackSide, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const photosphere = new THREE.Mesh(geometry, surface); photosphere.name = "solar-photosphere";
  const halo = new THREE.Mesh(geometry, corona); halo.name = "solar-corona";
  halo.scale.setScalar(uniforms.haloRadius.value);
  object3d.add(photosphere, halo);
  return {
    object3d,
    update(frame) {
      const seconds = options.animationTime === "presentation" ? frame.elapsedSeconds : (frame.time.atMs - Date.UTC(2000, 0, 1)) / 1000;
      // Reduce phases in double precision before uploading floats: modern UTC
      // timestamps otherwise lose sub-second motion in GPU float uniforms.
      const wrap = (value: number, period: number) => ((value % period) + period) % period;
      uniforms.warpPhase.value.set(wrap(seconds * 0.21, 2 * Math.PI), wrap(seconds * 0.17, 2 * Math.PI));
      uniforms.drift.value.set(wrap(seconds * 0.004, 1), wrap(seconds * 0.003, 1));
      uniforms.boilPhase.value = wrap(seconds * 0.7, 2 * Math.PI);
      uniforms.activityPhase.value = wrap(seconds * 0.06, 2 * Math.PI);
    },
    dispose() {
      object3d.removeFromParent(); object3d.clear();
      geometry.dispose(); surface.dispose(); corona.dispose(); granules.dispose();
    },
  };
}
