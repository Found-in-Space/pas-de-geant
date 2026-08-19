import {
  calculateTileOnionPlan,
  mercatorTileX,
  mercatorTileY,
  normalizedTileOnionZoom,
  tileOnionModeForCoordinates,
  updateTileOnionNormalAnchor,
  wrapTileX,
  wrapLongitude,
  type TileOnionAnchor,
  type TileOnionMode,
  type TileOnionState,
} from "./tile-onion-core.js";
import type { LayoutSource } from "./tile-transition-scheduler.js";
import type { TileIdentity } from "./tile-transition-planner.js";

export interface TileLayoutTarget {
  readonly maxZoom: number;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
}

export function normalizeTileLayoutTarget(
  target: TileLayoutTarget,
): TileLayoutTarget {
  const maxZoom = Number.isFinite(target.maxZoom)
    ? Math.max(0, Math.floor(target.maxZoom))
    : 0;
  const latitudeDegrees = Number.isFinite(target.latitudeDegrees)
    ? Math.max(-90, Math.min(90, target.latitudeDegrees))
    : 0;
  const longitudeDegrees = Number.isFinite(target.longitudeDegrees)
    ? wrapLongitude(target.longitudeDegrees)
    : 0;
  return Object.freeze({ maxZoom, latitudeDegrees, longitudeDegrees });
}

/**
 * O(1) main-thread submission gate. It mirrors only the canonical normal
 * anchor transition; the worker planner remains the correctness authority.
 */
export class TileLayoutSubmissionGate {
  private readonly normalAnchor: TileOnionAnchor = {
    z: -1,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };
  private mode: TileOnionMode;
  private maxZoom: number;
  private latitudeDegrees: number;
  private longitudeDegrees: number;

  constructor(initialTarget: TileLayoutTarget) {
    this.maxZoom = normalizedTileOnionZoom(initialTarget.maxZoom);
    this.latitudeDegrees = Number.isFinite(initialTarget.latitudeDegrees)
      ? Math.max(-90, Math.min(90, initialTarget.latitudeDegrees))
      : 0;
    this.longitudeDegrees = Number.isFinite(initialTarget.longitudeDegrees)
      ? wrapLongitude(initialTarget.longitudeDegrees)
      : 0;
    this.mode = tileOnionModeForCoordinates(
      this.latitudeDegrees,
      this.longitudeDegrees,
      this.maxZoom,
    );
    if (this.mode === "normal") this.resetNormalAnchor();
  }

  update(nextTarget: TileLayoutTarget): boolean {
    const maxZoom = normalizedTileOnionZoom(nextTarget.maxZoom);
    const latitudeDegrees = Number.isFinite(nextTarget.latitudeDegrees)
      ? Math.max(-90, Math.min(90, nextTarget.latitudeDegrees))
      : 0;
    const longitudeDegrees = Number.isFinite(nextTarget.longitudeDegrees)
      ? wrapLongitude(nextTarget.longitudeDegrees)
      : 0;
    if (
      maxZoom === this.maxZoom &&
      latitudeDegrees === this.latitudeDegrees &&
      longitudeDegrees === this.longitudeDegrees
    ) return false;

    const mode = tileOnionModeForCoordinates(
      latitudeDegrees,
      longitudeDegrees,
      maxZoom,
    );
    let accepted: boolean;
    if (maxZoom !== this.maxZoom || mode !== this.mode) {
      accepted = true;
      this.normalAnchor.z = -1;
      if (mode === "normal") {
        this.updateNormalAnchor(latitudeDegrees, longitudeDegrees, maxZoom);
      }
    } else if (mode === "normal") {
      accepted = this.updateNormalAnchor(
        latitudeDegrees,
        longitudeDegrees,
        maxZoom,
      );
    } else {
      // Boundary latitude and the pole-lock state remain planner inputs.
      accepted = true;
    }

    this.mode = mode;
    this.maxZoom = maxZoom;
    this.latitudeDegrees = latitudeDegrees;
    this.longitudeDegrees = longitudeDegrees;
    return accepted;
  }

  /** Copies the predictive planner state without allocating on the hot path. */
  copyStateFrom(source: TileLayoutSubmissionGate): void {
    this.normalAnchor.z = source.normalAnchor.z;
    this.normalAnchor.x = source.normalAnchor.x;
    this.normalAnchor.y = source.normalAnchor.y;
    this.normalAnchor.width = source.normalAnchor.width;
    this.normalAnchor.height = source.normalAnchor.height;
    this.mode = source.mode;
    this.maxZoom = source.maxZoom;
    this.latitudeDegrees = source.latitudeDegrees;
    this.longitudeDegrees = source.longitudeDegrees;
  }

  private resetNormalAnchor(): void {
    this.normalAnchor.z = -1;
    this.updateNormalAnchor(
      this.latitudeDegrees,
      this.longitudeDegrees,
      this.maxZoom,
    );
  }

  private updateNormalAnchor(
    latitudeDegrees: number,
    longitudeDegrees: number,
    zoom: number,
  ): boolean {
    const width = 2 ** zoom;
    const underfootX = wrapTileX(
      Math.floor(mercatorTileX(longitudeDegrees, zoom)),
      zoom,
    );
    const underfootY = Math.max(
      0,
      Math.min(width - 1, Math.floor(mercatorTileY(latitudeDegrees, zoom))),
    );
    return updateTileOnionNormalAnchor(
      this.normalAnchor,
      zoom,
      underfootX,
      underfootY,
    );
  }
}

/**
 * Delegates a geographic observer target to the canonical tile-onion planner.
 * Neither the scheduler nor transition planner imports this adapter.
 */
export class TileOnionLayoutSource implements LayoutSource<TileLayoutTarget> {
  private previousState: TileOnionState | undefined;

  calculate(
    sourceTarget: Readonly<TileLayoutTarget>,
  ): readonly TileIdentity[] {
    const target = normalizeTileLayoutTarget(sourceTarget);
    const plan = calculateTileOnionPlan({
      latitudeDegrees: target.latitudeDegrees,
      longitudeDegrees: target.longitudeDegrees,
      maxZoom: target.maxZoom,
      previousState: this.previousState,
    });
    this.previousState = plan.state;
    return plan.leaves.map(({ z, x, y }) => ({ z, x, y }));
  }
}
