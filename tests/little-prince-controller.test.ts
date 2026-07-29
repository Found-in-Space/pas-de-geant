import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  controllerIntent,
  deadzone,
  freshButtonLatch,
  headRelativeTravel,
  stickForSource,
} from "../apps/little-prince/src/controller-input.js";

describe("Little Planet controller input", () => {
  it("removes stick noise and remaps motion outside the deadzone", () => {
    expect(deadzone(0.1)).toBe(0);
    expect(deadzone(-0.1)).toBe(0);
    expect(deadzone(1)).toBe(1);
    expect(deadzone(-1)).toBe(-1);
    expect(deadzone(0.6)).toBeCloseTo((0.6 - 0.16) / (1 - 0.16));
  });

  it("rotates travel intent with headset yaw while ignoring pitch", () => {
    const lookingEast = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-0.7, -Math.PI / 2, 0, "YXZ"),
    );
    const travel = headRelativeTravel(
      new THREE.Vector2(0, -1),
      lookingEast,
    );

    expect(travel.x).toBeCloseTo(1);
    expect(travel.y).toBeCloseTo(0);
  });

  it("keeps cross-axis stick noise inside the independent dead zone", () => {
    const source = {
      gamepad: {
        axes: [0.8, 0.1],
      },
    } as unknown as XRInputSource;
    const [planetScale, radialMultiplier] = stickForSource(source);

    expect(planetScale).toBeGreaterThan(0);
    expect(radialMultiplier).toBe(0);
  });

  it("toggles the hand panel once per right-stick press", () => {
    const stickButton = { pressed: true, value: 1 };
    const right = {
      handedness: "right",
      gamepad: {
        axes: [0, 0, 0, 0],
        buttons: [
          { pressed: false, value: 0 },
          { pressed: false, value: 0 },
          { pressed: false, value: 0 },
          stickButton,
          { pressed: false, value: 0 },
          { pressed: false, value: 0 },
        ],
      },
    } as unknown as XRInputSource;
    const session = {
      inputSources: [right],
    } as unknown as XRSession;
    const latch = freshButtonLatch();

    expect(controllerIntent(session, 0, latch).togglePanel).toBe(true);
    expect(controllerIntent(session, 16, latch).togglePanel).toBe(false);
    stickButton.pressed = false;
    stickButton.value = 0;
    expect(controllerIntent(session, 32, latch).togglePanel).toBe(false);
    stickButton.pressed = true;
    stickButton.value = 1;
    expect(controllerIntent(session, 48, latch).togglePanel).toBe(true);
  });
});
