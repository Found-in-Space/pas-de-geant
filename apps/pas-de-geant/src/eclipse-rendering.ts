import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  MOON_RADIUS_KM,
  SUN_RADIUS_KM,
  WGS84_A_KM,
  WGS84_B_KM,
  type CartesianVector,
} from "@found-in-space/shadowline";
import type { CartesianBasis } from "./eclipse-types.js";

export const VISIBLE_SUN_FAR_M = 1_200;
export const WGS84_DISPLAY_AXES = new THREE.Vector3(
  WGS84_A_KM / EARTH_MEAN_RADIUS_KM,
  WGS84_B_KM / EARTH_MEAN_RADIUS_KM,
  WGS84_A_KM / EARTH_MEAN_RADIUS_KM,
);

const WGS84_ECCENTRICITY_SQUARED =
  1 - WGS84_B_KM * WGS84_B_KM / (WGS84_A_KM * WGS84_A_KM);

export function ecefKmToDisplay(value: CartesianVector): THREE.Vector3 {
  return new THREE.Vector3(
    value.x / EARTH_MEAN_RADIUS_KM,
    value.z / EARTH_MEAN_RADIUS_KM,
    -value.y / EARTH_MEAN_RADIUS_KM,
  );
}

export function displayDirection(value: CartesianVector): THREE.Vector3 {
  return new THREE.Vector3(value.x, value.z, -value.y).normalize();
}

export function ecefToInertialMatrix(basis: CartesianBasis): THREE.Matrix4 {
  const localX = displayDirection(basis.x);
  const localY = displayDirection(basis.z);
  const localZ = displayDirection(basis.y).multiplyScalar(-1);
  return new THREE.Matrix4().makeBasis(localX, localY, localZ);
}

export function sunAlignedStageOrientation(
  earthFromSun: THREE.Vector3,
): THREE.Matrix4 {
  const stageX = earthFromSun.clone().normalize();
  const inertialNorth = new THREE.Vector3(0, 1, 0);
  let stageY = inertialNorth
    .clone()
    .addScaledVector(stageX, -inertialNorth.dot(stageX));
  if (stageY.lengthSq() < 1e-8) {
    stageY = new THREE.Vector3(0, 0, 1).addScaledVector(stageX, -stageX.z);
  }
  stageY.normalize();
  const stageZ = new THREE.Vector3().crossVectors(stageX, stageY).normalize();
  return new THREE.Matrix4().set(
    stageX.x, stageX.y, stageX.z, 0,
    stageY.x, stageY.y, stageY.z, 0,
    stageZ.x, stageZ.y, stageZ.z, 0,
    0, 0, 0, 1,
  );
}

export function createGeodeticEllipsoidGeometry(
  longitudeSegments: number,
  latitudeSegments: number,
  altitudeKm = 0,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const rowLength = longitudeSegments + 1;
  for (let row = 0; row <= latitudeSegments; row += 1) {
    const latitude = Math.PI / 2 - row / latitudeSegments * Math.PI;
    const sineLatitude = Math.sin(latitude);
    const cosineLatitude = Math.cos(latitude);
    const primeVerticalRadius = WGS84_A_KM / Math.sqrt(
      1 - WGS84_ECCENTRICITY_SQUARED * sineLatitude * sineLatitude,
    );
    for (let column = 0; column <= longitudeSegments; column += 1) {
      const longitude = -Math.PI + column / longitudeSegments * Math.PI * 2;
      const radialKm = (primeVerticalRadius + altitudeKm) * cosineLatitude;
      const position = ecefKmToDisplay({
        x: radialKm * Math.cos(longitude),
        y: radialKm * Math.sin(longitude),
        z:
          (primeVerticalRadius * (1 - WGS84_ECCENTRICITY_SQUARED) + altitudeKm) *
          sineLatitude,
      });
      positions.push(position.x, position.y, position.z);
      normals.push(
        cosineLatitude * Math.cos(longitude),
        sineLatitude,
        -cosineLatitude * Math.sin(longitude),
      );
      uvs.push(column / longitudeSegments, 1 - row / latitudeSegments);
    }
  }
  for (let row = 0; row < latitudeSegments; row += 1) {
    for (let column = 0; column < longitudeSegments; column += 1) {
      const northWest = row * rowLength + column;
      const southWest = northWest + rowLength;
      const southEast = southWest + 1;
      const northEast = northWest + 1;
      if (row !== 0) indices.push(northWest, southWest, northEast);
      if (row !== latitudeSegments - 1) {
        indices.push(southWest, southEast, northEast);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(normals, 3),
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export function perpendicularBasis(
  axis: THREE.Vector3,
): [THREE.Vector3, THREE.Vector3] {
  const reference = Math.abs(axis.y) < 0.82
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const first = new THREE.Vector3().crossVectors(axis, reference).normalize();
  const second = new THREE.Vector3().crossVectors(axis, first).normalize();
  return [first, second];
}

interface ConeUpdate {
  moonPosition: THREE.Vector3;
  shadowAxis: THREE.Vector3;
  displayLength: number;
  centralConeSlope: number;
  penumbraConeSlope: number;
  coneToEarthFixed: THREE.Matrix4;
}

class RetainedConeSurface {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

  private readonly radialSegments = 96;
  private readonly lengthSegments = 48;
  private readonly positions: Float32Array;
  private readonly rayOrigins: Float32Array;
  private readonly coneToEarthFixed = new THREE.Matrix4();

  constructor(
    color: number,
    opacity: number,
  ) {
    const vertexCount =
      (this.radialSegments + 1) * (this.lengthSegments + 1);
    this.positions = new Float32Array(vertexCount * 3);
    this.rayOrigins = new Float32Array(vertexCount * 3);
    const indices: number[] = [];
    const row = this.radialSegments + 1;
    for (let along = 0; along < this.lengthSegments; along += 1) {
      for (let radial = 0; radial < this.radialSegments; radial += 1) {
        const index = along * row + radial;
        const next = index + row;
        indices.push(index, next, index + 1, next, next + 1, index + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3),
    );
    geometry.setAttribute(
      "coneRayOrigin",
      new THREE.BufferAttribute(this.rayOrigins, 3),
    );
    geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    material.onBeforeCompile = (shader) => {
      shader.uniforms["coneToEarthFixed"] = {
        value: this.coneToEarthFixed,
      };
      shader.uniforms["wgs84DisplayAxes"] = { value: WGS84_DISPLAY_AXES };
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
attribute vec3 coneRayOrigin;
varying vec3 vConeRayOrigin;
varying vec3 vConePosition;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
vConeRayOrigin = coneRayOrigin;
vConePosition = transformed;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
uniform mat4 coneToEarthFixed;
uniform vec3 wgs84DisplayAxes;
varying vec3 vConeRayOrigin;
varying vec3 vConePosition;`,
        )
        .replace(
          "#include <clipping_planes_fragment>",
          `#include <clipping_planes_fragment>
vec3 earthFixedStart =
  ( coneToEarthFixed * vec4( vConeRayOrigin, 1.0 ) ).xyz;
vec3 earthFixedEnd =
  ( coneToEarthFixed * vec4( vConePosition, 1.0 ) ).xyz;
vec3 ellipsoidStart = earthFixedStart / wgs84DisplayAxes;
vec3 ellipsoidDelta = ( earthFixedEnd - earthFixedStart ) / wgs84DisplayAxes;
float segmentA = dot( ellipsoidDelta, ellipsoidDelta );
float segmentB = 2.0 * dot( ellipsoidStart, ellipsoidDelta );
float segmentC = dot( ellipsoidStart, ellipsoidStart ) - 1.0;
float discriminant = segmentB * segmentB - 4.0 * segmentA * segmentC;
if ( segmentA > 0.0 && discriminant >= 0.0 ) {
  float root = sqrt( discriminant );
  float entry = ( -segmentB - root ) / ( 2.0 * segmentA );
  float exit = ( -segmentB + root ) / ( 2.0 * segmentA );
  if (
    ( entry > 0.00001 && entry < 0.9995 ) ||
    ( exit > 0.00001 && exit < 0.9995 )
  ) discard;
}`,
        );
    };
    material.customProgramCacheKey = () => "pas-de-geant-eclipse-cone-v1";
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  update(options: ConeUpdate, slope: number): void {
    this.coneToEarthFixed.copy(options.coneToEarthFixed);
    const [first, second] = perpendicularBasis(options.shadowAxis);
    const row = this.radialSegments + 1;
    for (let alongIndex = 0; alongIndex <= this.lengthSegments; alongIndex += 1) {
      const along = options.displayLength * alongIndex / this.lengthSegments;
      const signedPhysicalRadiusKm =
        MOON_RADIUS_KM + slope * along * EARTH_MEAN_RADIUS_KM;
      const displayRadius =
        Math.abs(signedPhysicalRadiusKm) / EARTH_MEAN_RADIUS_KM;
      const moonRadiusDirection = Math.sign(signedPhysicalRadiusKm) || 1;
      const centre = options.moonPosition
        .clone()
        .addScaledVector(options.shadowAxis, along);
      for (let radialIndex = 0; radialIndex <= this.radialSegments; radialIndex += 1) {
        const angle = radialIndex / this.radialSegments * Math.PI * 2;
        const radialDirection = first
          .clone()
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(second, Math.sin(angle));
        const point = centre.clone().addScaledVector(radialDirection, displayRadius);
        const rayOrigin = options.moonPosition.clone().addScaledVector(
          radialDirection,
          moonRadiusDirection * MOON_RADIUS_KM / EARTH_MEAN_RADIUS_KM,
        );
        const offset = (alongIndex * row + radialIndex) * 3;
        this.positions.set([point.x, point.y, point.z], offset);
        this.rayOrigins.set([rayOrigin.x, rayOrigin.y, rayOrigin.z], offset);
      }
    }
    this.mesh.geometry.getAttribute("position").needsUpdate = true;
    this.mesh.geometry.getAttribute("coneRayOrigin").needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class RetainedShadowCones {
  readonly group = new THREE.Group();

  private readonly penumbra = new RetainedConeSurface(
    0xf2b94d,
    0.13,
  );
  private readonly central = new RetainedConeSurface(
    0x9d7cff,
    0.26,
  );

  constructor() {
    this.group.name = "eclipse-shadow-cones";
    this.group.add(this.penumbra.mesh, this.central.mesh);
  }

  update(options: ConeUpdate): void {
    this.penumbra.update(options, options.penumbraConeSlope);
    this.central.update(options, options.centralConeSlope);
  }

  dispose(): void {
    this.penumbra.dispose();
    this.central.dispose();
    this.group.remove(...this.group.children);
  }
}

export class EclipseFootprints {
  readonly group = new THREE.Group();

  update(
    penumbraRings: CartesianVector[][],
    centralRings: CartesianVector[][],
  ): void {
    this.clear();
    for (const ring of penumbraRings) this.addRing(ring, 0x7ee7f2);
    for (const ring of centralRings) this.addRing(ring, 0xd1c5ff);
  }

  dispose(): void {
    this.clear();
  }

  private addRing(ring: CartesianVector[], color: number): void {
    if (ring.length < 3) return;
    const points = ring.map((point) =>
      ecefKmToDisplay(point).multiplyScalar(1.002)
    );
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const line = new THREE.LineLoop(geometry, material);
    line.renderOrder = 5;
    this.group.add(line);
  }

  private clear(): void {
    for (const child of [...this.group.children]) {
      const line = child as THREE.Line<
        THREE.BufferGeometry,
        THREE.LineBasicMaterial
      >;
      line.geometry.dispose();
      line.material.dispose();
      this.group.remove(line);
    }
  }
}

function createSunTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas textures are unavailable.");
  const glow = context.createRadialGradient(128, 128, 6, 128, 128, 128);
  glow.addColorStop(0, "rgba(255,255,242,1)");
  glow.addColorStop(0.43, "rgba(255,224,138,1)");
  glow.addColorStop(0.5, "rgba(255,184,70,0.98)");
  glow.addColorStop(0.58, "rgba(255,177,62,0.24)");
  glow.addColorStop(0.77, "rgba(255,143,38,0.06)");
  glow.addColorStop(1, "rgba(255,120,24,0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class VisibleSun {
  readonly object: THREE.Sprite;

  private readonly distanceM = 650;
  private readonly cameraPosition = new THREE.Vector3();

  constructor() {
    this.object = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: createSunTexture(),
        transparent: true,
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.object.renderOrder = -5;
  }

  update(
    camera: THREE.Camera,
    direction: THREE.Vector3,
    angularRadiusRad: number,
  ): void {
    camera.getWorldPosition(this.cameraPosition);
    this.object.position
      .copy(this.cameraPosition)
      .addScaledVector(direction, this.distanceM);
    const planeSize = 4 * this.distanceM * Math.tan(angularRadiusRad);
    this.object.scale.set(planeSize, planeSize, 1);
  }

  dispose(): void {
    const material = this.object.material;
    material.map?.dispose();
    material.dispose();
  }
}
