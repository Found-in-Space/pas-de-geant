import * as THREE from "three";
import {
  EARTH_MEAN_RADIUS_KM,
  contactFrame,
  geodeticSurfaceEcefKm,
  normalizedRadialOffsetForKilometres,
  radialWorldMetresForKilometres,
} from "./planet-state.js";

export const ATMOSPHERE_TOP_KM = 100;

const WIDTH_SEGMENTS = 96;
const HEIGHT_SEGMENTS = 48;

export interface AtmosphereView {
  readonly displayRadiusM: number;
  readonly radialMultiplier: number;
  readonly observerHeightWorldM: number;
}

export function observerIsOutsideAtmosphere(
  view: AtmosphereView,
): boolean {
  const atmosphereHeightWorldM = radialWorldMetresForKilometres(
    ATMOSPHERE_TOP_KM,
    view.displayRadiusM,
    view.radialMultiplier,
  );
  return view.radialMultiplier > 0 &&
    view.observerHeightWorldM > atmosphereHeightWorldM;
}

export function atmosphereSurfacePoint(
  latitudeDegrees: number,
  longitudeDegrees: number,
  radialMultiplier: number,
): THREE.Vector3 {
  const normal = contactFrame(
    latitudeDegrees,
    longitudeDegrees,
  ).upEcef;
  return geodeticSurfaceEcefKm(latitudeDegrees, longitudeDegrees)
    .multiplyScalar(1 / EARTH_MEAN_RADIUS_KM)
    .addScaledVector(
      normal,
      normalizedRadialOffsetForKilometres(
        ATMOSPHERE_TOP_KM,
        radialMultiplier,
      ),
    );
}

function atmosphereGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const rowLength = WIDTH_SEGMENTS + 1;

  for (let row = 0; row <= HEIGHT_SEGMENTS; row += 1) {
    const latitude = 90 - row / HEIGHT_SEGMENTS * 180;
    for (let column = 0; column <= WIDTH_SEGMENTS; column += 1) {
      const longitude = -180 + column / WIDTH_SEGMENTS * 360;
      const base = geodeticSurfaceEcefKm(latitude, longitude)
        .multiplyScalar(1 / EARTH_MEAN_RADIUS_KM);
      const normal = contactFrame(latitude, longitude).upEcef;
      positions.push(base.x, base.y, base.z);
      normals.push(normal.x, normal.y, normal.z);
    }
  }

  for (let row = 0; row < HEIGHT_SEGMENTS; row += 1) {
    for (let column = 0; column < WIDTH_SEGMENTS; column += 1) {
      const northWest = row * rowLength + column;
      const southWest = northWest + rowLength;
      indices.push(
        northWest,
        southWest,
        northWest + 1,
        northWest + 1,
        southWest,
        southWest + 1,
      );
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
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export class AtmosphereLayer {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

  constructor() {
    this.mesh = new THREE.Mesh(
      atmosphereGeometry(),
      new THREE.ShaderMaterial({
        uniforms: {
          normalizedAtmosphereOffset: { value: 0 },
        },
        transparent: true,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          uniform float normalizedAtmosphereOffset;
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            vec3 displaced =
              position + normal * normalizedAtmosphereOffset;
            vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
            vNormal = normalize(mat3(modelMatrix) * normal);
            vView = normalize(cameraPosition - worldPosition.xyz);
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
          }
        `,
        fragmentShader: `
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            float rim = pow(
              1.0 - max(0.0, dot(vNormal, vView)),
              3.2
            );
            gl_FragColor =
              vec4(vec3(0.17, 0.55, 0.82) * rim, rim * 0.32);
          }
        `,
      }),
    );
    this.mesh.frustumCulled = false;
  }

  update(view: AtmosphereView): void {
    this.mesh.visible = observerIsOutsideAtmosphere(view);
    this.mesh.material.uniforms.normalizedAtmosphereOffset!.value =
      normalizedRadialOffsetForKilometres(
        ATMOSPHERE_TOP_KM,
        view.radialMultiplier,
      );
  }
}
