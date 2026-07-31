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
        "room-scale relief Earth experience. Answer conversationally and keep " +
        "spoken replies brief. The position shown by the app is the place under " +
        "the user’s feet. Use get_user_location before answering questions that " +
        "depend on the current position. Its result may include a named_location " +
        "with country-level detail at wide globe scales and locality detail at " +
        "close scales; do not invent a place when named_location is null. When " +
        "the user asks to go, move, " +
        "travel, or teleport to a place and you know reasonable coordinates, use " +
        "set_user_location. Be clear when coordinates are approximate.",
      audio: {
        input: { turn_detection: { type: "server_vad" } },
        output: { voice: "marin" },
      },
      tools: [
        {
          type: "function",
          name: "get_user_location",
          description:
            "Read the coordinates, display scale, and scale-appropriate named " +
            "location currently under the user’s feet.",
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
