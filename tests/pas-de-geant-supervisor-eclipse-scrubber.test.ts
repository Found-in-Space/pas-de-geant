import { describe, expect, it } from "vitest";
import { SupervisorEclipseScrubber } from "../apps/pas-de-geant/src/supervisor-eclipse-scrubber.js";

interface ScheduledTimer {
  readonly callback: () => void;
  readonly delayMs: number;
}

describe("supervisor eclipse scrubber", () => {
  it("streams the latest position no faster than five times per second", () => {
    let nowMs = 0;
    let nextCommand = 1;
    const sent: Array<{ utc: string; final: boolean; commandId: string }> = [];
    const timers: ScheduledTimer[] = [];
    const scrubber = new SupervisorEclipseScrubber({
      now: () => nowMs,
      setTimer(callback, delayMs) {
        timers.push({ callback, delayMs });
        return callback;
      },
      clearTimer(timer) {
        const index = timers.findIndex(({ callback }) => callback === timer);
        if (index >= 0) timers.splice(index, 1);
      },
      send(utc, final) {
        const commandId = `command-${nextCommand++}`;
        sent.push({ utc, final, commandId });
        return commandId;
      },
    });

    scrubber.update("start");
    expect(sent).toEqual([
      { utc: "start", final: false, commandId: "command-1" },
    ]);
    nowMs = 50;
    scrubber.update("middle");
    expect(scrubber.acknowledge("command-1", true)).toBe("streaming");
    expect(timers).toHaveLength(1);
    expect(timers[0]!.delayMs).toBe(150);
    scrubber.update("latest");
    nowMs = 200;
    timers.shift()!.callback();
    expect(sent[1]).toEqual({
      utc: "latest",
      final: false,
      commandId: "command-2",
    });
  });

  it("sends the exact released position even with an update in flight", () => {
    let nextCommand = 1;
    const sent: Array<{ utc: string; final: boolean; commandId: string }> = [];
    const scrubber = new SupervisorEclipseScrubber({
      send(utc, final) {
        const commandId = `command-${nextCommand++}`;
        sent.push({ utc, final, commandId });
        return commandId;
      },
    });

    scrubber.update("streamed");
    scrubber.finish("released");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      utc: "released",
      final: true,
      commandId: "command-2",
    });
    expect(scrubber.acknowledge("command-1", true)).toBe("streaming");
    expect(scrubber.acknowledge("command-2", true)).toBe("complete");
  });

  it("marks only the release command as completion", () => {
    let nextCommand = 1;
    const scrubber = new SupervisorEclipseScrubber({
      send: () => `command-${nextCommand++}`,
    });
    scrubber.update("released");
    scrubber.finish("released");
    expect(scrubber.acknowledge("command-1", true)).toBe("streaming");
    expect(scrubber.acknowledge("command-2", true)).toBe("complete");
  });
});
