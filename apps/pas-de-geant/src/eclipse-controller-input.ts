import {
  stickForSource,
  type ButtonLatch,
} from "@found-in-space/pas-de-geant";

export interface EclipseControllerIntent {
  orbitX: number;
  orbitY: number;
  altitudeAxis: number;
  scaleAxis: number;
  toggleVoice: boolean;
  resetStage: boolean;
  togglePlayback: boolean;
  togglePanel: boolean;
}

export function eclipseControllerIntent(
  session: XRSession,
  latch: ButtonLatch,
): EclipseControllerIntent {
  const sources = [...session.inputSources].filter(
    (source) => source.gamepad !== undefined,
  );
  const left =
    sources.find((source) => source.handedness === "left") ?? sources[0];
  const right =
    sources.find((source) => source.handedness === "right") ?? sources[1];
  const [orbitX, orbitStickY] = stickForSource(left);
  const [altitudeAxis, scaleStickAxis] = stickForSource(right, 0.22);
  const leftButtons = left?.gamepad?.buttons ?? [];
  const rightButtons = right?.gamepad?.buttons ?? [];
  const aPressed = rightButtons[4]?.pressed ?? false;
  const bPressed = rightButtons[5]?.pressed ?? false;
  const xPressed = leftButtons[4]?.pressed ?? false;
  const yPressed = leftButtons[5]?.pressed ?? false;
  const result = {
    orbitX,
    orbitY: orbitStickY === 0 ? 0 : -orbitStickY,
    altitudeAxis,
    scaleAxis: scaleStickAxis === 0 ? 0 : -scaleStickAxis,
    toggleVoice: aPressed && !latch.a,
    resetStage: bPressed && latch.bStartedAt === null,
    togglePlayback: xPressed && !latch.x,
    togglePanel: yPressed && !latch.y,
  };
  latch.a = aPressed;
  latch.bStartedAt = bPressed ? 0 : null;
  latch.x = xPressed;
  latch.y = yPressed;
  return result;
}
