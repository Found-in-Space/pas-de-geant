import type { ButtonLatch } from "./controller-input.js";

export interface EclipseControllerIntent {
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
  const leftButtons = left?.gamepad?.buttons ?? [];
  const rightButtons = right?.gamepad?.buttons ?? [];
  const aPressed = rightButtons[4]?.pressed ?? false;
  const bPressed = rightButtons[5]?.pressed ?? false;
  const xPressed = leftButtons[4]?.pressed ?? false;
  const yPressed = leftButtons[5]?.pressed ?? false;
  const result = {
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
