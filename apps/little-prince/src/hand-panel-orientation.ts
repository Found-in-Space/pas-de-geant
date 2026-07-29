import { Quaternion, Vector3 } from "three";
import type { HandPanelDirection } from "./hand-panel.js";

const panelLocalDirection = new Vector3();
const inversePanelOrientation = new Quaternion();

/**
 * Projects a world-space direction onto the tablet face. Canvas +Y runs down,
 * so the panel's local +Y axis becomes a negative screen-space direction.
 */
export function directionOnHandPanel(
  worldDirection: Vector3,
  panelWorldOrientation: Quaternion,
): HandPanelDirection | undefined {
  panelLocalDirection
    .copy(worldDirection)
    .applyQuaternion(
      inversePanelOrientation.copy(panelWorldOrientation).invert(),
    );
  const length = Math.hypot(
    panelLocalDirection.x,
    panelLocalDirection.y,
  );
  if (length < 1e-8) return undefined;
  return {
    x: panelLocalDirection.x / length,
    y: -panelLocalDirection.y / length,
  };
}
