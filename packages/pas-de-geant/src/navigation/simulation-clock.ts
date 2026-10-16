export interface SimulationClockState {
  readonly anchorWallTimeMs: number;
  readonly offsetMs: number;
  readonly scale: number;
}

export interface SimulationClockSnapshot extends SimulationClockState {
  readonly atMs: number;
}

function finite(value: number, description: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${description} must be finite.`);
  }
  return value;
}

export function realtimeSimulationClock(
  wallTimeMs = Date.now(),
): SimulationClockState {
  return {
    anchorWallTimeMs: finite(wallTimeMs, "Wall time"),
    offsetMs: 0,
    scale: 1,
  };
}

export function anchoredSimulationClock(
  atMs: number,
  scale: number,
  wallTimeMs = Date.now(),
): SimulationClockState {
  const anchorWallTimeMs = finite(wallTimeMs, "Wall time");
  return {
    anchorWallTimeMs,
    offsetMs: finite(atMs, "Simulation time") - anchorWallTimeMs,
    scale: finite(scale, "Simulation scale"),
  };
}

export function simulationTimeMs(
  clock: SimulationClockState,
  wallTimeMs = Date.now(),
): number {
  return clock.anchorWallTimeMs + clock.offsetMs +
    (finite(wallTimeMs, "Wall time") - clock.anchorWallTimeMs) * clock.scale;
}

export function simulationClockWithScale(
  clock: SimulationClockState,
  scale: number,
  wallTimeMs = Date.now(),
): SimulationClockState {
  return anchoredSimulationClock(
    simulationTimeMs(clock, wallTimeMs),
    scale,
    wallTimeMs,
  );
}

export function simulationClockSnapshot(
  clock: SimulationClockState,
  wallTimeMs = Date.now(),
): SimulationClockSnapshot {
  return {
    ...clock,
    atMs: simulationTimeMs(clock, wallTimeMs),
  };
}
