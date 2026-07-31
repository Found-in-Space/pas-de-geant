import { Quaternion, Vector2, Vector3 } from "three";

export interface ControllerIntent {
  travel: Vector2;
  scaleAxis: number;
  radialAxis: number;
  boost: boolean;
  toggleTileOverlay: boolean;
  toggleTextureTileOverlay: boolean;
  toggleOcean: boolean;
  reset: boolean;
  resetGroundLevel: boolean;
}

export interface ButtonLatch {
  a: boolean;
  bStartedAt: number | null;
  stick: boolean;
  x: boolean;
  y: boolean;
}

export function deadzone(value: number, threshold = 0.16): number {
  const magnitude = Math.abs(value);
  if (magnitude < threshold) return 0;
  return Math.sign(value) * (magnitude - threshold) / (1 - threshold);
}

export function stickForSource(
  source: XRInputSource | undefined,
): [number, number] {
  const axes = source?.gamepad?.axes;
  if (!axes || axes.length < 2) return [0, 0];
  const offset = axes.length >= 4 ? axes.length - 2 : 0;
  return [
    deadzone(axes[offset] ?? 0),
    deadzone(axes[offset + 1] ?? 0),
  ];
}

export function controllerIntent(
  session: XRSession,
  nowMs: number,
  latch: ButtonLatch,
): ControllerIntent {
  const sources = [...session.inputSources].filter(
    (source) => source.gamepad !== undefined,
  );
  const left =
    sources.find((source) => source.handedness === "left") ?? sources[0];
  const right =
    sources.find((source) => source.handedness === "right") ?? sources[1];
  const [travelX, travelY] = stickForSource(left);
  const [scaleAxis, radialAxis] = stickForSource(right);
  const leftButtons = left?.gamepad?.buttons ?? [];
  const rightButtons = right?.gamepad?.buttons ?? [];
  const aPressed = rightButtons[4]?.pressed ?? rightButtons[0]?.pressed ?? false;
  const bPressed = rightButtons[5]?.pressed ?? rightButtons[1]?.pressed ?? false;
  const stickPressed = rightButtons[3]?.pressed ?? false;
  const xPressed = leftButtons[4]?.pressed ?? false;
  const yPressed = leftButtons[5]?.pressed ?? false;
  const toggleOcean = aPressed && !latch.a;
  const resetGroundLevel = stickPressed && !latch.stick;
  const toggleTileOverlay = xPressed && !latch.x;
  const toggleTextureTileOverlay = yPressed && !latch.y;
  latch.a = aPressed;
  latch.stick = stickPressed;
  latch.x = xPressed;
  latch.y = yPressed;
  if (bPressed && latch.bStartedAt === null) latch.bStartedAt = nowMs;
  const reset =
    bPressed &&
    latch.bStartedAt !== null &&
    nowMs - latch.bStartedAt >= 900;
  if (!bPressed || reset) latch.bStartedAt = null;
  return {
    travel: new Vector2(travelX, travelY),
    scaleAxis,
    radialAxis: -radialAxis,
    boost:
      (leftButtons[0]?.value ?? 0) > 0.55 ||
      (leftButtons[1]?.value ?? 0) > 0.55,
    toggleTileOverlay,
    toggleTextureTileOverlay,
    toggleOcean,
    reset,
    resetGroundLevel,
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

export function freshButtonLatch(): ButtonLatch {
  return {
    a: false,
    bStartedAt: null,
    stick: false,
    x: false,
    y: false,
  };
}
