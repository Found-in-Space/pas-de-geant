import {
  Body,
  GeoMoon,
  GeoVector,
  KM_PER_AU,
  Libration,
  MakeTime,
  RotateVector,
  RotationAxis,
  Rotation_EQD_EQJ,
  SiderealTime,
  Vector,
} from "astronomy-engine";
import { loadStarRows } from "@found-in-space/skykit/data";
import {
  createDefaultThreeStarFieldMaterialProfile,
} from "@found-in-space/three-star-field";
import * as THREE from "three";

export const CELESTIAL_SPHERE_RADIUS_M = 520;
export const CELESTIAL_LIMITING_MAGNITUDE = 6.5;
export const CELESTIAL_TIME_STEP_MS = 1_000;
export const CELESTIAL_EPHEMERIS_STEP_MS = 60_000;

const ORIGIN_EPSILON_PC = 1e-9;
const SUN_RADIUS_KM = 695_700;
const MOON_RADIUS_KM = 1_737.4;
const SUN_DISC_RADIUS_UV = 0.18;
const MOON_RENDER_DISTANCE_M = CELESTIAL_SPHERE_RADIUS_M - 1;
const GEOCENTRIC_OBSERVER_APP_ECEF_KM = new THREE.Vector3();
const APP_ECEF_FROM_STANDARD_ECEF = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
  .normalize();

export interface CelestialStarSource {
  positionPc: {
    x: number;
    y: number;
    z: number;
  };
  apparentMagnitude: number | null;
  teffLog8?: number | null;
  temperatureK: number | null;
}

export interface CelestialStarField {
  object3d: THREE.Group;
  count: number;
  dispose(): void;
}

export type CelestialCatalogLoader = () => Promise<
  Iterable<CelestialStarSource>
>;

export type CelestialCatalogLoadResult =
  | { status: "ready"; count: number }
  | { status: "unavailable"; count: 0; error: unknown };

export interface CelestialBodyEphemeris {
  sunDirectionJ2000: { x: number; y: number; z: number };
  moonDirectionJ2000: { x: number; y: number; z: number };
  sunDistanceAu: number;
  moonDistanceAu: number;
  sunAngularRadiusRad: number;
  moonAngularRadiusRad: number;
  moonLibrationLatitudeDeg: number;
  moonLibrationLongitudeDeg: number;
  moonNorthPoleJ2000: { x: number; y: number; z: number };
}

export type CelestialEphemerisProvider = (
  at: Date,
) => CelestialBodyEphemeris;

export function calculateCelestialBodyEphemeris(
  at: Date,
): CelestialBodyEphemeris {
  if (!Number.isFinite(at.getTime())) {
    throw new RangeError(`Invalid celestial-body time: ${at}`);
  }
  const sun = GeoVector(Body.Sun, at, true);
  const moon = GeoMoon(at);
  const sunDistanceAu = Math.hypot(sun.x, sun.y, sun.z);
  const moonDistanceAu = Math.hypot(moon.x, moon.y, moon.z);
  const libration = Libration(at);
  const moonAxis = RotationAxis(Body.Moon, at);

  return {
    sunDirectionJ2000: normalizedDirection(sun.x, sun.y, sun.z),
    moonDirectionJ2000: normalizedDirection(moon.x, moon.y, moon.z),
    sunDistanceAu,
    moonDistanceAu,
    sunAngularRadiusRad: Math.asin(
      SUN_RADIUS_KM / (sunDistanceAu * KM_PER_AU),
    ),
    moonAngularRadiusRad: Math.asin(
      MOON_RADIUS_KM / (moonDistanceAu * KM_PER_AU),
    ),
    moonLibrationLatitudeDeg: libration.elat,
    moonLibrationLongitudeDeg: libration.elon,
    moonNorthPoleJ2000: {
      x: moonAxis.north.x,
      y: moonAxis.north.y,
      z: moonAxis.north.z,
    },
  };
}

class CelestialBodies {
  readonly object3d = new THREE.Group();

  private readonly sunTexture = createSunTexture();
  private readonly sunMaterial = new THREE.SpriteMaterial({
    map: this.sunTexture,
    color: 0xffffff,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  private readonly sun = new THREE.Sprite(this.sunMaterial);
  private readonly moonGeometry = new THREE.SphereGeometry(1, 32, 16);
  private readonly moonMaterial = createMoonMaterial();
  private readonly moon = new THREE.Mesh(
    this.moonGeometry,
    this.moonMaterial,
  );
  private readonly calculateEphemeris: CelestialEphemerisProvider;
  private readonly observerJ2000Au = new THREE.Vector3();
  private readonly sunJ2000Au = new THREE.Vector3();
  private readonly moonJ2000Au = new THREE.Vector3();
  private readonly topocentricSun = new THREE.Vector3();
  private readonly topocentricMoon = new THREE.Vector3();
  private readonly moonToEarth = new THREE.Vector3();
  private readonly moonNorth = new THREE.Vector3();
  private readonly moonWest = new THREE.Vector3();
  private readonly subEarthSurface = new THREE.Vector3();
  private readonly subEarthNorth = new THREE.Vector3();
  private readonly subEarthWest = new THREE.Vector3();
  private readonly surfaceBasis = new THREE.Matrix4();
  private readonly inertialBasis = new THREE.Matrix4();
  private readonly moonOrientation = new THREE.Matrix4();
  private readonly sunFromMoon = new THREE.Vector3();
  private readonly inverseMoonOrientation = new THREE.Quaternion();
  private moonTexture: THREE.Texture | null = null;
  private ephemeris: CelestialBodyEphemeris | null = null;
  private nextEphemerisUpdateMs = Number.NEGATIVE_INFINITY;

  constructor(calculateEphemeris: CelestialEphemerisProvider) {
    this.calculateEphemeris = calculateEphemeris;
    this.object3d.name = "celestial-bodies";
    this.object3d.visible = false;
    this.sun.name = "celestial-sun";
    this.sun.frustumCulled = false;
    this.moon.name = "celestial-moon";
    this.moon.frustumCulled = false;
    this.object3d.add(this.sun, this.moon);
  }

  setMoonTexture(texture: THREE.Texture): void {
    this.moonTexture?.dispose();
    this.moonTexture = texture;
    this.moonMaterial.uniforms.moonMap!.value = texture;
    this.moonMaterial.uniforms.moonTextureReady!.value = 1;
  }

  update(
    utcMilliseconds: number,
    observerAppEcefKm: THREE.Vector3,
    appEcefToJ2000: THREE.Quaternion,
  ): void {
    if (utcMilliseconds >= this.nextEphemerisUpdateMs) {
      this.ephemeris = this.calculateEphemeris(
        new Date(utcMilliseconds),
      );
      this.updateMoonAttitude(this.ephemeris);
      this.nextEphemerisUpdateMs =
        utcMilliseconds + CELESTIAL_EPHEMERIS_STEP_MS;
    }
    const ephemeris = this.ephemeris;
    if (!ephemeris) return;

    this.observerJ2000Au
      .copy(observerAppEcefKm)
      .applyQuaternion(appEcefToJ2000)
      .divideScalar(KM_PER_AU);
    this.sunJ2000Au.set(
      ephemeris.sunDirectionJ2000.x * ephemeris.sunDistanceAu,
      ephemeris.sunDirectionJ2000.y * ephemeris.sunDistanceAu,
      ephemeris.sunDirectionJ2000.z * ephemeris.sunDistanceAu,
    );
    this.moonJ2000Au.set(
      ephemeris.moonDirectionJ2000.x * ephemeris.moonDistanceAu,
      ephemeris.moonDirectionJ2000.y * ephemeris.moonDistanceAu,
      ephemeris.moonDirectionJ2000.z * ephemeris.moonDistanceAu,
    );
    this.topocentricSun
      .subVectors(this.sunJ2000Au, this.observerJ2000Au);
    this.topocentricMoon
      .subVectors(this.moonJ2000Au, this.observerJ2000Au);

    const sunDistanceAu = this.topocentricSun.length();
    this.sun.position
      .copy(this.topocentricSun)
      .multiplyScalar(CELESTIAL_SPHERE_RADIUS_M / sunDistanceAu);
    const sunAngularRadiusRad = Math.asin(
      SUN_RADIUS_KM / (sunDistanceAu * KM_PER_AU),
    );
    const sunDiscDiameterM =
      2 * CELESTIAL_SPHERE_RADIUS_M *
      Math.tan(sunAngularRadiusRad);
    const sunSpriteSizeM = sunDiscDiameterM / (2 * SUN_DISC_RADIUS_UV);
    this.sun.scale.set(sunSpriteSizeM, sunSpriteSizeM, 1);

    const moonDistanceAu = this.topocentricMoon.length();
    this.moon.position
      .copy(this.topocentricMoon)
      .multiplyScalar(MOON_RENDER_DISTANCE_M / moonDistanceAu);
    const moonAngularRadiusRad = Math.asin(
      MOON_RADIUS_KM / (moonDistanceAu * KM_PER_AU),
    );
    this.moon.scale.setScalar(
      MOON_RENDER_DISTANCE_M *
      Math.sin(moonAngularRadiusRad),
    );

    this.object3d.visible = true;
  }

  private updateMoonAttitude(ephemeris: CelestialBodyEphemeris): void {
    lunarSurfaceDirection(
      ephemeris.moonLibrationLongitudeDeg,
      ephemeris.moonLibrationLatitudeDeg,
      this.subEarthSurface,
    );
    lunarNorthTangent(
      ephemeris.moonLibrationLongitudeDeg,
      ephemeris.moonLibrationLatitudeDeg,
      this.subEarthNorth,
    );
    this.subEarthWest
      .crossVectors(this.subEarthSurface, this.subEarthNorth)
      .normalize();
    this.surfaceBasis.makeBasis(
      this.subEarthSurface,
      this.subEarthNorth,
      this.subEarthWest,
    );

    this.moonToEarth.set(
      -ephemeris.moonDirectionJ2000.x,
      -ephemeris.moonDirectionJ2000.y,
      -ephemeris.moonDirectionJ2000.z,
    );
    this.moonNorth.set(
      ephemeris.moonNorthPoleJ2000.x,
      ephemeris.moonNorthPoleJ2000.y,
      ephemeris.moonNorthPoleJ2000.z,
    );
    this.moonNorth.addScaledVector(
      this.moonToEarth,
      -this.moonNorth.dot(this.moonToEarth),
    ).normalize();
    this.moonWest
      .crossVectors(this.moonToEarth, this.moonNorth)
      .normalize();
    this.inertialBasis.makeBasis(
      this.moonToEarth,
      this.moonNorth,
      this.moonWest,
    );
    this.moonOrientation.multiplyMatrices(
      this.inertialBasis,
      this.surfaceBasis.invert(),
    );
    this.moon.quaternion
      .setFromRotationMatrix(this.moonOrientation)
      .normalize();

    this.sunFromMoon.set(
      ephemeris.sunDirectionJ2000.x * ephemeris.sunDistanceAu -
        ephemeris.moonDirectionJ2000.x * ephemeris.moonDistanceAu,
      ephemeris.sunDirectionJ2000.y * ephemeris.sunDistanceAu -
        ephemeris.moonDirectionJ2000.y * ephemeris.moonDistanceAu,
      ephemeris.sunDirectionJ2000.z * ephemeris.sunDistanceAu -
        ephemeris.moonDirectionJ2000.z * ephemeris.moonDistanceAu,
    ).normalize();
    this.inverseMoonOrientation.copy(this.moon.quaternion).invert();
    this.moonMaterial.uniforms.sunDirectionMoonLocal!.value
      .copy(this.sunFromMoon)
      .applyQuaternion(this.inverseMoonOrientation);
  }

  dispose(): void {
    this.object3d.remove(this.sun, this.moon);
    this.sunTexture.dispose();
    this.sunMaterial.dispose();
    this.moonGeometry.dispose();
    this.moonMaterial.dispose();
    this.moonTexture?.dispose();
    this.moonTexture = null;
  }
}

export function createCelestialStarField(
  stars: Iterable<CelestialStarSource>,
): CelestialStarField {
  const positions: number[] = [];
  const teffLog8: number[] = [];
  const fixedRadiusAbsoluteMagnitude: number[] = [];
  const direction = new THREE.Vector3();
  let count = 0;

  for (const star of stars) {
    const magnitude = star.apparentMagnitude;
    if (
      !Number.isFinite(magnitude) ||
      (magnitude as number) > CELESTIAL_LIMITING_MAGNITUDE
    ) {
      continue;
    }
    direction.set(
      star.positionPc.x,
      star.positionPc.y,
      star.positionPc.z,
    );
    const distancePc = direction.length();
    if (!Number.isFinite(distancePc) || distancePc <= ORIGIN_EPSILON_PC) {
      continue;
    }

    direction.multiplyScalar(CELESTIAL_SPHERE_RADIUS_M / distancePc);
    positions.push(direction.x, direction.y, direction.z);
    teffLog8.push(encodedTemperature(star));
    // SkyKit derives apparent magnitude from absolute magnitude and distance.
    // Every celestial-sphere point is one shader parsec away, so mAbs = mApp+5.
    fixedRadiusAbsoluteMagnitude.push((magnitude as number) + 5);
    count += 1;
  }

  const object3d = new THREE.Group();
  object3d.name = "skykit-celestial-sphere";
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute(
    "teff_log8",
    new THREE.BufferAttribute(new Uint8Array(teffLog8), 1, true),
  );
  geometry.setAttribute(
    "magAbs",
    new THREE.Float32BufferAttribute(fixedRadiusAbsoluteMagnitude, 1),
  );
  geometry.computeBoundingSphere();

  const materialProfile = createDefaultThreeStarFieldMaterialProfile({
    observerPosition: { x: 0, y: 0, z: 0 },
    coordinateUnitsPerParsec: CELESTIAL_SPHERE_RADIUS_M,
    limitingMagnitude: CELESTIAL_LIMITING_MAGNITUDE,
    renderScale: 1,
  });
  materialProfile.material.depthTest = true;
  materialProfile.material.depthWrite = false;
  const points = new THREE.Points(geometry, materialProfile.material);
  points.name = "skykit-star-cores";
  points.frustumCulled = false;
  object3d.add(points);

  if (materialProfile.haloMaterial) {
    materialProfile.haloMaterial.depthTest = true;
    materialProfile.haloMaterial.depthWrite = false;
    const halos = new THREE.Points(
      geometry,
      materialProfile.haloMaterial,
    );
    halos.name = "skykit-star-halos";
    halos.frustumCulled = false;
    object3d.add(halos);
  }

  return {
    object3d,
    count,
    dispose() {
      object3d.remove(...object3d.children);
      geometry.dispose();
      materialProfile.dispose?.();
    },
  };
}

export function equatorialJ2000ToAppEcefQuaternion(
  at: Date,
): THREE.Quaternion {
  if (!Number.isFinite(at.getTime())) {
    throw new RangeError(`Invalid celestial-frame time: ${at}`);
  }
  const siderealAngleRad = (SiderealTime(at) * 15 * Math.PI) / 180;
  const standardEcefToJ2000 = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      rotateStandardEcefBasis(at, siderealAngleRad, 1, 0, 0),
      rotateStandardEcefBasis(at, siderealAngleRad, 0, 1, 0),
      rotateStandardEcefBasis(at, siderealAngleRad, 0, 0, 1),
    ),
  );
  return APP_ECEF_FROM_STANDARD_ECEF.clone()
    .multiply(standardEcefToJ2000.invert())
    .normalize();
}

export function celestialToWorldQuaternion(
  earthToWorld: THREE.Quaternion,
  at: Date,
): THREE.Quaternion {
  return earthToWorld
    .clone()
    .multiply(equatorialJ2000ToAppEcefQuaternion(at))
    .normalize();
}

export class CelestialSphere {
  readonly object3d = new THREE.Group();

  private field: CelestialStarField | null = null;
  private readonly loadCatalog: CelestialCatalogLoader;
  private readonly bodies: CelestialBodies;
  private readonly j2000ToAppEcef = new THREE.Quaternion();
  private readonly appEcefToJ2000 = new THREE.Quaternion();
  private nextTimeUpdateMs = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(
    loadCatalog: CelestialCatalogLoader = loadDefaultCatalog,
    calculateEphemeris: CelestialEphemerisProvider =
      calculateCelestialBodyEphemeris,
  ) {
    this.loadCatalog = loadCatalog;
    this.bodies = new CelestialBodies(calculateEphemeris);
    this.object3d.name = "celestial-sphere-root";
    this.object3d.add(this.bodies.object3d);
  }

  async load(): Promise<CelestialCatalogLoadResult> {
    try {
      const stars = await this.loadCatalog();
      if (this.disposed) {
        return {
          status: "unavailable",
          count: 0,
          error: new Error("Celestial sphere was disposed while loading."),
        };
      }
      const field = createCelestialStarField(stars);
      this.field?.dispose();
      if (this.field) this.object3d.remove(this.field.object3d);
      this.field = field;
      this.object3d.add(field.object3d);
      return { status: "ready", count: field.count };
    } catch (error) {
      return { status: "unavailable", count: 0, error };
    }
  }

  setMoonTexture(texture: THREE.Texture): void {
    if (this.disposed) {
      texture.dispose();
      return;
    }
    this.bodies.setMoonTexture(texture);
  }

  update(
    earthToWorld: THREE.Quaternion,
    cameraWorldPosition: THREE.Vector3,
    utcMilliseconds: number,
    observerAppEcefKm: THREE.Vector3 =
      GEOCENTRIC_OBSERVER_APP_ECEF_KM,
  ): void {
    if (utcMilliseconds >= this.nextTimeUpdateMs) {
      this.j2000ToAppEcef.copy(
        equatorialJ2000ToAppEcefQuaternion(new Date(utcMilliseconds)),
      );
      this.appEcefToJ2000.copy(this.j2000ToAppEcef).invert();
      this.nextTimeUpdateMs = utcMilliseconds + CELESTIAL_TIME_STEP_MS;
    }
    this.bodies.update(
      utcMilliseconds,
      observerAppEcefKm,
      this.appEcefToJ2000,
    );
    this.object3d.position.copy(cameraWorldPosition);
    this.object3d.quaternion
      .copy(earthToWorld)
      .multiply(this.j2000ToAppEcef)
      .normalize();
    this.object3d.scale.set(1, 1, 1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.field?.dispose();
    if (this.field) this.object3d.remove(this.field.object3d);
    this.bodies.dispose();
    this.object3d.remove(this.bodies.object3d);
    this.field = null;
    this.disposed = true;
  }
}

async function loadDefaultCatalog(): Promise<
  Iterable<CelestialStarSource>
> {
  return loadStarRows({
    observerPc: { x: 0, y: 0, z: 0 },
    limitingMagnitude: CELESTIAL_LIMITING_MAGNITUDE,
    filterVisible: true,
    persistentCache: "on",
  });
}

function rotateStandardEcefBasis(
  at: Date,
  siderealAngleRad: number,
  x: number,
  y: number,
  z: number,
): THREE.Vector3 {
  const cosine = Math.cos(siderealAngleRad);
  const sine = Math.sin(siderealAngleRad);
  const time = MakeTime(at);
  const equatorialOfDate = new Vector(
    cosine * x - sine * y,
    sine * x + cosine * y,
    z,
    time,
  );
  const equatorialJ2000 = RotateVector(
    Rotation_EQD_EQJ(time),
    equatorialOfDate,
  );
  return new THREE.Vector3(
    equatorialJ2000.x,
    equatorialJ2000.y,
    equatorialJ2000.z,
  );
}

function encodedTemperature(star: CelestialStarSource): number {
  if (Number.isFinite(star.teffLog8)) {
    return Math.round(
      THREE.MathUtils.clamp(star.teffLog8 as number, 0, 255),
    );
  }
  if (Number.isFinite(star.temperatureK)) {
    const temperatureK = THREE.MathUtils.clamp(
      star.temperatureK as number,
      2_000,
      50_000,
    );
    return Math.round(
      THREE.MathUtils.clamp(
        Math.log(temperatureK / 2_000) / Math.log(25) * 255,
        0,
        254,
      ),
    );
  }
  return 255;
}

function normalizedDirection(
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } {
  const length = Math.hypot(x, y, z);
  return { x: x / length, y: y / length, z: z / length };
}

function lunarSurfaceDirection(
  longitudeDegrees: number,
  latitudeDegrees: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
  const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
  const cosineLatitude = Math.cos(latitude);
  return target.set(
    cosineLatitude * Math.cos(longitude),
    Math.sin(latitude),
    -cosineLatitude * Math.sin(longitude),
  );
}

function lunarNorthTangent(
  longitudeDegrees: number,
  latitudeDegrees: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
  const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
  return target.set(
    -Math.sin(latitude) * Math.cos(longitude),
    Math.cos(latitude),
    Math.sin(latitude) * Math.sin(longitude),
  );
}

function createSunTexture(): THREE.DataTexture {
  const size = 128;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const radius = Math.hypot(dx, dy);
      const offset = (y * size + x) * 4;
      if (radius <= SUN_DISC_RADIUS_UV) {
        const centre = 1 - radius / SUN_DISC_RADIUS_UV;
        pixels[offset] = 255;
        pixels[offset + 1] = Math.round(204 + 51 * centre);
        pixels[offset + 2] = Math.round(96 + 159 * centre);
        pixels[offset + 3] = 255;
      } else {
        const glow = Math.max(
          0,
          1 - (radius - SUN_DISC_RADIUS_UV) /
          (0.5 - SUN_DISC_RADIUS_UV),
        ) ** 3;
        pixels[offset] = 255;
        pixels[offset + 1] = 154;
        pixels[offset + 2] = 55;
        pixels[offset + 3] = Math.round(150 * glow);
      }
    }
  }
  const texture = new THREE.DataTexture(
    pixels,
    size,
    size,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.name = "celestial-sun-texture";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createMoonMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      moonMap: { value: null },
      moonTextureReady: { value: 0 },
      sunDirectionMoonLocal: { value: new THREE.Vector3(1, 0, 0) },
    },
    depthTest: true,
    depthWrite: true,
    vertexShader: `
      varying vec2 vMoonUv;
      varying vec3 vNormalMoonLocal;
      void main() {
        vMoonUv = uv;
        vNormalMoonLocal = normalize(normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D moonMap;
      uniform float moonTextureReady;
      uniform vec3 sunDirectionMoonLocal;
      varying vec2 vMoonUv;
      varying vec3 vNormalMoonLocal;

      float surfaceVariation(vec3 normal) {
        float broad = sin(normal.x * 37.0 + normal.z * 19.0) *
          sin(normal.y * 31.0 - normal.z * 23.0);
        float fine = sin(normal.x * 113.0 - normal.y * 79.0) *
          sin(normal.z * 97.0 + normal.y * 53.0);
        return broad * 0.08 + fine * 0.035;
      }

      void main() {
        vec3 normal = normalize(vNormalMoonLocal);
        float sunlight = max(0.0, dot(normal, sunDirectionMoonLocal));
        vec3 proceduralAlbedo = vec3(0.86, 0.88, 0.9) *
          (0.74 + surfaceVariation(normal));
        vec3 rasterAlbedo = texture2D(moonMap, vMoonUv).rgb;
        vec3 albedo = mix(
          proceduralAlbedo,
          rasterAlbedo,
          moonTextureReady
        );
        float brightness = 0.025 + sunlight * 0.975;
        gl_FragColor = vec4(albedo * brightness, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}
