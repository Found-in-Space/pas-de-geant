import { Quaternion, Vector2, Vector3 } from "three";

export type ViewDirectionMode = "absolute" | "relative";

export interface ViewDirectionCommand {
  mode: ViewDirectionMode;
  degrees: number;
}

const forward = new Vector3();

export function normalizeHeadingDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function normalizeRotationRadians(radians: number): number {
  const turn = Math.PI * 2;
  return ((radians + Math.PI) % turn + turn) % turn - Math.PI;
}

export function parseViewDirectionToolArguments(
  value: unknown,
): ViewDirectionCommand {
  if (!value || typeof value !== "object") {
    throw new Error("View direction arguments must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== "absolute" && candidate.mode !== "relative") {
    throw new Error("View direction mode must be absolute or relative.");
  }
  if (typeof candidate.degrees !== "number" || !Number.isFinite(candidate.degrees)) {
    throw new Error("View direction degrees must be finite.");
  }
  return { mode: candidate.mode, degrees: candidate.degrees };
}

export function viewHeadingDegreesFromQuaternion(
  quaternion: Quaternion,
): number {
  forward.set(0, 0, -1).applyQuaternion(quaternion);
  forward.y = 0;
  if (forward.lengthSq() < 1e-8) {
    throw new Error(
      "View heading is unavailable while looking straight up or down.",
    );
  }
  forward.normalize();
  return normalizeHeadingDegrees(
    Math.atan2(forward.x, -forward.z) * 180 / Math.PI,
  );
}

export function geographicViewHeadingDegrees(
  viewWorldHeadingDegrees: number,
  worldRotationRadians: number,
): number {
  return normalizeHeadingDegrees(
    viewWorldHeadingDegrees + worldRotationRadians * 180 / Math.PI,
  );
}

export function worldRotationForViewDirection(
  currentWorldRotationRadians: number,
  viewWorldHeadingDegrees: number,
  command: ViewDirectionCommand,
): number {
  const next = command.mode === "relative"
    ? currentWorldRotationRadians + command.degrees * Math.PI / 180
    : (normalizeHeadingDegrees(command.degrees) - viewWorldHeadingDegrees) *
      Math.PI / 180;
  return normalizeRotationRadians(next);
}

/** Maps a room-space direction back into the unrotated east/north frame. */
export function geographicTravelFromWorld(
  worldTravel: Vector2,
  worldRotationRadians: number,
  target = new Vector2(),
): Vector2 {
  const cosine = Math.cos(worldRotationRadians);
  const sine = Math.sin(worldRotationRadians);
  return target.set(
    cosine * worldTravel.x - sine * worldTravel.y,
    sine * worldTravel.x + cosine * worldTravel.y,
  );
}
