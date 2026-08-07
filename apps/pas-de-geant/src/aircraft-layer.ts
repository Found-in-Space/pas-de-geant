import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  extrapolateAircraft,
  type TrackedAircraft,
} from "./aircraft-feed.js";
import {
  EARTH_MEAN_RADIUS_KM,
  geodeticSurfaceEcefKm,
  normalizedRadialOffsetForKilometres,
} from "./planet-state.js";

const MAX_AIRCRAFT = 800;
const AIRCRAFT_SYMBOL_SIZE_M = 0.12;
const FEET_TO_KM = 0.0003048;
const FEET_PER_MINUTE_TO_METRES_PER_SECOND = 0.00508;
const KNOTS_TO_METRES_PER_SECOND = 0.514444;
const STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED = 9.80665;

const LABEL_ATLAS_SIZE = 2_048;
const LABEL_CELL_WIDTH = 128;
const LABEL_CELL_HEIGHT = 40;
const LABEL_COLUMNS = Math.floor(LABEL_ATLAS_SIZE / LABEL_CELL_WIDTH);

const position = new THREE.Vector3();
const normal = new THREE.Vector3();
const east = new THREE.Vector3();
const north = new THREE.Vector3();
const forward = new THREE.Vector3();
const side = new THREE.Vector3();
const scale = new THREE.Vector3();
const rotationMatrix = new THREE.Matrix4();
const quaternion = new THREE.Quaternion();
const attitudeQuaternion = new THREE.Quaternion();
const attitudeEuler = new THREE.Euler(0, 0, 0, "XYZ");
const instanceMatrix = new THREE.Matrix4();

function colouredGeometry(
  geometry: THREE.BufferGeometry,
  colour: THREE.ColorRepresentation,
): THREE.BufferGeometry {
  const transformed = geometry.index ? geometry.toNonIndexed() : geometry;
  const vertexCount = transformed.getAttribute("position").count;
  const color = new THREE.Color(colour);
  const colours = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertexCount; index += 1) {
    color.toArray(colours, index * 3);
  }
  transformed.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  return transformed;
}

function extrudedPlanform(
  points: ReadonlyArray<readonly [number, number]>,
  depth: number,
  colour: THREE.ColorRepresentation,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const [first, ...rest] = points;
  if (!first) throw new Error("Aircraft planform requires at least one point.");
  shape.moveTo(first[0], first[1]);
  for (const point of rest) shape.lineTo(point[0], point[1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -depth / 2);
  return colouredGeometry(geometry, colour);
}

function aircraftGeometry(): THREE.BufferGeometry {
  const fuselage = new THREE.CapsuleGeometry(0.075, 1.12, 3, 8);
  const nose = new THREE.ConeGeometry(0.075, 0.28, 8);
  nose.translate(0, 0.7, 0);

  const wings = extrudedPlanform(
    [
      [-0.065, 0.2],
      [-0.73, -0.12],
      [-0.7, -0.27],
      [-0.075, -0.08],
      [0.075, -0.08],
      [0.7, -0.27],
      [0.73, -0.12],
      [0.065, 0.2],
    ],
    0.035,
    0x5bcfe4,
  );
  const tailplane = extrudedPlanform(
    [
      [-0.045, -0.45],
      [-0.33, -0.59],
      [-0.31, -0.68],
      [-0.04, -0.6],
      [0.04, -0.6],
      [0.31, -0.68],
      [0.33, -0.59],
      [0.045, -0.45],
    ],
    0.03,
    0x69daec,
  );

  const fin = extrudedPlanform(
    [
      [-0.7, 0],
      [-0.58, 0.3],
      [-0.46, 0.25],
      [-0.37, 0],
    ],
    0.035,
    0x50bfd5,
  );
  fin.applyMatrix4(new THREE.Matrix4().set(
    0, 0, 1, 0,
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
  ));

  const leftEngine = new THREE.CapsuleGeometry(0.047, 0.2, 2, 6);
  leftEngine.translate(-0.24, -0.16, -0.055);
  const rightEngine = leftEngine.clone();
  rightEngine.translate(0.48, 0, 0);

  const geometry = mergeGeometries([
    colouredGeometry(fuselage, 0x86efff),
    colouredGeometry(nose, 0xa4f5ff),
    wings,
    tailplane,
    fin,
    colouredGeometry(leftEngine, 0x3299b0),
    colouredGeometry(rightEngine, 0x3299b0),
  ]);
  geometry.computeBoundingSphere();
  return geometry;
}

function labelGeometry(): {
  geometry: THREE.InstancedBufferGeometry;
  positions: THREE.InstancedBufferAttribute;
  uvRects: THREE.InstancedBufferAttribute;
} {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([
      0.07, -0.005, 0,
      0.24, -0.005, 0,
      0.24, 0.055, 0,
      0.07, 0.055, 0,
    ], 3),
  );
  geometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ], 2),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const positions = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_AIRCRAFT * 3),
    3,
  );
  positions.setUsage(THREE.DynamicDrawUsage);
  const uvRects = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_AIRCRAFT * 4),
    4,
  );
  geometry.setAttribute("instancePosition", positions);
  geometry.setAttribute("instanceUvRect", uvRects);
  geometry.instanceCount = 0;
  return { geometry, positions, uvRects };
}

function createLabelAtlas(): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
} {
  const canvas = document.createElement("canvas");
  canvas.width = LABEL_ATLAS_SIZE;
  canvas.height = LABEL_ATLAS_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas labels are unavailable.");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return { canvas, context, texture };
}

function labelMaterial(texture: THREE.CanvasTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      labelAtlas: { value: texture },
    },
    vertexShader: `
      attribute vec3 instancePosition;
      attribute vec4 instanceUvRect;
      varying vec2 vLabelUv;

      void main() {
        vec4 viewAnchor = viewMatrix * modelMatrix * vec4(instancePosition, 1.0);
        viewAnchor.xy += position.xy;
        gl_Position = projectionMatrix * viewAnchor;
        vLabelUv = mix(instanceUvRect.xy, instanceUvRect.zw, uv);
      }
    `,
    fragmentShader: `
      uniform sampler2D labelAtlas;
      varying vec2 vLabelUv;

      void main() {
        vec4 colour = texture2D(labelAtlas, vLabelUv);
        if (colour.a < 0.035) discard;
        gl_FragColor = colour;
      }
    `,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

function drawRoundedRectangle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius,
    y + height,
  );
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function fitLabelFont(
  context: CanvasRenderingContext2D,
  text: string,
  maximumWidth: number,
): void {
  for (let size = 16; size >= 11; size -= 1) {
    context.font = `700 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    if (context.measureText(text).width <= maximumWidth) return;
  }
}

export function formatAircraftLabel(aircraft: TrackedAircraft): {
  primary: string;
  secondary: string;
} {
  const flightLevel = Math.max(0, Math.round(aircraft.altitudeFt / 100));
  const speed = Math.max(0, Math.round(aircraft.groundSpeedKt));
  const heading = Math.round(
    ((aircraft.headingDegrees % 360) + 360) % 360,
  );
  return {
    primary: aircraft.callsign.toUpperCase(),
    secondary:
      `FL${String(flightLevel).padStart(3, "0")} ` +
      `${speed}KT ${String(heading).padStart(3, "0")}°`,
  };
}

export function aircraftRenderAttitude(aircraft: TrackedAircraft): {
  pitchDegrees: number;
  rollDegrees: number;
} {
  const horizontalSpeed =
    aircraft.groundSpeedKt * KNOTS_TO_METRES_PER_SECOND;
  const pitchDegrees = horizontalSpeed > 0
    ? THREE.MathUtils.radToDeg(Math.atan2(
        aircraft.verticalRateFeetPerMinute *
          FEET_PER_MINUTE_TO_METRES_PER_SECOND,
        horizontalSpeed,
      ))
    : 0;
  const estimatedRollDegrees = THREE.MathUtils.radToDeg(Math.atan(
    horizontalSpeed * THREE.MathUtils.degToRad(
      aircraft.trackRateDegreesPerSecond,
    ) / STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED,
  ));
  return {
    pitchDegrees,
    rollDegrees: aircraft.rollDegrees ?? estimatedRollDegrees,
  };
}

export function aircraftNormalizedAltitude(
  altitudeFt: number,
  radialMultiplier: number,
): number {
  return normalizedRadialOffsetForKilometres(
    Math.max(0, altitudeFt) * FEET_TO_KM,
    radialMultiplier,
  );
}

export class AircraftLayer {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly labelMesh: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  private readonly labelPositions: THREE.InstancedBufferAttribute;
  private readonly labelUvRects: THREE.InstancedBufferAttribute;
  private readonly labelCanvas: HTMLCanvasElement;
  private readonly labelContext: CanvasRenderingContext2D;
  private readonly labelTexture: THREE.CanvasTexture;
  private aircraft: TrackedAircraft[] = [];

  constructor() {
    this.mesh = new THREE.InstancedMesh(
      aircraftGeometry(),
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
      }),
      MAX_AIRCRAFT,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.count = 0;

    const labels = labelGeometry();
    const atlas = createLabelAtlas();
    this.labelPositions = labels.positions;
    this.labelUvRects = labels.uvRects;
    this.labelCanvas = atlas.canvas;
    this.labelContext = atlas.context;
    this.labelTexture = atlas.texture;
    this.labelMesh = new THREE.Mesh(
      labels.geometry,
      labelMaterial(atlas.texture),
    );
    this.labelMesh.frustumCulled = false;
    this.labelMesh.renderOrder = 13;
    this.labelMesh.visible = false;

    this.group.add(this.mesh, this.labelMesh);
  }

  setAircraft(aircraft: TrackedAircraft[]): void {
    this.aircraft = aircraft.slice(0, MAX_AIRCRAFT);
    this.redrawLabelAtlas();
  }

  set visible(value: boolean) {
    this.group.visible = value;
  }

  set symbolsVisible(value: boolean) {
    this.mesh.visible = value;
  }

  set labelsVisible(value: boolean) {
    this.labelMesh.visible = value;
  }

  update(
    atMs: number,
    displayRadiusM: number,
    radialMultiplier: number,
  ): void {
    if (!this.group.visible) return;
    const symbolScale = AIRCRAFT_SYMBOL_SIZE_M / displayRadiusM;
    let count = 0;
    for (const report of this.aircraft) {
      const aircraft = extrapolateAircraft(report, atMs);
      const latitude = THREE.MathUtils.degToRad(aircraft.latitudeDegrees);
      const longitude = THREE.MathUtils.degToRad(aircraft.longitudeDegrees);

      position.copy(
        geodeticSurfaceEcefKm(
          aircraft.latitudeDegrees,
          aircraft.longitudeDegrees,
        ),
      ).multiplyScalar(1 / EARTH_MEAN_RADIUS_KM);
      normal.set(
        Math.cos(latitude) * Math.cos(longitude),
        Math.sin(latitude),
        -Math.cos(latitude) * Math.sin(longitude),
      );
      position.addScaledVector(
        normal,
        aircraftNormalizedAltitude(aircraft.altitudeFt, radialMultiplier),
      );

      east.set(-Math.sin(longitude), 0, -Math.cos(longitude)).normalize();
      north.set(
        -Math.sin(latitude) * Math.cos(longitude),
        Math.cos(latitude),
        Math.sin(latitude) * Math.sin(longitude),
      ).normalize();
      const heading = THREE.MathUtils.degToRad(aircraft.headingDegrees);
      forward.copy(north)
        .multiplyScalar(Math.cos(heading))
        .addScaledVector(east, Math.sin(heading))
        .normalize();
      side.crossVectors(forward, normal).normalize();
      rotationMatrix.makeBasis(side, forward, normal);
      quaternion.setFromRotationMatrix(rotationMatrix);
      const attitude = aircraftRenderAttitude(aircraft);
      attitudeEuler.set(
        THREE.MathUtils.degToRad(attitude.pitchDegrees),
        THREE.MathUtils.degToRad(attitude.rollDegrees),
        0,
      );
      attitudeQuaternion.setFromEuler(attitudeEuler);
      quaternion.multiply(attitudeQuaternion);
      scale.setScalar(symbolScale);
      instanceMatrix.compose(position, quaternion, scale);
      this.mesh.setMatrixAt(count, instanceMatrix);
      this.labelPositions.setXYZ(count, position.x, position.y, position.z);
      count += 1;
    }
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.labelMesh.geometry.instanceCount = count;
    this.labelPositions.needsUpdate = true;
  }

  private redrawLabelAtlas(): void {
    this.labelContext.clearRect(
      0,
      0,
      this.labelCanvas.width,
      this.labelCanvas.height,
    );
    for (let index = 0; index < this.aircraft.length; index += 1) {
      const column = index % LABEL_COLUMNS;
      const row = Math.floor(index / LABEL_COLUMNS);
      const x = column * LABEL_CELL_WIDTH;
      const y = row * LABEL_CELL_HEIGHT;
      const label = formatAircraftLabel(this.aircraft[index]!);

      this.labelContext.strokeStyle = "rgba(119, 229, 248, 0.88)";
      this.labelContext.lineWidth = 1;
      this.labelContext.beginPath();
      this.labelContext.moveTo(x + 1, y + LABEL_CELL_HEIGHT / 2);
      this.labelContext.lineTo(x + 11, y + LABEL_CELL_HEIGHT / 2);
      this.labelContext.stroke();
      this.labelContext.fillStyle = "rgba(119, 229, 248, 0.96)";
      this.labelContext.fillRect(x, y + LABEL_CELL_HEIGHT / 2 - 1, 3, 3);

      drawRoundedRectangle(
        this.labelContext,
        x + 10.5,
        y + 1.5,
        LABEL_CELL_WIDTH - 12,
        LABEL_CELL_HEIGHT - 3,
        3,
      );
      this.labelContext.fillStyle = "rgba(2, 13, 21, 0.86)";
      this.labelContext.fill();
      this.labelContext.strokeStyle = "rgba(119, 229, 248, 0.62)";
      this.labelContext.stroke();

      this.labelContext.textBaseline = "alphabetic";
      this.labelContext.fillStyle = "#eafcff";
      fitLabelFont(
        this.labelContext,
        label.primary,
        LABEL_CELL_WIDTH - 19,
      );
      this.labelContext.fillText(label.primary, x + 15, y + 17);
      this.labelContext.font =
        "500 10px ui-monospace, SFMono-Regular, Menlo, monospace";
      this.labelContext.fillStyle = "#81d8e9";
      this.labelContext.fillText(label.secondary, x + 15, y + 32);

      const minimumU = x / LABEL_ATLAS_SIZE;
      const minimumV = 1 - (y + LABEL_CELL_HEIGHT) / LABEL_ATLAS_SIZE;
      const maximumU = (x + LABEL_CELL_WIDTH) / LABEL_ATLAS_SIZE;
      const maximumV = 1 - y / LABEL_ATLAS_SIZE;
      this.labelUvRects.setXYZW(
        index,
        minimumU,
        minimumV,
        maximumU,
        maximumV,
      );
    }
    this.labelUvRects.needsUpdate = true;
    this.labelTexture.needsUpdate = true;
  }
}
