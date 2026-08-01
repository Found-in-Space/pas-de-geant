import { describe, expect, it, vi } from "vitest";
import {
  parseLocationToolArguments,
  RealtimeVoiceAgent,
  type RealtimeAgentStatus,
} from "../apps/pas-de-geant/src/realtime-agent.js";
import {
  locationDetailForDisplayRadius,
} from "../apps/pas-de-geant/src/location-context.js";
import {
  parseReverseGeocodeRequest,
  requestReverseGeocode,
} from "../apps/pas-de-geant/src/location-context-server.js";
import {
  isAllowedRequestOrigin,
  realtimeSessionConfiguration,
  requestRealtimeClientSecret,
} from "../apps/pas-de-geant/src/realtime-token-server.js";

function createRealtimeEventHarness(
  tools: ConstructorParameters<typeof RealtimeVoiceAgent>[0]["tools"] = {},
) {
  const statuses: RealtimeAgentStatus[] = [];
  const sentEvents: Array<Record<string, unknown>> = [];
  const agent = new RealtimeVoiceAgent({
    onStatus: (status) => statuses.push(status),
    onRemoteStream: () => undefined,
    tools,
  });
  const internal = agent as unknown as {
    dataChannel: {
      readyState: "open";
      send: (data: string) => void;
    };
    handleServerEvent: (rawEvent: unknown) => Promise<void>;
  };
  internal.dataChannel = {
    readyState: "open",
    send: (data) => sentEvents.push(JSON.parse(data) as Record<string, unknown>),
  };
  return {
    statuses,
    sentEvents,
    dispatch: (event: Record<string, unknown>) =>
      internal.handleServerEvent(JSON.stringify(event)),
  };
}

describe("Pas de Géant Realtime voice agent", () => {
  it("uses country detail below 1000x and locality detail from 1000x", () => {
    expect(locationDetailForDisplayRadius(999.99)).toBe("country");
    expect(locationDetailForDisplayRadius(1_000)).toBe("locality");
  });

  it("validates and resolves scale-appropriate reverse geocoding", async () => {
    expect(
      parseReverseGeocodeRequest(
        new URL("http://local/api/location/reverse?lat=52.37&lon=4.9&detail=locality"),
      ),
    ).toEqual({
      latitudeDegrees: 52.37,
      longitudeDegrees: 4.9,
      detail: "locality",
    });
    expect(
      parseReverseGeocodeRequest(
        new URL("http://local/api/location/reverse?lat=91&lon=4.9&detail=locality"),
      ),
    ).toBeUndefined();

    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    const result = await requestReverseGeocode(
      { latitudeDegrees: 52.37, longitudeDegrees: 4.9, detail: "locality" },
      async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = init?.headers;
        return new Response(
          JSON.stringify({
            address: {
              city: "Amsterdam",
              state: "North Holland",
              country: "Netherlands",
              country_code: "nl",
            },
          }),
        );
      },
    );
    expect(new URL(capturedUrl).searchParams.get("zoom")).toBe("12");
    expect(capturedHeaders).toMatchObject({
      "User-Agent": expect.stringContaining("Pas-de-Geant"),
    });
    expect(result).toEqual({
      country: "Netherlands",
      country_code: "NL",
      region: "North Holland",
      locality: "Amsterdam",
    });
  });

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

  it("serializes a tool continuation behind a VAD-created response", async () => {
    let resolveTool!: (value: unknown) => void;
    const toolResult = new Promise<unknown>((resolve) => {
      resolveTool = resolve;
    });
    const { dispatch, sentEvents } = createRealtimeEventHarness({
      get_user_location: () => toolResult,
    });

    await dispatch({ type: "response.created" });
    const toolTurn = dispatch({
      type: "response.done",
      response: {
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "get_user_location",
            arguments: "{}",
            call_id: "call_location",
          },
        ],
      },
    });
    await Promise.resolve();

    await dispatch({ type: "input_audio_buffer.speech_started" });
    await dispatch({ type: "input_audio_buffer.speech_stopped" });
    await dispatch({ type: "response.created" });
    resolveTool({ latitude_degrees: 52.37, longitude_degrees: 4.9 });
    await toolTurn;

    expect(sentEvents.filter(({ type }) => type === "response.create")).toEqual(
      [],
    );

    await dispatch({
      type: "response.done",
      response: { status: "completed", output: [] },
    });
    expect(sentEvents.filter(({ type }) => type === "response.create")).toHaveLength(
      1,
    );
  });

  it("waits for buffered playback before showing a terminal response error", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { dispatch, statuses } = createRealtimeEventHarness();

    await dispatch({ type: "response.created" });
    await dispatch({ type: "output_audio_buffer.started" });
    await dispatch({
      type: "response.done",
      response: {
        status: "incomplete",
        status_details: { reason: "max_output_tokens" },
        output: [],
      },
    });
    expect(statuses.at(-1)?.state).toBe("speaking");

    await dispatch({ type: "output_audio_buffer.stopped" });
    expect(statuses.at(-1)).toMatchObject({
      state: "error",
      detail: expect.stringContaining("max_output_tokens"),
    });
    warning.mockRestore();
  });

  it("preserves an API error until active playback stops", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { dispatch, statuses } = createRealtimeEventHarness();

    await dispatch({ type: "response.created" });
    await dispatch({ type: "output_audio_buffer.started" });
    await dispatch({ type: "error", error: { message: "Audio transport failed." } });
    await dispatch({
      type: "response.done",
      response: { status: "completed", output: [] },
    });
    await dispatch({ type: "output_audio_buffer.stopped" });

    expect(statuses.at(-1)).toEqual({
      state: "error",
      detail: "Audio transport failed.",
    });
    errorLog.mockRestore();
  });

  it("does not overwrite active user speech when interrupted playback is cleared", async () => {
    const { dispatch, statuses } = createRealtimeEventHarness();

    await dispatch({ type: "output_audio_buffer.started" });
    await dispatch({ type: "input_audio_buffer.speech_started" });
    await dispatch({ type: "output_audio_buffer.cleared" });

    expect(statuses.at(-1)).toEqual({
      state: "listening",
      detail: "Hearing you…",
    });
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
