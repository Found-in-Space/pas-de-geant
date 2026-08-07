import type { IncomingMessage, ServerResponse } from "node:http";

type FetchImplementation = typeof fetch;

export const REALTIME_TOKEN_PATH = "/api/realtime/token";

export function isAllowedRequestOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
): boolean {
  if (!origin) return true;
  if (!requestHost) return false;
  try {
    return new URL(origin).host === requestHost;
  } catch {
    return false;
  }
}

export function realtimeSessionConfiguration(): Record<string, unknown> {
  return {
    expires_after: { anchor: "created_at", seconds: 600 },
    session: {
      type: "realtime",
      model: "gpt-realtime-2.1",
      instructions:
        "You are the concise, warm voice guide inside Pas de Géant, a " +
        "room-scale relief Earth experience. Answer conversationally in one or " +
        "two short sentences. Ask only one question at a time and give only one " +
        "step at a time. After using a tool, summarize only the result the user " +
        "needs. The position shown by the app is the place under " +
        "the user’s feet. Use get_user_location before answering questions that " +
        "depend on the current position. Its latitude_degrees and " +
        "longitude_degrees are the authoritative high-precision live app " +
        "position in WGS 84. named_location is a detailed but approximate " +
        "reverse-geocode of the nearest mapped feature; do not replace the live " +
        "coordinates with values inferred from its label, and do not invent a " +
        "place when named_location is null. Use get_view_direction before " +
        "reporting the current compass heading. Use set_view_direction with " +
        "mode relative for requests such as look right, left, or behind: positive " +
        "degrees turn clockwise/right and negative degrees turn left. Treat an " +
        "unqualified look right or left as a 90-degree turn and behind as 180 " +
        "degrees. Use mode " +
        "absolute for compass directions and requests such as rotate view to 270 " +
        "degrees, where 0 is north, 90 east, 180 south, and 270 west. When " +
        "the user asks to go, move, " +
        "travel, or teleport to a place and you know reasonable coordinates, use " +
        "set_user_location. Be clear when coordinates are approximate. " +
        "Use set_satellite_group_visibility when the user asks to show, hide, " +
        "turn on, or turn off the brightest satellites, space stations, or " +
        "science and education satellites. These are three independent groups, " +
        "so change only the requested group. " +
        "Use get_celestial_visibility before reporting which Solar System " +
        "bodies are shown. Use set_celestial_visibility to show or hide the " +
        "Sun, Moon, any named planet, the Sun and Moon together, all planets, " +
        "or all Solar System bodies. These controls do not affect the background " +
        "star catalogue; change only the requested body or group. " +
        "Use search_wikipedia for stable encyclopedic or background topics. Use " +
        "search_web for current, recent, or niche information and whenever the " +
        "user explicitly asks to browse or search the web. Never claim to have " +
        "browsed or searched unless you called one of these search tools. After " +
        "a search, speak the substantive answer in one or two sentences and " +
        "optionally name one or two relevant source titles; never read URLs " +
        "aloud. If a follow-up needs more detail, run a narrower search. Keep " +
        "fetched external facts distinct from live app state. Use " +
        "get_aircraft_display before reporting whether live aircraft symbols " +
        "or radar labels are enabled. Use set_aircraft_display to turn either " +
        "one on or off without changing the other. For tile " +
        "debugging, call get_tile_debug_controls before reporting current values. " +
        "For questions about tile loading, replanning, waiting, queued or " +
        "in-flight work, transition completion, or scheduler health, call " +
        "get_tile_planner_state. Tile payload requests and provider source " +
        "fetches are different layers and their counts must not be conflated. " +
        "Always report planner failures when the failed count is nonzero. " +
        "Use the narrow mutation tool matching the requested change, leave all " +
        "unrelated controls unchanged, and after a mutation report the actual " +
        "state returned by the tool.",
      audio: {
        input: {
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "server_vad",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: "marin" },
      },
      tools: [
        {
          type: "function",
          name: "get_user_location",
          description:
            "Read the authoritative high-precision WGS 84 coordinates, display " +
            "scale, and detailed approximate reverse-geocoded place context " +
            "currently under the user’s feet.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          type: "function",
          name: "set_user_location",
          description:
            "Move the globe so a latitude and longitude are directly under the user’s feet.",
          parameters: {
            type: "object",
            properties: {
              latitude_degrees: {
                type: "number",
                minimum: -90,
                maximum: 90,
                description: "Latitude in decimal degrees, north positive.",
              },
              longitude_degrees: {
                type: "number",
                minimum: -180,
                maximum: 180,
                description: "Longitude in decimal degrees, east positive.",
              },
            },
            required: ["latitude_degrees", "longitude_degrees"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "get_view_direction",
          description:
            "Read the direction the user is looking as a compass heading in degrees clockwise from geographic north.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          type: "function",
          name: "set_view_direction",
          description:
            "Rotate the virtual world around the user. Use absolute to face a compass heading (0 north, 90 east, 180 south, 270 west), or relative to turn by signed degrees (positive clockwise/right, negative left).",
          parameters: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: ["absolute", "relative"],
                description:
                  "Whether degrees is a compass heading or a signed relative turn.",
              },
              degrees: {
                type: "number",
                description:
                  "Compass heading for absolute mode, or signed clockwise turn for relative mode.",
              },
            },
            required: ["mode", "degrees"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_satellite_group_visibility",
          description:
            "Turn one satellite group on or off without changing either of the other satellite groups.",
          parameters: {
            type: "object",
            properties: {
              group: {
                type: "string",
                enum: [
                  "brightest",
                  "space_stations",
                  "science_education",
                ],
              },
              enabled: { type: "boolean" },
            },
            required: ["group", "enabled"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "get_celestial_visibility",
          description:
            "Read which Solar System sky objects are currently shown: the Sun, Moon, and each planet.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          type: "function",
          name: "set_celestial_visibility",
          description:
            "Show or hide one Solar System body or a celestial group without changing the background stars.",
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                enum: [
                  "sun",
                  "moon",
                  "mercury",
                  "venus",
                  "mars",
                  "jupiter",
                  "saturn",
                  "uranus",
                  "neptune",
                  "sun_and_moon",
                  "planets",
                  "all",
                ],
              },
              enabled: { type: "boolean" },
            },
            required: ["target", "enabled"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "search_wikipedia",
          description:
            "Search English Wikipedia for stable encyclopedic or background facts. Returns substantive article intro summaries plus quiet citation provenance.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                minLength: 1,
                description: "A focused non-blank encyclopedic search query.",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "search_web",
          description:
            "Search the live web for current, recent, or niche information. Returns a substantive concise answer with source-attributed evidence and quiet citation provenance.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                minLength: 1,
                description: "A focused non-blank web search query.",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "get_aircraft_display",
          description:
            "Read whether live aircraft symbols and radar-style information labels are enabled, plus the current nearby aircraft count.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          type: "function",
          name: "set_aircraft_display",
          description:
            "Turn live aircraft symbols or their radar-style information labels on or off without changing the other display setting.",
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                enum: ["aircraft", "labels"],
              },
              enabled: { type: "boolean" },
            },
            required: ["target", "enabled"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "get_tile_debug_controls",
          description:
            "Read every current terrain and texture tile-debug control, including effective target zooms.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          type: "function",
          name: "get_tile_planner_state",
          description:
            "Read terrain and texture planner, transition, payload-request, source-fetch, and residency state. Use this for loading progress, queued or in-flight work, completion, failures, and scheduler health. Tile payload requests and shared provider source jobs are distinct layers.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          type: "function",
          name: "set_tile_pixel_ratio",
          description:
            "Set screen pixels per source pixel for terrain, textures, or both. Larger values select coarser topology.",
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                enum: ["terrain", "textures", "both"],
              },
              screen_pixels_per_source_pixel: {
                type: "number",
                exclusiveMinimum: 0,
              },
            },
            required: ["target", "screen_pixels_per_source_pixel"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_tile_max_zoom",
          description:
            "Enable a topology maximum zoom for terrain, textures, or both, or disable it to restore the uncapped default.",
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                enum: ["terrain", "textures", "both"],
              },
              enabled: { type: "boolean" },
              max_zoom: { type: "integer", minimum: 0 },
            },
            required: ["target", "enabled"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_tile_view_distance",
          description:
            "Enable warm view-distance buffering for terrain, textures, or both. Setting enabled=false loads the full current tile onion instead of only the buffered view region.",
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                enum: ["terrain", "textures", "both"],
              },
              enabled: { type: "boolean" },
            },
            required: ["target", "enabled"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_tile_view_overhead",
          description:
            "Set the nonnegative percentage added to eye height for warm view-distance buffering in both pipelines.",
          parameters: {
            type: "object",
            properties: {
              overhead_percent: { type: "number", minimum: 0 },
            },
            required: ["overhead_percent"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_tile_delta_zoom_cap",
          description:
            "Enable a payload delta-zoom cap for terrain, textures, or both, or disable it. A delta N loads N+1 bands: finest z through z-N; for example N=3 loads z, z-1, z-2, and z-3.",
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                enum: ["terrain", "textures", "both"],
              },
              enabled: { type: "boolean" },
              delta_zoom: { type: "integer", minimum: 0 },
            },
            required: ["target", "enabled"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_tile_recalculation",
          description:
            "Enable or freeze target and residency recalculation for terrain, textures, or both. A frozen pipeline preserves its current selection while rendering and in-flight work continue.",
          parameters: {
            type: "object",
            properties: {
              target: {
                type: "string",
                enum: ["terrain", "textures", "both"],
              },
              enabled: { type: "boolean" },
            },
            required: ["target", "enabled"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: "auto",
    },
  };
}

export async function requestRealtimeClientSecret(
  apiKey: string,
  fetchImplementation: FetchImplementation = fetch,
): Promise<{ status: number; body: string }> {
  const response = await fetchImplementation(
    "https://api.openai.com/v1/realtime/client_secrets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(realtimeSessionConfiguration()),
    },
  );
  if (!response.ok) {
    return {
      status: response.status,
      body: JSON.stringify({
        error: `OpenAI could not create a Realtime session (${response.status}).`,
      }),
    };
  }
  return { status: 200, body: await response.text() };
}

export function createRealtimeTokenMiddleware(apiKey: string | undefined) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const pathname = new URL(request.url ?? "/", "http://local").pathname;
    if (pathname !== REALTIME_TOKEN_PATH) {
      next();
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("Allow", "POST");
      response.end(JSON.stringify({ error: "Method not allowed." }));
      return;
    }
    const origin = request.headers.origin;
    const forwardedHost = request.headers["x-forwarded-host"];
    const requestHost =
      (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
        ?.split(",")[0]
        ?.trim() ?? request.headers.host;
    if (!isAllowedRequestOrigin(origin, requestHost)) {
      response.statusCode = 403;
      response.end(
        JSON.stringify({ error: "Cross-origin requests are denied." }),
      );
      return;
    }
    if (!apiKey) {
      response.statusCode = 503;
      response.end(
        JSON.stringify({
          error: "Voice is unavailable: the local server needs OPENAI_API_KEY.",
        }),
      );
      return;
    }
    try {
      const result = await requestRealtimeClientSecret(apiKey);
      response.statusCode = result.status;
      response.end(result.body);
    } catch (error) {
      console.error("Realtime client-secret request failed:", error);
      response.statusCode = 502;
      response.end(JSON.stringify({ error: "Voice session setup failed." }));
    }
  };
}
