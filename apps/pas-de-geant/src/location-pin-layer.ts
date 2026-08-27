import * as THREE from "three";
import {
  contactFrame,
  EARTH_MEAN_RADIUS_KM,
  geodeticSurfaceEcefKm,
  normalizedBodyLocalRadialOffset,
} from "./planet-state.js";
import { EARTH_SURFACE_MODEL } from "./surface-model.js";
import {
  formatLocationPinDistance,
  greatCircleDistanceKm,
  locationPinAngularHeightDegrees,
  worldHeightForAngularSize,
  type LocationPin,
  type LocationPinState,
} from "./location-pin.js";

const PIN_TEXTURE_WIDTH = 768;
const PIN_TEXTURE_HEIGHT = 256;
const PIN_TEXTURE_ASPECT = PIN_TEXTURE_WIDTH / PIN_TEXTURE_HEIGHT;
const PIN_TIP_X = 92;
const PIN_TIP_Y = 235;
const HUD_DISTANCE_M = 1.4;

interface PinRenderable {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.SpriteMaterial;
  readonly sprite: THREE.Sprite;
  signature: string;
}

interface GuidanceRenderable {
  readonly arrow: THREE.Sprite;
  readonly label: PinRenderable;
}

export interface LocationPinLayerUpdate {
  readonly pinState: LocationPinState;
  readonly camera: THREE.Camera;
  readonly earthRoot: THREE.Object3D;
  readonly userLatitudeDegrees: number;
  readonly userLongitudeDegrees: number;
  readonly displayRadiusM: number;
  readonly radialMultiplier: number;
  readonly visible: boolean;
}

export function locationPinNormalizedAnchor(
  pin: LocationPin,
  elevationMetres: number,
  radialMultiplier: number,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const normal = contactFrame(pin.latitudeDegrees, pin.longitudeDegrees).upEcef;
  return target.copy(
    geodeticSurfaceEcefKm(pin.latitudeDegrees, pin.longitudeDegrees),
  ).multiplyScalar(1 / EARTH_MEAN_RADIUS_KM).addScaledVector(
    normal,
    normalizedBodyLocalRadialOffset(
      elevationMetres,
      radialMultiplier,
      EARTH_SURFACE_MODEL.referenceRadiusM,
    ),
  );
}

export function locationPinIsAboveHorizon(
  cameraLocalPosition: THREE.Vector3,
  targetLocalPosition: THREE.Vector3,
  targetNormal: THREE.Vector3,
): boolean {
  return cameraLocalPosition.clone()
    .sub(targetLocalPosition)
    .dot(targetNormal) >= 0;
}

export function locationPinHudDirection(
  cameraSpaceDirection: THREE.Vector3,
  target = new THREE.Vector2(),
): THREE.Vector2 {
  if (cameraSpaceDirection.lengthSq() < 1e-16) return target.set(0, -1);
  const horizontalDistance = Math.hypot(
    cameraSpaceDirection.x,
    cameraSpaceDirection.z,
  );
  const bearing = horizontalDistance < 1e-8
    ? 0
    : cameraSpaceDirection.z > 0 && Math.abs(cameraSpaceDirection.x) < 1e-8
      ? Math.PI
      : Math.atan2(cameraSpaceDirection.x, -cameraSpaceDirection.z);
  const elevation = Math.atan2(cameraSpaceDirection.y, horizontalDistance);
  target.set(
    bearing / Math.PI,
    elevation / (Math.PI / 2),
  );
  if (Math.abs(target.x) + Math.abs(target.y) < 1e-8) target.y = -1;
  return target;
}

function canvasTexture(
  width: number,
  height: number,
): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
} {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Location pin labels require a 2D canvas.");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return { canvas, context, texture };
}

function roundedRectangle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function fitLabel(
  context: CanvasRenderingContext2D,
  text: string,
  maximumWidth: number,
): void {
  for (let size = 64; size >= 30; size -= 2) {
    context.font = `700 ${size}px Inter, system-ui, sans-serif`;
    if (context.measureText(text).width <= maximumWidth) return;
  }
}

function redrawPin(
  renderable: PinRenderable,
  pin: LocationPin,
  distanceText: string,
  active: boolean,
): void {
  const { context, canvas } = renderable;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const accent = active ? "#66ece0" : "#f2b75e";
  const accentDark = active ? "#087f7d" : "#9b5a16";

  context.shadowColor = "rgba(0, 0, 0, 0.55)";
  context.shadowBlur = 14;
  roundedRectangle(context, 142, 34, 606, 162, 40);
  context.fillStyle = "rgba(4, 17, 23, 0.9)";
  context.fill();
  context.lineWidth = active ? 7 : 5;
  context.strokeStyle = accent;
  context.stroke();
  context.shadowBlur = 0;

  context.beginPath();
  context.arc(PIN_TIP_X, 91, 58, 0, Math.PI * 2);
  context.fillStyle = accent;
  context.fill();
  context.beginPath();
  context.moveTo(50, 130);
  context.lineTo(PIN_TIP_X, PIN_TIP_Y);
  context.lineTo(134, 130);
  context.closePath();
  context.fill();
  context.beginPath();
  context.arc(PIN_TIP_X, 91, 22, 0, Math.PI * 2);
  context.fillStyle = accentDark;
  context.fill();

  fitLabel(context, pin.label, 548);
  context.fillStyle = "#f4ffff";
  context.textBaseline = "alphabetic";
  context.fillText(pin.label, 174, 105);
  context.font = "500 42px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.fillStyle = accent;
  context.fillText(distanceText, 174, 166);
  renderable.texture.needsUpdate = true;
}

function createPinRenderable(): PinRenderable {
  const surface = canvasTexture(PIN_TEXTURE_WIDTH, PIN_TEXTURE_HEIGHT);
  const material = new THREE.SpriteMaterial({
    map: surface.texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(
    PIN_TIP_X / PIN_TEXTURE_WIDTH,
    (PIN_TEXTURE_HEIGHT - PIN_TIP_Y) / PIN_TEXTURE_HEIGHT,
  );
  sprite.frustumCulled = false;
  sprite.renderOrder = 24;
  return { ...surface, material, sprite, signature: "" };
}

function createHudArrow(): THREE.Sprite {
  const { canvas, context, texture } = canvasTexture(128, 128);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.beginPath();
  context.moveTo(64, 8);
  context.lineTo(116, 100);
  context.lineTo(64, 80);
  context.lineTo(12, 100);
  context.closePath();
  context.fillStyle = "#66ece0";
  context.fill();
  context.lineWidth = 7;
  context.strokeStyle = "#f4ffff";
  context.stroke();
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(0.085);
  sprite.renderOrder = 100;
  return sprite;
}

function createHudLabel(): PinRenderable {
  const surface = canvasTexture(640, 128);
  const material = new THREE.SpriteMaterial({
    map: surface.texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.36, 0.072, 1);
  sprite.renderOrder = 100;
  return { ...surface, material, sprite, signature: "" };
}

function createGuidanceRenderable(): GuidanceRenderable {
  return { arrow: createHudArrow(), label: createHudLabel() };
}

function redrawHudLabel(
  renderable: PinRenderable,
  pin: LocationPin,
  distanceText: string,
): void {
  const { context, canvas } = renderable;
  context.clearRect(0, 0, canvas.width, canvas.height);
  roundedRectangle(context, 4, 10, canvas.width - 8, canvas.height - 20, 34);
  context.fillStyle = "rgba(4, 17, 23, 0.9)";
  context.fill();
  context.lineWidth = 5;
  context.strokeStyle = "#66ece0";
  context.stroke();
  fitLabel(context, `${pin.label} · ${distanceText}`, canvas.width - 64);
  context.fillStyle = "#f4ffff";
  context.textBaseline = "middle";
  context.fillText(`${pin.label} · ${distanceText}`, 32, canvas.height / 2);
  renderable.texture.needsUpdate = true;
}

const pinPosition = new THREE.Vector3();
const pinNormal = new THREE.Vector3();
const cameraWorldPosition = new THREE.Vector3();
const cameraLocalPosition = new THREE.Vector3();
const targetWorldPosition = new THREE.Vector3();
const targetNdc = new THREE.Vector3();
const pinWorldUp = new THREE.Vector3();
const pinUpNdc = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();
const cameraQuaternion = new THREE.Quaternion();
const inverseCameraQuaternion = new THREE.Quaternion();
const cameraRight = new THREE.Vector3();
const cameraUp = new THREE.Vector3();
const cameraForward = new THREE.Vector3();
const hudPosition = new THREE.Vector3();
const hudDirection = new THREE.Vector2();

export class LocationPinLayer {
  readonly worldGroup = new THREE.Group();
  readonly hudGroup = new THREE.Group();
  private readonly renderables = new Map<string, PinRenderable>();
  private readonly guidanceRenderables = new Map<string, GuidanceRenderable>();

  constructor(
    private readonly terrainElevationMetres: (
      latitudeDegrees: number,
      longitudeDegrees: number,
    ) => number,
  ) {
    this.worldGroup.name = "location-pins";
    this.hudGroup.name = "location-pin-guidance";
    this.hudGroup.visible = false;
  }

  update(options: LocationPinLayerUpdate): void {
    this.reconcile(options.pinState.pins);
    this.worldGroup.visible = options.visible;
    this.hudGroup.visible = options.visible;
    if (!options.visible) {
      return;
    }

    for (const renderable of this.guidanceRenderables.values()) {
      renderable.arrow.visible = false;
      renderable.label.sprite.visible = false;
    }

    options.earthRoot.updateWorldMatrix(true, true);
    options.camera.updateWorldMatrix(true, false);
    options.camera.getWorldPosition(cameraWorldPosition);
    options.camera.getWorldQuaternion(cameraQuaternion);
    cameraLocalPosition.copy(cameraWorldPosition);
    options.earthRoot.worldToLocal(cameraLocalPosition);

    const guidedPinIds = new Set(options.pinState.guidedPinIds);
    for (const pin of options.pinState.pins) {
      const renderable = this.renderables.get(pin.pinId)!;
      pinNormal.copy(contactFrame(
        pin.latitudeDegrees,
        pin.longitudeDegrees,
      ).upEcef);
      const elevationMetres = this.terrainElevationMetres(
        pin.latitudeDegrees,
        pin.longitudeDegrees,
      );
      locationPinNormalizedAnchor(
        pin,
        elevationMetres,
        options.radialMultiplier,
        pinPosition,
      ).addScaledVector(
        pinNormal,
        0.002 / options.displayRadiusM,
      );
      renderable.sprite.position.copy(pinPosition);

      const distanceKm = greatCircleDistanceKm(
        options.userLatitudeDegrees,
        options.userLongitudeDegrees,
        pin.latitudeDegrees,
        pin.longitudeDegrees,
      );
      const guided = guidedPinIds.has(pin.pinId);
      const distanceText = formatLocationPinDistance(distanceKm);
      const signature = `${guided ? "guided" : "unguided"}:${pin.label}:${distanceText}`;
      if (signature !== renderable.signature) {
        redrawPin(renderable, pin, distanceText, guided);
        renderable.signature = signature;
      }

      renderable.sprite.getWorldPosition(targetWorldPosition);
      const cameraDistanceM = cameraWorldPosition.distanceTo(targetWorldPosition);
      const worldHeightM = worldHeightForAngularSize(
        cameraDistanceM,
        locationPinAngularHeightDegrees(distanceKm),
      );
      const localHeight = worldHeightM / options.displayRadiusM;
      renderable.sprite.scale.set(
        localHeight * PIN_TEXTURE_ASPECT,
        localHeight,
        1,
      );
      pinWorldUp.copy(pinNormal).transformDirection(options.earthRoot.matrixWorld);
      targetNdc.copy(targetWorldPosition).project(options.camera);
      pinUpNdc.copy(targetWorldPosition)
        .addScaledVector(pinWorldUp, worldHeightM)
        .project(options.camera)
        .sub(targetNdc);
      if (pinUpNdc.lengthSq() > 1e-12) {
        // Sprites face the camera, so counter-rotate the canvas until its
        // vertical axis follows the Earth's projected local-up direction.
        // Undo the projection's X/Y scaling because SpriteMaterial rotates in
        // view space, before the projection matrix is applied.
        const projection = options.camera.projectionMatrix.elements;
        renderable.material.rotation = -Math.atan2(
          pinUpNdc.x / projection[0],
          pinUpNdc.y / projection[5],
        );
      }
      if (guided) {
        const aboveHorizon = locationPinIsAboveHorizon(
          cameraLocalPosition,
          renderable.sprite.position,
          pinNormal,
        );
        const inView = targetNdc.z >= -1 && targetNdc.z <= 1 &&
          Math.abs(targetNdc.x) <= 0.82 && Math.abs(targetNdc.y) <= 0.74;
        if (!aboveHorizon || !inView) {
          this.updateHud(
            this.guidanceRenderable(pin.pinId),
            pin,
            distanceKm,
            options.camera,
          );
        }
      }
    }
  }

  dispose(): void {
    for (const renderable of this.renderables.values()) {
      this.disposeRenderable(renderable);
    }
    this.renderables.clear();
    for (const renderable of this.guidanceRenderables.values()) {
      this.disposeGuidanceRenderable(renderable);
    }
    this.guidanceRenderables.clear();
  }

  private reconcile(pins: readonly LocationPin[]): void {
    const nextIds = new Set(pins.map(({ pinId }) => pinId));
    for (const [pinId, renderable] of this.renderables) {
      if (nextIds.has(pinId)) continue;
      this.worldGroup.remove(renderable.sprite);
      this.disposeRenderable(renderable);
      this.renderables.delete(pinId);
      const guidance = this.guidanceRenderables.get(pinId);
      if (guidance) {
        this.hudGroup.remove(guidance.arrow, guidance.label.sprite);
        this.disposeGuidanceRenderable(guidance);
        this.guidanceRenderables.delete(pinId);
      }
    }
    for (const pin of pins) {
      if (this.renderables.has(pin.pinId)) continue;
      const renderable = createPinRenderable();
      this.renderables.set(pin.pinId, renderable);
      this.worldGroup.add(renderable.sprite);
    }
  }

  private guidanceRenderable(pinId: string): GuidanceRenderable {
    let renderable = this.guidanceRenderables.get(pinId);
    if (renderable) return renderable;
    renderable = createGuidanceRenderable();
    this.guidanceRenderables.set(pinId, renderable);
    this.hudGroup.add(renderable.arrow, renderable.label.sprite);
    return renderable;
  }

  private updateHud(
    renderable: GuidanceRenderable,
    pin: LocationPin,
    distanceKm: number,
    camera: THREE.Camera,
  ): void {
    cameraDirection.copy(targetWorldPosition).sub(cameraWorldPosition);
    inverseCameraQuaternion.copy(cameraQuaternion).invert();
    cameraDirection.applyQuaternion(inverseCameraQuaternion);
    locationPinHudDirection(cameraDirection, hudDirection);
    const horizontal = hudDirection.x;
    const vertical = hudDirection.y;
    const edgeScale = 1 / Math.max(
      Math.abs(horizontal) / 0.72,
      Math.abs(vertical) / 0.46,
    );
    const edgeX = horizontal * edgeScale;
    const edgeY = vertical * edgeScale;

    cameraRight.set(1, 0, 0).applyQuaternion(cameraQuaternion);
    cameraUp.set(0, 1, 0).applyQuaternion(cameraQuaternion);
    cameraForward.set(0, 0, -1).applyQuaternion(cameraQuaternion);
    hudPosition.copy(cameraWorldPosition)
      .addScaledVector(cameraForward, HUD_DISTANCE_M)
      .addScaledVector(cameraRight, edgeX * 0.78)
      .addScaledVector(cameraUp, edgeY * 0.5);
    renderable.arrow.position.copy(hudPosition);
    renderable.arrow.material.rotation = -Math.atan2(edgeX, edgeY);
    renderable.label.sprite.position.copy(hudPosition)
      .addScaledVector(cameraRight, -Math.sign(edgeX) * 0.2)
      .addScaledVector(cameraUp, -Math.sign(edgeY) * 0.06);
    const distanceText = formatLocationPinDistance(distanceKm);
    const signature = `${pin.label}:${distanceText}`;
    if (signature !== renderable.label.signature) {
      redrawHudLabel(renderable.label, pin, distanceText);
      renderable.label.signature = signature;
    }
    renderable.arrow.visible = true;
    renderable.label.sprite.visible = true;
  }

  private disposeRenderable(renderable: PinRenderable): void {
    renderable.texture.dispose();
    renderable.material.dispose();
  }

  private disposeGuidanceRenderable(renderable: GuidanceRenderable): void {
    for (const sprite of [renderable.arrow, renderable.label.sprite]) {
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
  }
}
