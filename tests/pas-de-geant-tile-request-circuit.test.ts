import { describe, expect, it } from "vitest";
import {
  TileRequestCircuit,
} from "../apps/pas-de-geant/src/tile-request-circuit.js";

describe("Tile request circuit", () => {
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
