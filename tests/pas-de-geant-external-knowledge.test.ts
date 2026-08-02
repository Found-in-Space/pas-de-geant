import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  parseKnowledgeSearchArguments,
  searchWeb,
  searchWikipedia,
  WEB_SEARCH_PATH,
  WIKIPEDIA_SEARCH_PATH,
} from "../apps/pas-de-geant/src/external-knowledge.js";
import {
  createExternalKnowledgeMiddleware,
  OPENAI_RESPONSES_URL,
  requestWebSearch,
  requestWikipediaSearch,
  WEB_SEARCH_MODEL,
  WIKIPEDIA_API_URL,
} from "../apps/pas-de-geant/src/external-knowledge-server.js";

interface RecordedResponse {
  readonly response: ServerResponse;
  readonly headers: Map<string, string>;
  readonly body: () => string;
  readonly status: () => number;
}

function recordedResponse(): RecordedResponse {
  const headers = new Map<string, string>();
  let body = "";
  let statusCode = 200;
  const response = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    end(value?: string) {
      body = value ?? "";
      return this;
    },
  } as unknown as ServerResponse;
  return {
    response,
    headers,
    body: () => body,
    status: () => statusCode,
  };
}

function request(
  url: string,
  method = "GET",
  origin = "http://local.test",
): IncomingMessage {
  return {
    url,
    method,
    headers: { host: "local.test", origin },
  } as IncomingMessage;
}

describe("external knowledge lookups", () => {
  it("normalizes tool queries and rejects missing or blank queries", () => {
    expect(parseKnowledgeSearchArguments({ query: "  Mont Blanc  " })).toEqual({
      query: "Mont Blanc",
    });
    expect(() => parseKnowledgeSearchArguments({})).toThrow("non-blank");
    expect(() => parseKnowledgeSearchArguments({ query: " \n " })).toThrow(
      "non-blank",
    );
  });

  it("requests normalized English Wikipedia intros from the fixed endpoint", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const result = await requestWikipediaSearch("  plate tectonics  ", async (
      input,
      init,
    ) => {
      capturedInput = input;
      capturedInit = init;
      return new Response(JSON.stringify({
        query: {
          pages: [
            {
              index: 2,
              title: "Tectonics",
              extract: "  Tectonics studies deformation.  ",
              canonicalurl: "http://unsafe.example/tectonics",
            },
            {
              index: 1,
              title: "Plate tectonics",
              extract: "Plate tectonics is a scientific theory.\nIt explains plates.",
              canonicalurl: "https://en.wikipedia.org/wiki/Plate_tectonics",
            },
            { index: 3, title: "No extract" },
          ],
        },
      }));
    });

    const url = new URL(String(capturedInput));
    expect(url.origin + url.pathname).toBe(WIKIPEDIA_API_URL);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      action: "query",
      generator: "search",
      gsrsearch: "  plate tectonics  ",
      prop: "extracts|info",
      exintro: "1",
      explaintext: "1",
      exsentences: "2",
      inprop: "url",
      redirects: "1",
      format: "json",
      formatversion: "2",
    });
    expect(capturedInit?.headers).toMatchObject({
      Accept: "application/json",
      "User-Agent": expect.stringContaining("Pas-de-Geant"),
    });
    expect(result).toEqual({
      query: "  plate tectonics  ",
      results: [
        {
          title: "Plate tectonics",
          summary: "Plate tectonics is a scientific theory. It explains plates.",
          url: "https://en.wikipedia.org/wiki/Plate_tectonics",
        },
        {
          title: "Tectonics",
          summary: "Tectonics studies deformation.",
          url: "https://en.wikipedia.org/wiki/Tectonics",
        },
      ],
    });
  });

  it("makes the required Responses API web-search request and merges citations", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const result = await requestWebSearch(
      "current Alpine conditions",
      "sk-server-only",
      async (input, init) => {
        capturedInput = input;
        capturedInit = init;
        return new Response(JSON.stringify({
          output: [
            {
              type: "web_search_call",
              action: {
                sources: [
                  { title: "Mountain service", url: "https://mountain.example/report" },
                  { title: "Unsafe", url: "http://unsafe.example/report" },
                ],
              },
            },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Conditions are wintry above 2,500 metres.",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://mountain.example/report",
                      title: "Duplicate title",
                    },
                    {
                      type: "url_citation",
                      url: "https://weather.example/alps",
                      title: "Alpine forecast",
                    },
                  ],
                },
              ],
            },
          ],
        }));
      },
    );

    expect(String(capturedInput)).toBe(OPENAI_RESPONSES_URL);
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toMatchObject({
      Authorization: "Bearer sk-server-only",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: WEB_SEARCH_MODEL,
      input: "current Alpine conditions",
      tools: [{ type: "web_search", search_context_size: "low" }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
    });
    expect(body.instructions).toContain("one or two short sentences");
    expect(result).toEqual({
      query: "current Alpine conditions",
      answer: "Conditions are wintry above 2,500 metres.",
      sources: [
        { title: "Mountain service", url: "https://mountain.example/report" },
        { title: "Alpine forecast", url: "https://weather.example/alps" },
      ],
    });
  });

  it("uses fixed same-origin client routes and normalizes server results", async () => {
    const requested: string[] = [];
    const wikipedia = await searchWikipedia("  Mont Blanc  ", async (input) => {
      requested.push(String(input));
      return new Response(JSON.stringify({
        query: "ignored",
        results: [
          {
            title: " Mont Blanc ",
            summary: "  Highest Alpine mountain. ",
            url: "https://en.wikipedia.org/wiki/Mont_Blanc",
          },
          {
            title: "Unsafe",
            summary: "Dropped",
            url: "javascript:alert(1)",
          },
        ],
      }));
    });
    const web = await searchWeb("  latest Alps news ", async (input) => {
      requested.push(String(input));
      return new Response(JSON.stringify({
        answer: "  Snow is expected. ",
        sources: [
          { title: " Forecast ", url: "https://weather.example/alps" },
          { title: "Insecure", url: "http://weather.example/alps" },
        ],
      }));
    });

    expect(requested).toEqual([
      `${WIKIPEDIA_SEARCH_PATH}?q=Mont+Blanc`,
      `${WEB_SEARCH_PATH}?q=latest+Alps+news`,
    ]);
    expect(wikipedia).toEqual({
      query: "Mont Blanc",
      results: [{
        title: "Mont Blanc",
        summary: "Highest Alpine mountain.",
        url: "https://en.wikipedia.org/wiki/Mont_Blanc",
      }],
    });
    expect(web).toEqual({
      query: "latest Alps news",
      answer: "Snow is expected.",
      sources: [{ title: "Forecast", url: "https://weather.example/alps" }],
    });
  });

  it("surfaces structured server errors to client callers", async () => {
    await expect(searchWeb("weather", async () => new Response(JSON.stringify({
      error: { code: "web_search_unavailable", message: "No server key." },
    }), { status: 503 }))).rejects.toThrow("No server key.");
  });

  it("enforces middleware method, origin, query, and web-key boundaries", async () => {
    const middleware = createExternalKnowledgeMiddleware(undefined, async () => {
      throw new Error("upstream should not run");
    });
    for (const [incoming, expectedStatus, expectedCode] of [
      [request(WEB_SEARCH_PATH, "POST"), 405, "method_not_allowed"],
      [request(WEB_SEARCH_PATH, "GET", "https://malicious.example"), 403, "cross_origin_denied"],
      [request(`${WEB_SEARCH_PATH}?q=%20`), 400, "invalid_query"],
      [request(`${WEB_SEARCH_PATH}?q=weather`), 503, "web_search_unavailable"],
    ] as const) {
      const output = recordedResponse();
      let calledNext = false;
      await middleware(incoming, output.response, () => {
        calledNext = true;
      });
      expect(calledNext).toBe(false);
      expect(output.status()).toBe(expectedStatus);
      expect(JSON.parse(output.body())).toMatchObject({
        error: { code: expectedCode },
      });
      expect(output.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("serves Wikipedia without an OpenAI key and passes unknown routes onward", async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({
      query: { pages: [{ title: "Earth", extract: "Earth is a planet." }] },
    })));
    const middleware = createExternalKnowledgeMiddleware(undefined, upstream);
    const output = recordedResponse();
    await middleware(
      request(`${WIKIPEDIA_SEARCH_PATH}?q=Earth`),
      output.response,
      () => undefined,
    );
    expect(output.status()).toBe(200);
    expect(JSON.parse(output.body())).toEqual({
      query: "Earth",
      results: [{
        title: "Earth",
        summary: "Earth is a planet.",
        url: "https://en.wikipedia.org/wiki/Earth",
      }],
    });
    expect(upstream).toHaveBeenCalledOnce();

    let calledNext = false;
    await middleware(request("/not-knowledge"), recordedResponse().response, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(true);
  });
});
