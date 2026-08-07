import { Euler, Quaternion, Vector2 } from "three";
import { describe, expect, it, vi } from "vitest";
import {
  parseLocationToolArguments,
  RealtimeVoiceAgent,
  type RealtimeAgentStatus,
} from "../apps/pas-de-geant/src/realtime-agent.js";
import {
  parseReverseGeocodeRequest,
  requestReverseGeocode,
} from "../apps/pas-de-geant/src/location-context-server.js";
import {
  isAllowedRequestOrigin,
  realtimeSessionConfiguration,
  requestRealtimeClientSecret,
} from "../apps/pas-de-geant/src/realtime-token-server.js";
import {
  geographicTravelFromWorld,
  geographicViewHeadingDegrees,
  parseViewDirectionToolArguments,
  viewHeadingDegreesFromQuaternion,
  worldRotationForViewDirection,
} from "../apps/pas-de-geant/src/view-direction.js";

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
  it("validates and resolves precise, descriptive reverse geocoding", async () => {
    expect(
      parseReverseGeocodeRequest(
        new URL("http://local/api/location/reverse?lat=52.370216123&lon=4.895168456&detail=address"),
      ),
    ).toEqual({
      latitudeDegrees: 52.370216123,
      longitudeDegrees: 4.895168456,
      detail: "address",
    });
    expect(
      parseReverseGeocodeRequest(
        new URL("http://local/api/location/reverse?lat=91&lon=4.9&detail=address"),
      ),
    ).toBeUndefined();

    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    const result = await requestReverseGeocode(
      {
        latitudeDegrees: 52.370216123,
        longitudeDegrees: 4.895168456,
        detail: "address",
      },
      async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = init?.headers;
        return new Response(
          JSON.stringify({
            name: "Dam Square",
            display_name:
              "Dam Square, Centrum, Amsterdam, North Holland, Netherlands",
            category: "place",
            addresstype: "square",
            address: {
              road: "Dam",
              neighbourhood: "Burgwallen Nieuwe Zijde",
              postcode: "1012 JS",
              city: "Amsterdam",
              state: "North Holland",
              country: "Netherlands",
              country_code: "nl",
            },
          }),
        );
      },
    );
    const lookupUrl = new URL(capturedUrl);
    expect(lookupUrl.searchParams.get("zoom")).toBe("18");
    expect(lookupUrl.searchParams.get("lat")).toBe("52.370216123");
    expect(lookupUrl.searchParams.get("lon")).toBe("4.895168456");
    expect(lookupUrl.searchParams.get("layer")).toContain("natural");
    expect(capturedHeaders).toMatchObject({
      "User-Agent": expect.stringContaining("Pas-de-Geant"),
    });
    expect(result).toEqual({
      display_name:
        "Dam Square, Centrum, Amsterdam, North Holland, Netherlands",
      name: "Dam Square",
      category: "place",
      feature_type: "square",
      house_number: undefined,
      road: "Dam",
      neighbourhood: "Burgwallen Nieuwe Zijde",
      suburb: undefined,
      district: undefined,
      postcode: "1012 JS",
      county: undefined,
      country: "Netherlands",
      country_code: "NL",
      region: "North Holland",
      locality: "Amsterdam",
      water: undefined,
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

  it("maps absolute and relative voice turns onto geographic headings", () => {
    expect(parseViewDirectionToolArguments({
      mode: "relative",
      degrees: 90,
    })).toEqual({ mode: "relative", degrees: 90 });
    expect(() => parseViewDirectionToolArguments({
      mode: "sideways",
      degrees: 90,
    })).toThrow("mode");

    const headsetQuaternion = new Quaternion().setFromEuler(
      new Euler(-0.6, -Math.PI / 2, 0, "YXZ"),
    );
    const headsetWorldHeading = viewHeadingDegreesFromQuaternion(
      headsetQuaternion,
    );
    expect(headsetWorldHeading).toBeCloseTo(90);

    let worldRotation = worldRotationForViewDirection(
      0,
      headsetWorldHeading,
      { mode: "absolute", degrees: 270 },
    );
    expect(
      geographicViewHeadingDegrees(headsetWorldHeading, worldRotation),
    ).toBeCloseTo(270);
    worldRotation = worldRotationForViewDirection(
      worldRotation,
      headsetWorldHeading,
      { mode: "relative", degrees: 90 },
    );
    expect(
      geographicViewHeadingDegrees(headsetWorldHeading, worldRotation),
    ).toBeCloseTo(0);
  });

  it("keeps travel aligned with the world after a voice rotation", () => {
    const geographicTravel = geographicTravelFromWorld(
      new Vector2(-1, 0),
      Math.PI / 2,
    );
    expect(geographicTravel.x).toBeCloseTo(0);
    expect(geographicTravel.y).toBeCloseTo(-1);
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
        instructions: string;
        audio: { input: { turn_detection: { type: string } } };
        tools: Array<{
          name: string;
          description: string;
          parameters: {
            required?: string[];
            properties?: {
              target?: { enum?: string[] };
              mode?: { enum?: string[] };
            };
          };
        }>;
      };
    };
    expect(configuration.session.model).toBe("gpt-realtime-2.1");
    expect(configuration.session.audio.input.turn_detection.type).toBe(
      "server_vad",
    );
    expect(configuration.session.tools.map((tool) => tool.name)).toEqual([
      "get_user_location",
      "set_user_location",
      "get_view_direction",
      "set_view_direction",
      "search_wikipedia",
      "search_web",
      "get_aircraft_display",
      "set_aircraft_display",
      "get_tile_debug_controls",
      "get_tile_planner_state",
      "set_tile_pixel_ratio",
      "set_tile_max_zoom",
      "set_tile_view_distance",
      "set_tile_view_overhead",
      "set_tile_delta_zoom_cap",
      "set_tile_recalculation",
    ]);
    expect(configuration.session.instructions).toContain(
      "call get_tile_debug_controls before reporting current values",
    );
    expect(configuration.session.instructions).toContain(
      "leave all unrelated controls unchanged",
    );
    expect(configuration.session.instructions).toContain(
      "authoritative high-precision live app position",
    );
    expect(configuration.session.instructions).toContain(
      "positive degrees turn clockwise/right",
    );
    expect(configuration.session.instructions).toContain(
      "set_aircraft_display to turn either one on or off",
    );
    expect(configuration.session.instructions).toContain(
      "call get_tile_planner_state",
    );
    expect(configuration.session.instructions).toContain(
      "must not be conflated",
    );
    expect(configuration.session.instructions).toContain(
      "report planner failures",
    );
    expect(configuration.session.instructions).toContain(
      "Use search_wikipedia for stable encyclopedic or background topics",
    );
    expect(configuration.session.instructions).toContain(
      "Use search_web for current, recent, or niche information",
    );
    expect(configuration.session.instructions).toContain(
      "Never claim to have browsed or searched unless you called one of these search tools",
    );
    expect(configuration.session.instructions).toContain(
      "never read URLs aloud",
    );
    expect(configuration.session.instructions).toContain(
      "If a follow-up needs more detail, run a narrower search",
    );
    const viewDirectionTool = configuration.session.tools.find(
      ({ name }) => name === "set_view_direction",
    );
    expect(viewDirectionTool?.parameters.required).toEqual([
      "mode",
      "degrees",
    ]);
    expect(viewDirectionTool?.parameters.properties?.mode?.enum).toEqual([
      "absolute",
      "relative",
    ]);
    for (const name of ["search_wikipedia", "search_web"]) {
      const tool = configuration.session.tools.find((candidate) =>
        candidate.name === name
      );
      expect(tool?.parameters.required).toEqual(["query"]);
      expect(tool?.description).toContain("substantive");
    }
    expect(configuration.session.tools.find(
      ({ name }) => name === "get_tile_planner_state",
    )?.description).toContain("source jobs are distinct layers");
    const aircraftDisplayTool = configuration.session.tools.find(
      ({ name }) => name === "set_aircraft_display",
    );
    expect(aircraftDisplayTool?.parameters.required).toEqual([
      "target",
      "enabled",
    ]);
    expect(aircraftDisplayTool?.parameters.properties?.target?.enum).toEqual([
      "aircraft",
      "labels",
    ]);
    expect(configuration.session.tools.find(
      ({ name }) => name === "set_tile_view_distance",
    )?.description).toContain("loads the full current tile onion");
    expect(configuration.session.tools.find(
      ({ name }) => name === "set_tile_delta_zoom_cap",
    )?.description).toContain("N+1 bands");
    const recalculationTool = configuration.session.tools.find(
      ({ name }) => name === "set_tile_recalculation",
    );
    expect(recalculationTool?.parameters.required).toEqual([
      "target",
      "enabled",
    ]);
    expect(recalculationTool?.parameters.properties?.target?.enum).toEqual([
      "terrain",
      "textures",
      "both",
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
