import type {
  VoiceConnection,
  VoiceToolContract,
  VoiceToolHandlers,
  VoiceTransport,
} from "@found-in-space/voice-os";
import { createBrowserVoiceAudio } from "@found-in-space/voice-os/browser";
import { createOpenAIRealtimeTransport } from "@found-in-space/voice-os/openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeantVoiceAgent } from "../apps/pas-de-geant/src/voice-agent.js";
import {
  EARTH_VOICE_TOOLS,
  ECLIPSE_VOICE_TOOLS,
} from "../apps/pas-de-geant/src/voice-contracts.js";

vi.mock("@found-in-space/voice-os/browser", () => ({
  createBrowserVoiceAudio: vi.fn(),
}));
vi.mock("@found-in-space/voice-os/openai", () => ({
  createOpenAIRealtimeTransport: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

function createHostHarness() {
  const sessions: Array<Parameters<VoiceTransport["connect"]>[0]> = [];
  const connection: VoiceConnection = {
    requestResponse: vi.fn(() => true),
    sendToolResult: vi.fn(() => true),
    replaceContext: vi.fn(async () => undefined),
    publishEvent: vi.fn(async () => undefined),
    resumePlayback: vi.fn(async () => undefined),
    close: vi.fn(),
  };
  const connect = vi.fn<VoiceTransport["connect"]>(async options => {
    sessions.push(options);
    await options.emit({ type: "ready" });
    return connection;
  });
  const audio = {
    setStream: vi.fn(),
    resume: vi.fn(async () => true),
    dispose: vi.fn(),
  };
  vi.mocked(createBrowserVoiceAudio).mockReturnValue(audio);
  vi.mocked(createOpenAIRealtimeTransport).mockReturnValue({ connect });
  return {
    connection, connect, audio,
    get session() {
      const session = sessions.at(-1);
      if (!session) throw new Error("Voice has not connected.");
      return session;
    },
  };
}

function handlersFor<T extends readonly VoiceToolContract[]>(contracts: T) {
  const execute = vi.fn((value: unknown) => ({ status: "completed", value }));
  return {
    execute,
    handlers: Object.fromEntries(contracts.map(({ name }) => [name, execute])) as unknown as VoiceToolHandlers<T>,
  };
}

describe("Geant VoiceOS host adapter", () => {
  it.each(["earth", "eclipse"] as const)("binds the %s profile to application commands and cleans up", async experience => {
    const host = createHostHarness();
    const onStatus = vi.fn();
    const earth = handlersFor(EARTH_VOICE_TOOLS);
    const eclipse = handlersFor(ECLIPSE_VOICE_TOOLS);
    const voice = createGeantVoiceAgent(experience === "earth"
      ? { onStatus, tools: earth.handlers }
      : { experience, onStatus, tools: eclipse.handlers, greetingInstructions: "Explore a solar eclipse." });

    expect(host.connect).not.toHaveBeenCalled();
    expect(voice.active).toBe(false);
    await voice.toggle();
    expect(voice.active).toBe(true);
    expect(createOpenAIRealtimeTransport).toHaveBeenCalledWith(expect.objectContaining({
      sessionEndpoint: "/api/realtime/token", profile: experience, audio: host.audio,
    }));
    expect(host.session.turnMode).toBe("automatic");
    expect(host.session.tools).toEqual(experience === "earth" ? EARTH_VOICE_TOOLS : ECLIPSE_VOICE_TOOLS);
    expect(host.connection.requestResponse).toHaveBeenCalledWith(experience === "earth"
      ? expect.stringContaining("ask about the world") : "Explore a solar eclipse.");

    const value = experience === "earth" ? {} : { scale_denominator: 100 };
    await host.session.emit({ type: "response-start", id: "tool-response" });
    await host.session.emit({
      type: "response-done", id: "tool-response", status: "completed",
      calls: [{ id: "command", name: experience === "earth" ? "get_navigation_state" : "set_eclipse_scale", arguments: JSON.stringify(value) }],
    });
    expect((experience === "earth" ? earth : eclipse).execute).toHaveBeenCalledWith(value, expect.objectContaining({
      callId: "command", signal: host.session.signal,
    }));
    expect(host.connection.sendToolResult).toHaveBeenCalledWith("command", { status: "completed", value });

    await voice.dispose();
    expect(host.session.signal.aborted).toBe(true);
    expect(host.connection.close).toHaveBeenCalledOnce();
    expect(host.audio.dispose).toHaveBeenCalledOnce();
    expect(voice.active).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith({ state: "off", detail: "Press A to wake" });
  });

  it("recovers blocked playback through the controller toggle before disabling", async () => {
    const host = createHostHarness();
    const onStatus = vi.fn();
    const voice = createGeantVoiceAgent({ onStatus, tools: handlersFor(EARTH_VOICE_TOOLS).handlers });
    await voice.enable();
    await host.session.emit({ type: "playback-blocked" });
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ detail: "Tap to enable voice audio" }));
    await voice.toggle();
    expect(host.connection.resumePlayback).toHaveBeenCalledOnce();
    expect(voice.active).toBe(true);
    await host.session.emit({ type: "playback-resumed" });
    await voice.toggle();
    expect(voice.active).toBe(false);
    await voice.dispose();
  });
});
