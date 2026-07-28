import {
  Camera,
  Quaternion,
  Vector2,
  Vector3,
} from "three";

interface PointerState {
  button: number;
  point: Vector2;
  pointerType: string;
}

interface FreeSpaceControlsOptions {
  navigationScale: () => number;
  onNavigate?: () => void;
}

const LOCAL_X = new Vector3(1, 0, 0);
const LOCAL_Y = new Vector3(0, 1, 0);
const LOCAL_Z = new Vector3(0, 0, 1);
const movement = new Vector3();
const rotation = new Quaternion();

/**
 * Applies incremental local-axis rotations directly to a quaternion. Unlike an
 * Euler-angle controller, this can cross every orientation without a polar
 * singularity or a forced world-up direction.
 */
export function applyLocalRotation(
  camera: Camera,
  yawRad: number,
  pitchRad: number,
  rollRad = 0,
): void {
  if (yawRad !== 0) {
    rotation.setFromAxisAngle(LOCAL_Y, yawRad);
    camera.quaternion.multiply(rotation);
  }
  if (pitchRad !== 0) {
    rotation.setFromAxisAngle(LOCAL_X, pitchRad);
    camera.quaternion.multiply(rotation);
  }
  if (rollRad !== 0) {
    rotation.setFromAxisAngle(LOCAL_Z, rollRad);
    camera.quaternion.multiply(rotation);
  }
  camera.quaternion.normalize();
}

export class FreeSpaceControls {
  enabled = true;
  rotationSpeed = 0.004;
  keyboardRotationSpeed = 1.15;
  keyboardMovementSpeed = 1.8;
  private readonly camera: Camera;
  private readonly element: HTMLElement;
  private readonly navigationScale: () => number;
  private readonly onNavigate: () => void;
  private readonly pointers = new Map<number, PointerState>();
  private readonly keys = new Set<string>();
  private pinchDistance: number | null = null;
  private readonly pinchCentre = new Vector2();

  constructor(
    camera: Camera,
    element: HTMLElement,
    options: FreeSpaceControlsOptions,
  ) {
    this.camera = camera;
    this.element = element;
    this.navigationScale = options.navigationScale;
    this.onNavigate = options.onNavigate ?? (() => undefined);
    this.connect();
  }

  update(deltaSeconds: number): void {
    if (!this.enabled) return;
    const forward =
      Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    const sideways =
      Number(this.keys.has("KeyD")) - Number(this.keys.has("KeyA"));
    const vertical =
      Number(this.keys.has("KeyR")) - Number(this.keys.has("KeyF"));
    movement.set(sideways, vertical, -forward);
    if (movement.lengthSq() > 0) {
      const boost = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")
        ? 4
        : 1;
      movement
        .normalize()
        .multiplyScalar(
          this.navigationScale() *
            this.keyboardMovementSpeed *
            boost *
            deltaSeconds,
        );
      this.camera.translateX(movement.x);
      this.camera.translateY(movement.y);
      this.camera.translateZ(movement.z);
    }

    const yaw =
      Number(this.keys.has("ArrowLeft")) -
      Number(this.keys.has("ArrowRight"));
    const pitch =
      Number(this.keys.has("ArrowUp")) -
      Number(this.keys.has("ArrowDown"));
    const roll =
      Number(this.keys.has("KeyQ")) - Number(this.keys.has("KeyE"));
    if (yaw !== 0 || pitch !== 0 || roll !== 0) {
      const angle = this.keyboardRotationSpeed * deltaSeconds;
      applyLocalRotation(
        this.camera,
        yaw * angle,
        pitch * angle,
        roll * angle,
      );
    }
  }

  dispose(): void {
    this.element.removeEventListener("pointerdown", this.handlePointerDown);
    this.element.removeEventListener("pointermove", this.handlePointerMove);
    this.element.removeEventListener("pointerup", this.handlePointerUp);
    this.element.removeEventListener("pointercancel", this.handlePointerUp);
    this.element.removeEventListener("wheel", this.handleWheel);
    this.element.removeEventListener("contextmenu", this.preventContextMenu);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.clearInput);
  }

  private connect(): void {
    this.element.style.touchAction = "none";
    this.element.addEventListener("pointerdown", this.handlePointerDown);
    this.element.addEventListener("pointermove", this.handlePointerMove);
    this.element.addEventListener("pointerup", this.handlePointerUp);
    this.element.addEventListener("pointercancel", this.handlePointerUp);
    this.element.addEventListener("wheel", this.handleWheel, {
      passive: false,
    });
    this.element.addEventListener("contextmenu", this.preventContextMenu);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.clearInput);
  }

  private rotate(deltaX: number, deltaY: number): void {
    applyLocalRotation(
      this.camera,
      -deltaX * this.rotationSpeed,
      -deltaY * this.rotationSpeed,
    );
  }

  private pan(deltaX: number, deltaY: number): void {
    const distance = this.navigationScale();
    const scale = distance / 220;
    this.camera.translateX(-deltaX * scale);
    this.camera.translateY(deltaY * scale);
  }

  private dolly(amount: number): void {
    this.camera.translateZ(-amount * this.navigationScale());
  }

  private updatePinchReference(): void {
    const points = [...this.pointers.values()];
    if (points.length < 2) {
      this.pinchDistance = null;
      return;
    }
    this.pinchDistance = points[0]!.point.distanceTo(points[1]!.point);
    this.pinchCentre
      .copy(points[0]!.point)
      .add(points[1]!.point)
      .multiplyScalar(0.5);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.element.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, {
      button: event.button,
      point: new Vector2(event.clientX, event.clientY),
      pointerType: event.pointerType,
    });
    if (this.pointers.size === 2) this.updatePinchReference();
    this.onNavigate();
    event.preventDefault();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    const state = this.pointers.get(event.pointerId);
    if (!state) return;
    const previous = state.point.clone();
    state.point.set(event.clientX, event.clientY);
    if (this.pointers.size >= 2) {
      const points = [...this.pointers.values()];
      const nextDistance = points[0]!.point.distanceTo(points[1]!.point);
      const nextCentre = points[0]!.point
        .clone()
        .add(points[1]!.point)
        .multiplyScalar(0.5);
      if (this.pinchDistance !== null) {
        this.pan(
          nextCentre.x - this.pinchCentre.x,
          nextCentre.y - this.pinchCentre.y,
        );
        this.dolly((nextDistance - this.pinchDistance) / 64);
      }
      this.pinchDistance = nextDistance;
      this.pinchCentre.copy(nextCentre);
    } else {
      const deltaX = state.point.x - previous.x;
      const deltaY = state.point.y - previous.y;
      if (state.pointerType === "touch" || state.button === 0) {
        this.rotate(deltaX, deltaY);
      } else {
        this.pan(deltaX, deltaY);
      }
    }
    event.preventDefault();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
    this.updatePinchReference();
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    const magnitude = Math.max(
      0.18,
      Math.min(4, Math.abs(event.deltaY) / 100),
    );
    this.dolly(-Math.sign(event.deltaY) * magnitude);
    this.onNavigate();
    event.preventDefault();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || event.altKey || this.isEditableTarget(event.target)) {
      return;
    }
    if (!this.isNavigationKey(event.code)) return;
    this.keys.add(event.code);
    this.onNavigate();
    event.preventDefault();
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly clearInput = (): void => {
    this.keys.clear();
    this.pointers.clear();
    this.pinchDistance = null;
  };

  private readonly preventContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private isEditableTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement &&
      (target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement);
  }

  private isNavigationKey(code: string): boolean {
    return [
      "KeyW",
      "KeyS",
      "KeyA",
      "KeyD",
      "KeyR",
      "KeyF",
      "KeyQ",
      "KeyE",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ShiftLeft",
      "ShiftRight",
    ].includes(code);
  }
}
