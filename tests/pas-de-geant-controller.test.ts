import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  controllerIntent,
  freshButtonLatch,
  headRelativeTravel,
  isHandTrackingInputSource,
} from "../apps/pas-de-geant/src/controller-input.js";
import {
  applyLogarithmicScale,
  applyRadialMultiplierRate,
} from "../apps/pas-de-geant/src/planet-state.js";

describe("Pas de Géant controller regressions", () => {
  it("distinguishes controller input from articulated hand tracking", () => {
    const controller = {
      profiles: ["oculus-touch-v3"],
    } as unknown as XRInputSource;
    const profileOnlyHand = {
      profiles: ["generic-hand-select"],
    } as unknown as XRInputSource;
    const jointTrackedHand = {
      hand: {},
      profiles: [],
    } as unknown as XRInputSource;

    expect(isHandTrackingInputSource(controller)).toBe(false);
    expect(isHandTrackingInputSource(profileOnlyHand)).toBe(true);
    expect(isHandTrackingInputSource(jointTrackedHand)).toBe(true);
  });

  it("rotates travel with headset yaw while ignoring pitch", () => {
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

  it("toggles terrain boundaries with X and imagery tiles with Y", () => {
    const xButton = { pressed: false, value: 0 };
    const yButton = { pressed: false, value: 0 };
    const session = {
      inputSources: [
        {
          handedness: "left",
          gamepad: {
            axes: [0, 0, 0, 0],
            buttons: [
              { pressed: false, value: 0 },
              { pressed: false, value: 0 },
              { pressed: false, value: 0 },
              { pressed: false, value: 0 },
              xButton,
              yButton,
            ],
          },
        },
      ],
    } as unknown as XRSession;
    const latch = freshButtonLatch();

    xButton.pressed = true;
    xButton.value = 1;
    const xPress = controllerIntent(session, 0, latch);
    expect(xPress.toggleTileOverlay).toBe(true);
    expect(controllerIntent(session, 16, latch).toggleTileOverlay).toBe(false);
    xButton.pressed = false;
    xButton.value = 0;
    controllerIntent(session, 32, latch);

    yButton.pressed = true;
    yButton.value = 1;
    const yPress = controllerIntent(session, 48, latch);
    expect(yPress.toggleTileOverlay).toBe(false);
    expect(yPress.toggleTextureTileOverlay).toBe(true);
  });

  it("toggles the voice agent only once per A-button press", () => {
    const aButton = { pressed: false, value: 0 };
    const session = {
      inputSources: [
        {
          handedness: "right",
          gamepad: {
            axes: [0, 0, 0, 0],
            buttons: [
              { pressed: false, value: 0 },
              { pressed: false, value: 0 },
              { pressed: false, value: 0 },
              { pressed: false, value: 0 },
              aButton,
              { pressed: false, value: 0 },
            ],
          },
        },
      ],
    } as unknown as XRSession;
    const latch = freshButtonLatch();

    aButton.pressed = true;
    aButton.value = 1;
    expect(controllerIntent(session, 0, latch).toggleAgent).toBe(true);
    expect(controllerIntent(session, 16, latch).toggleAgent).toBe(false);
    aButton.pressed = false;
    aButton.value = 0;
    expect(controllerIntent(session, 32, latch).toggleAgent).toBe(false);
    aButton.pressed = true;
    aButton.value = 1;
    expect(controllerIntent(session, 48, latch).toggleAgent).toBe(true);
  });

  it("uses trigger-modified left-stick horizontal input to turn", () => {
    const trigger = { pressed: false, value: 0 };
    const grip = { pressed: false, value: 0 };
    const stick = [0, 0, 0, 0];
    const session = {
      inputSources: [
        {
          handedness: "left",
          gamepad: {
            axes: stick,
            buttons: [trigger, grip],
          },
        },
      ],
    } as unknown as XRSession;
    const latch = freshButtonLatch();

    stick[2] = 0.75;
    const travelling = controllerIntent(session, 0, latch);
    expect(travelling.turnAxis).toBe(0);
    expect(travelling.travel.x).toBeGreaterThan(0);

    trigger.pressed = true;
    trigger.value = 1;
    stick[3] = -0.5;
    const turning = controllerIntent(session, 0, latch);
    expect(turning.turnAxis).toBeGreaterThan(0);
    expect(turning.travel.x).toBe(0);
    expect(turning.travel.y).toBeLessThan(0);

    grip.pressed = true;
    grip.value = 1;
    expect(controllerIntent(session, 16, latch).boost).toBe(true);
  });

  it("maps right-stick vertical to scale and horizontal to radial amplification", () => {
    const stick = [0, 0, 0, 0];
    const session = {
      inputSources: [
        {
          handedness: "right",
          gamepad: { axes: stick, buttons: [] },
        },
      ],
    } as unknown as XRSession;

    stick[3] = -0.75;
    const up = controllerIntent(session, 0, freshButtonLatch());
    expect(up.scaleAxis).toBeGreaterThan(0);
    expect(up.radialAxis).toBe(0);

    stick[2] = 0.75;
    stick[3] = 0;
    const right = controllerIntent(session, 0, freshButtonLatch());
    expect(right.scaleAxis).toBe(0);
    expect(right.radialAxis).toBeGreaterThan(0);
  });

  it("ignores right-stick axis drift within its dead zone", () => {
    const session = {
      inputSources: [
        {
          handedness: "right",
          gamepad: { axes: [0, 0, 0.75, -0.2], buttons: [] },
        },
      ],
    } as unknown as XRSession;

    const intent = controllerIntent(session, 0, freshButtonLatch());
    expect(intent.scaleAxis).toBe(0);
    expect(intent.radialAxis).toBeGreaterThan(0);
  });

  it("keeps global scale unbounded and radial amplification non-negative", () => {
    expect(applyLogarithmicScale(1, -1, 10)).toBeLessThan(1);
    expect(applyRadialMultiplierRate(20, 1, 1)).toBeGreaterThan(20);
    expect(applyRadialMultiplierRate(0, -1, 1)).toBe(0);
  });
});
