import { describe, expect, it } from "vitest";
import {
  parseLocationToolArguments,
} from "../apps/pas-de-geant/src/realtime-agent.js";
import {
  isAllowedRequestOrigin,
  realtimeSessionConfiguration,
  requestRealtimeClientSecret,
} from "../apps/pas-de-geant/src/realtime-token-server.js";

describe("Pas de Géant Realtime voice agent", () => {
  it("accepts valid location tool arguments and rejects unsafe coordinates", () => {
    expect(
      parseLocationToolArguments({
        latitude_degrees: 48.8566,
        longitude_degrees: 2.3522,
      }),
    ).toEqual({ latitudeDegrees: 48.8566, longitudeDegrees: 2.3522 });
    expect(() =>
      parseLocationToolArguments({
        latitude_degrees: 91,
        longitude_degrees: 2.3522,
      }),
    ).toThrow("Latitude");
  });

  it("configures always-on VAD and the in-app location tools", () => {
    const configuration = realtimeSessionConfiguration() as {
      session: {
        model: string;
        audio: { input: { turn_detection: { type: string } } };
        tools: Array<{ name: string }>;
      };
    };
    expect(configuration.session.model).toBe("gpt-realtime-2.1");
    expect(configuration.session.audio.input.turn_detection.type).toBe(
      "server_vad",
    );
    expect(configuration.session.tools.map((tool) => tool.name)).toEqual([
      "get_user_location",
      "set_user_location",
    ]);
  });

  it("keeps the standard API key in the server-side client-secret request", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ value: "ek_test" }), {
        status: 200,
      });
    };
    const result = await requestRealtimeClientSecret(
      "sk-server-only",
      fetchImplementation,
    );

    expect(result).toEqual({
      status: 200,
      body: JSON.stringify({ value: "ek_test" }),
    });
    expect(capturedInit?.headers).toMatchObject({
      Authorization: "Bearer sk-server-only",
    });
  });

  it("allows same-origin token requests and rejects cross-origin callers", () => {
    expect(
      isAllowedRequestOrigin(
        "https://geant.dev.k-si.com",
        "geant.dev.k-si.com",
      ),
    ).toBe(true);
    expect(
      isAllowedRequestOrigin("https://malicious.example", "127.0.0.1:4197"),
    ).toBe(false);
    expect(isAllowedRequestOrigin("not a URL", "127.0.0.1:4197")).toBe(false);
  });
});
