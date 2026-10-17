import { Quaternion, Vector2, Vector3 } from "three";

const HAND_INPUT_PROFILE = "generic-hand-select";

/** Identifies articulated hand tracking even when the session omits joint poses. */
export function isHandTrackingInputSource(
  source: XRInputSource | undefined,
): boolean {
  return (
    source?.hand != null ||
    source?.profiles.includes(HAND_INPUT_PROFILE) === true
  );
}

export function deadzone(value: number, threshold = 0.16): number {
  const magnitude = Math.abs(value);
  if (magnitude < threshold) return 0;
  return Math.sign(value) * (magnitude - threshold) / (1 - threshold);
}

export function stickForSource(
  source: XRInputSource | undefined,
  threshold?: number,
): [number, number] {
  const axes = source?.gamepad?.axes;
  if (!axes || axes.length < 2) return [0, 0];
  const offset = axes.length >= 4 ? axes.length - 2 : 0;
  return [
    deadzone(axes[offset] ?? 0, threshold),
    deadzone(axes[offset + 1] ?? 0, threshold),
  ];
}

export type DominantStickAxis = "horizontal" | "vertical" | null;

/**
 * Keeps a diagonal right-stick gesture on one function until the stick is
 * released, preventing altitude and scale from compounding.
 */
export function dominantStickAxes(
  horizontal: number,
  vertical: number,
  latched: DominantStickAxis,
): {
  horizontal: number;
  vertical: number;
  latched: DominantStickAxis;
} {
  if (horizontal === 0 && vertical === 0) {
    return { horizontal: 0, vertical: 0, latched: null };
  }
  const selected = latched ??
    (Math.abs(horizontal) >= Math.abs(vertical) ? "horizontal" : "vertical");
  return {
    horizontal: selected === "horizontal" ? horizontal : 0,
    vertical: selected === "vertical" ? vertical : 0,
    latched: selected,
  };
}

const flatForward = new Vector3();
const flatRight = new Vector3();

export function headRelativeTravel(
  stick: Vector2,
  viewQuaternion: Quaternion,
): Vector2 {
  flatForward.set(0, 0, -1).applyQuaternion(viewQuaternion);
  flatForward.y = 0;
  if (flatForward.lengthSq() < 1e-8) flatForward.set(0, 0, -1);
  flatForward.normalize();
  flatRight.set(1, 0, 0).applyQuaternion(viewQuaternion);
  flatRight.y = 0;
  if (flatRight.lengthSq() < 1e-8) flatRight.set(1, 0, 0);
  flatRight.normalize();
  return new Vector2(
    flatRight.x * stick.x + flatForward.x * -stick.y,
    flatRight.z * stick.x + flatForward.z * -stick.y,
  );
}
