import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealtimeTokenMiddleware } from "../apps/pas-de-geant/src/realtime-token-server.js";
import { EARTH_VOICE_TOOLS, ECLIPSE_VOICE_TOOLS } from "../apps/pas-de-geant/src/voice-contracts.js";

afterEach(() => vi.unstubAllGlobals());

async function requestToken(query: string, origin = "http://localhost:4197", method = "POST") {
  const request = new IncomingMessage(new Socket());
  request.url = `/api/realtime/token${query}`;
  request.method = method;
  request.headers.origin = origin;
  const response = new ServerResponse(request);
  const end = vi.spyOn(response, "end").mockReturnValue(response);
  await createRealtimeTokenMiddleware("server-only-test-key")(request, response, () => {
    throw new Error("The voice route must be handled.");
  });
  return { response, body: JSON.parse(String(end.mock.calls[0]?.[0])) as Record<string, unknown> };
}

describe("Geant VoiceOS session endpoint", () => {
  it.each([
    ["", "earth"],
    ["?profile=earth", "earth"],
    ["?profile=eclipse", "eclipse"],
    ["?experience=eclipse", "eclipse"],
    ["?profile=eclipse&experience=eclipse", "eclipse"],
  ] as const)("issues a matching browser contract for %s", async (query, profile) => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ value: "ephemeral-test-key" })));
    vi.stubGlobal("fetch", upstream);
    const { response, body } = await requestToken(query);
    const tools = profile === "earth" ? EARTH_VOICE_TOOLS : ECLIPSE_VOICE_TOOLS;
    expect(response.statusCode).toBe(200);
    expect(response.getHeader("cache-control")).toBe("no-store");
    expect(body).toEqual({ value: "ephemeral-test-key", voiceOs: { contractVersion: 1, profile, tools, turnMode: "automatic" } });
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    const configuration = JSON.parse(String(init?.body));
    expect(configuration.session.tools).toEqual(tools.map(tool => ({ type: "function", ...tool })));
    expect(configuration.session.audio.input.turn_detection).toMatchObject({
      type: "server_vad", create_response: true, interrupt_response: true,
    });
  });

  it.each([
    ["?profile=moon", "http://localhost:4197", "POST", 400],
    ["?profile=eclipse&experience=earth", "http://localhost:4197", "POST", 400],
    ["?profile=earth", "https://untrusted.example", "POST", 403],
    ["?profile=earth", "http://localhost:4197", "GET", 405],
  ] as const)("rejects %s from %s using %s before requesting a secret", async (query, origin, method, status) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const { response } = await requestToken(query, origin, method);
    expect(response.statusCode).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });
});
