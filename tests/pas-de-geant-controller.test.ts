import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  controllerIntent,
  freshButtonLatch,
  headRelativeTravel,
} from "../apps/pas-de-geant/src/controller-input.js";

describe("Pas de Géant controller regressions", () => {
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

  it("emits the ground-level reset only once per right-stick press", () => {
    const stickButton = { pressed: true, value: 1 };
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
              stickButton,
              { pressed: false, value: 0 },
              { pressed: false, value: 0 },
            ],
          },
        },
      ],
    } as unknown as XRSession;
    const latch = freshButtonLatch();

    expect(controllerIntent(session, 0, latch).resetGroundLevel).toBe(true);
    expect(controllerIntent(session, 16, latch).resetGroundLevel).toBe(false);
    stickButton.pressed = false;
    stickButton.value = 0;
    expect(controllerIntent(session, 32, latch).resetGroundLevel).toBe(false);
    stickButton.pressed = true;
    stickButton.value = 1;
    expect(controllerIntent(session, 48, latch).resetGroundLevel).toBe(true);
  });

  it("toggles tile boundaries with X and steps finer LOD with Y", () => {
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
    expect(xPress.terrainLodBiasDelta).toBe(0);
    expect(controllerIntent(session, 16, latch).toggleTileOverlay).toBe(false);
    xButton.pressed = false;
    xButton.value = 0;
    controllerIntent(session, 32, latch);

    yButton.pressed = true;
    yButton.value = 1;
    const yPress = controllerIntent(session, 48, latch);
    expect(yPress.toggleTileOverlay).toBe(false);
    expect(yPress.terrainLodBiasDelta).toBe(1);
    expect(controllerIntent(session, 64, latch).terrainLodBiasDelta).toBe(0);
  });
});
