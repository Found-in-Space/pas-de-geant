import { describe, expect, it } from "vitest";
import {
  TileRequestCircuit,
} from "../apps/pas-de-geant/src/tile-request-circuit.js";

describe("Tile request circuit", () => {
  it("preserves the longest cooldown from concurrent provider failures", () => {
    const circuit = new TileRequestCircuit();
    circuit.recordFailure({
      systemic: true,
      status: 429,
      retryAfterMs: 60_000,
    }, false, 1_000);
    circuit.recordFailure({
      systemic: true,
      status: 503,
      retryAfterMs: 1_000,
    }, false, 1_100);

    expect(circuit.diagnostics.cooldown_until_ms).toBe(61_000);
    expect(circuit.mayStart(60_999)).toBe(false);
    expect(circuit.mayStart(61_000)).toBe(true);
  });

  it("closes a half-open probe after a tile-local response", () => {
    const circuit = new TileRequestCircuit();
    circuit.tryStart(0);
    circuit.recordFailure({
      systemic: true,
      status: 429,
      retryAfterMs: 0,
    }, false, 0);
    expect(circuit.tryStart(0)).toBe("probe");

    expect(circuit.recordFailure({
      systemic: false,
      status: 404,
    }, true, 0)).toBe(false);

    expect(circuit.state).toBe("closed");
    expect(circuit.tryStart(0)).toBe("normal");
    expect(circuit.diagnostics.status_counts).toEqual({
      "404": 1,
      "429": 1,
    });
  });

  it("keeps a fatal session disabled after later in-flight failures", () => {
    const circuit = new TileRequestCircuit();

    expect(circuit.tryStart()).toBe("normal");
    expect(circuit.recordFailure({
      systemic: true,
      status: 403,
      retryable: false,
    }, false)).toBe(true);
    expect(circuit.state).toBe("disabled");

    // This represents a second request that was already in flight when the
    // fatal response arrived. Its transient failure cannot reopen the circuit.
    expect(circuit.recordFailure({
      systemic: true,
      status: 503,
    }, false)).toBe(false);
    expect(circuit.state).toBe("disabled");
    expect(circuit.tryStart()).toBeUndefined();
    expect(circuit.diagnostics.status_counts).toEqual({
      "403": 1,
      "503": 1,
    });
  });
});
