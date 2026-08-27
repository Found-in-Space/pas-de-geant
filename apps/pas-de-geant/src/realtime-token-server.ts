import type { IncomingMessage, ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";

type FetchImplementation = typeof fetch;

export const REALTIME_TOKEN_PATH = "/api/realtime/token";
export type RealtimeExperience = "earth" | "eclipse";

export function realtimeExperienceFromUrl(url: URL): RealtimeExperience | null {
  const value = url.searchParams.get("experience");
  if (value === null || value === "earth") return "earth";
  if (value === "eclipse") return "eclipse";
  return null;
}

const PRIVATE_NETWORKS = new BlockList();
PRIVATE_NETWORKS.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("100.64.0.0", 10, "ipv4");
PRIVATE_NETWORKS.addSubnet("127.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("169.254.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NETWORKS.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addAddress("::1", "ipv6");
PRIVATE_NETWORKS.addSubnet("fc00::", 7, "ipv6");
PRIVATE_NETWORKS.addSubnet("fe80::", 10, "ipv6");

export function isAllowedConnectionHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (normalized === "k-si.com" || normalized.endsWith(".k-si.com")) {
    return true;
  }
  const address = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  const version = isIP(address);
  return version !== 0 && PRIVATE_NETWORKS.check(
    address,
    version === 4 ? "ipv4" : "ipv6",
  );
}

export function isAllowedRequestOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      isAllowedConnectionHostname(url.hostname);
  } catch {
    return false;
  }
}

export function realtimeSessionConfiguration(
  experience: RealtimeExperience = "earth",
): Record<string, unknown> {
  if (experience === "eclipse") {
    return eclipseRealtimeSessionConfiguration();
  }
  return {
    expires_after: { anchor: "created_at", seconds: 600 },
    session: {
      type: "realtime",
      model: "gpt-realtime-2.1",
      instructions:
        "You are the concise, warm voice guide inside Pas de Géant, a " +
        "room-scale Solar System experience. The user can stand on Earth or " +
        "the Moon, orbit any registered body, or free-roam in space. Answer conversationally in one or " +
        "two short sentences. Ask only one question at a time and give only one " +
        "step at a time. After using a tool, summarize only the result the user " +
        "needs. The position shown by the app is the place under " +
        "the user’s feet. Use get_navigation_state before reporting the current " +
        "world, mode, or scale. Use set_navigation to change world, placement " +
        "mode, or universal 1:N scale denominator. Surface mode is available on Earth and " +
        "the Moon; other bodies automatically use orbit. Use get_user_location before answering questions that " +
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
        "set_user_location. Both location and scale changes accept an " +
        "optional time in seconds for an eased transition; use it when the user " +
        "asks for a smooth or gradual move, and omit it for an instant change. " +
        "Be clear when coordinates are approximate. " +
        "When the user asks to drop or place a pin at a named place without " +
        "supplying coordinates, call lookup_location first, then pass the chosen " +
        "result’s coordinates to add_location_pin. Use the first ranked result " +
        "when it is a clear match; if multiple results are plausibly what the user " +
        "meant, ask one short clarification question. Use get_location_pins before " +
        "reporting or changing existing map pins. Users refer to pins by their " +
        "spoken labels, not pin IDs: match labels case-insensitively and use the " +
        "returned pin_id without asking the user for it. If multiple pins have the " +
        "same matching label, ask which one they mean. Use add_location_pin to " +
        "place and show a labeled Earth pin. Use rename_location_pin to change only " +
        "a pin’s label. Use " +
        "set_location_pin_visibility to show, hide, turn on, or turn off a pin " +
        "without forgetting it. Use remove_location_pin only when the user asks " +
        "to remove, delete, or forget a pin, and set_location_pin_guidance to enable or disable " +
        "off-screen guidance independently for one or more pins. Pins require " +
        "an immersive Earth surface session. " +
        "Use set_satellite_group_visibility when the user asks to show, hide, " +
        "turn on, or turn off the brightest satellites, space stations, or " +
        "science and education satellites. These are three independent groups, " +
        "so change only the requested group. " +
        "Use get_amazon_forest_outlines before reporting which historical " +
        "forest outlines are available or visible. Use " +
        "set_amazon_forest_outline_visibility to show or hide one available " +
        "year without changing any other visible years. Multiple years may be " +
        "visible together, and an empty visible_years result means the overlay " +
        "is off. " +
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
          name: "get_navigation_state",
          description: "Read the current placement mode, focus body, universal 1:N scale denominator, and terrain exaggeration.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          type: "function",
          name: "set_navigation",
          description: "Move to a Solar System body, change between surface/orbit/free placement, or set the universal 1:N physical-metres-per-headset-metre scale denominator.",
          parameters: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["surface", "orbit", "free"] },
              focus_body: {
                type: "string",
                enum: ["sun", "mercury", "venus", "earth", "moon", "mars", "jupiter", "saturn", "uranus", "neptune"],
              },
              scale_denominator: {
                type: "number",
                exclusiveMinimum: 0,
                description: "The N in 1:N; physical metres represented by one headset metre.",
              },
              time: {
                type: "number",
                minimum: 0,
                description:
                  "Optional eased transition duration in seconds. Zero or omission is instant.",
              },
            },
            additionalProperties: false,
          },
        },
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
              time: {
                type: "number",
                minimum: 0,
                description:
                  "Optional eased transition duration in seconds. Zero or omission is instant.",
              },
            },
            required: ["latitude_degrees", "longitude_degrees"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "lookup_location",
          description:
            "Resolve a spoken place name or address into ranked latitude/longitude candidates before moving there or dropping a pin.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                minLength: 1,
                description:
                  "The place name or address as spoken, including country or region when supplied.",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "get_location_pins",
          description:
            "List the current XR session’s labeled Earth pins, exact coordinates, distances, visibility, and guidance state.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          type: "function",
          name: "add_location_pin",
          description:
            "Add and show a labeled Earth pin at exact coordinates for the current XR session.",
          parameters: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1 },
              latitude_degrees: {
                type: "number",
                minimum: -90,
                maximum: 90,
              },
              longitude_degrees: {
                type: "number",
                minimum: -180,
                maximum: 180,
              },
            },
            required: ["label", "latitude_degrees", "longitude_degrees"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "remove_location_pin",
          description:
            "Remove one location pin by the pin ID returned by get_location_pins.",
          parameters: {
            type: "object",
            properties: { pin_id: { type: "string", minLength: 1 } },
            required: ["pin_id"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_location_pin_visibility",
          description:
            "Show or hide one current-session location pin without forgetting it. Hidden pins can be shown again later in the same XR session.",
          parameters: {
            type: "object",
            properties: {
              pin_id: { type: "string", minLength: 1 },
              visible: { type: "boolean" },
            },
            required: ["pin_id", "visible"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "rename_location_pin",
          description:
            "Rename one current-session location pin without changing its coordinates, visibility, or guidance state.",
          parameters: {
            type: "object",
            properties: {
              pin_id: { type: "string", minLength: 1 },
              new_label: { type: "string", minLength: 1 },
            },
            required: ["pin_id", "new_label"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_location_pin_guidance",
          description:
            "Enable or disable off-screen guidance for one existing location pin without changing guidance for other pins.",
          parameters: {
            type: "object",
            properties: {
              pin_id: { type: "string", minLength: 1 },
              enabled: { type: "boolean" },
            },
            required: ["pin_id", "enabled"],
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
          name: "get_amazon_forest_outlines",
          description:
            "Read the available and currently visible Amazon forest outline years.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          type: "function",
          name: "set_amazon_forest_outline_visibility",
          description:
            "Show or hide one available Amazon forest outline year without changing any other year.",
          parameters: {
            type: "object",
            properties: {
              year: { type: "integer" },
              visible: { type: "boolean" },
            },
            required: ["year", "visible"],
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
            "Read terrain and texture planner, horizon-culling, payload-request, and source-fetch state. Use this for loading progress, queued or in-flight work, completion, failures, and scheduler health. Tile payload requests and shared provider source jobs are distinct layers.",
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
          name: "set_tile_recalculation",
          description:
            "Enable or freeze topology-target recalculation for terrain, textures, or both. Geometric horizon culling continues following observer location and eye height.",
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

function eclipseRealtimeSessionConfiguration(): Record<string, unknown> {
  const emptyParameters = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  return {
    expires_after: { anchor: "created_at", seconds: 600 },
    session: {
      type: "realtime",
      model: "gpt-realtime-2.1",
      instructions:
        "You are the concise, warm voice guide inside the Pas de Géant " +
        "Eclipse Observatory. Answer conversationally in one or two short " +
        "sentences. Ask only one question at a time. The app renders global " +
        "solar eclipses using one honest Earth–Moon simulation geometry. Use " +
        "get_eclipse_state before reporting the selected event, time, " +
        "playback, or scale. To choose another eclipse, first call " +
        "find_solar_eclipses for an appropriate UTC range, then pass an exact " +
        "returned event_id to select_solar_eclipse. Never invent an eclipse " +
        "or scientific geometry. Use set_eclipse_time for an exact instant, " +
        "set_eclipse_playback to play or pause, set_eclipse_scale only for " +
        "an explicitly requested universal 1:N scale denominator, " +
        "and reset_eclipse_stage " +
        "to restore the default Earth-orbital scale and distance. Earth, " +
        "Moon, shadow cones, and Sun remain one coherent system; movement " +
        "moves the observer, never an individual body. After every mutation summarize " +
        "the actual returned state. Use search_wikipedia for stable background " +
        "facts and search_web for current, recent, or niche information or an " +
        "explicit request to browse. Never claim to have searched unless a " +
        "search tool was called, and never read URLs aloud.",
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
          name: "get_eclipse_state",
          description:
            "Read the verified selected solar eclipse, current UTC, playback, Earth-orbital altitude, physical scale, and shadow state.",
          parameters: emptyParameters,
        },
        {
          type: "function",
          name: "find_solar_eclipses",
          description:
            "Find verified global solar eclipses in a UTC date range before selecting one.",
          parameters: {
            type: "object",
            properties: {
              start_utc: { type: "string", description: "Inclusive ISO 8601 UTC start." },
              end_utc: { type: "string", description: "Exclusive ISO 8601 UTC end." },
            },
            required: ["start_utc", "end_utc"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "select_solar_eclipse",
          description:
            "Select an exact verified event_id returned by find_solar_eclipses.",
          parameters: {
            type: "object",
            properties: { event_id: { type: "string", minLength: 1 } },
            required: ["event_id"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_eclipse_time",
          description:
            "Set the selected eclipse simulation to an ISO 8601 UTC instant within 24 hours of its peak.",
          parameters: {
            type: "object",
            properties: { utc: { type: "string" } },
            required: ["utc"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_eclipse_playback",
          description: "Play or pause the selected eclipse timeline.",
          parameters: {
            type: "object",
            properties: { playing: { type: "boolean" } },
            required: ["playing"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "set_eclipse_scale",
          description:
            "Set the positive universal 1:N scale denominator while preserving all physical Earth–Moon geometry and the observer’s physical position.",
          parameters: {
            type: "object",
            properties: {
              scale_denominator: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["scale_denominator"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "reset_eclipse_stage",
          description:
            "Return the observer to the default Earth-orbital scale and distance without changing eclipse or time.",
          parameters: emptyParameters,
        },
        {
          type: "function",
          name: "search_wikipedia",
          description: "Search English Wikipedia for stable eclipse background facts.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", minLength: 1 } },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          type: "function",
          name: "search_web",
          description: "Search the live web for current, recent, or niche eclipse information.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", minLength: 1 } },
            required: ["query"],
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
  experienceOrFetch: RealtimeExperience | FetchImplementation = "earth",
  fetchImplementation: FetchImplementation = fetch,
): Promise<{ status: number; body: string }> {
  const experience = typeof experienceOrFetch === "function"
    ? "earth"
    : experienceOrFetch;
  const resolvedFetch = typeof experienceOrFetch === "function"
    ? experienceOrFetch
    : fetchImplementation;
  const response = await resolvedFetch(
    "https://api.openai.com/v1/realtime/client_secrets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(realtimeSessionConfiguration(experience)),
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
    const requestUrl = new URL(request.url ?? "/", "http://local");
    const pathname = requestUrl.pathname;
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
    const experience = realtimeExperienceFromUrl(requestUrl);
    if (!experience) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Unknown Realtime experience." }));
      return;
    }
    if (!isAllowedRequestOrigin(request.headers.origin)) {
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
      const result = await requestRealtimeClientSecret(apiKey, experience);
      response.statusCode = result.status;
      response.end(result.body);
    } catch (error) {
      console.error("Realtime client-secret request failed:", error);
      response.statusCode = 502;
      response.end(JSON.stringify({ error: "Voice session setup failed." }));
    }
  };
}
