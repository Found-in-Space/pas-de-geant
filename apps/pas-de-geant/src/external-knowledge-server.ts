import type { IncomingMessage, ServerResponse } from "node:http";
import {
  WEB_SEARCH_PATH,
  WIKIPEDIA_SEARCH_PATH,
  type KnowledgeSource,
  type WebSearchResponse,
  type WikipediaSearchResponse,
} from "./external-knowledge.js";
import { isAllowedRequestOrigin } from "./realtime-token-server.js";

export const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const WEB_SEARCH_MODEL = "gpt-5.6-sol";
const WIKIPEDIA_USER_AGENT =
  "Pas-de-Geant/0.1 (+https://github.com/Found-in-Space/pas-de-geant)";

interface WikipediaPage {
  readonly index?: number;
  readonly title?: string;
  readonly extract?: string;
  readonly canonicalurl?: string;
}

function normalizedQuery(url: URL): string | undefined {
  const query = url.searchParams.get("q")?.trim();
  return query ? query : undefined;
}

function requestHost(request: IncomingMessage): string | undefined {
  const forwardedHost = request.headers["x-forwarded-host"];
  return (
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)
      ?.split(",")[0]
      ?.trim() ?? request.headers.host
  );
}

function wikipediaUrl(title: string, canonicalUrl?: string): string {
  if (canonicalUrl) {
    try {
      const canonical = new URL(canonicalUrl);
      if (canonical.protocol === "https:" &&
          canonical.hostname === "en.wikipedia.org") return canonical.href;
    } catch {
      // Use the fixed Wikipedia origin below.
    }
  }
  return new URL(
    `/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
    "https://en.wikipedia.org",
  ).href;
}

export async function requestWikipediaSearch(
  query: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<WikipediaSearchResponse> {
  const url = new URL(WIKIPEDIA_API_URL);
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("prop", "extracts|info");
  url.searchParams.set("exintro", "1");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("exsentences", "2");
  url.searchParams.set("inprop", "url");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  const response = await fetchImplementation(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": WIKIPEDIA_USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`Wikipedia request failed (${response.status}).`);
  }
  const payload = await response.json() as {
    query?: { pages?: WikipediaPage[] };
  };
  const pages = [...(payload.query?.pages ?? [])].sort(
    (first, second) => (first.index ?? 0) - (second.index ?? 0),
  );
  return {
    query,
    results: pages.flatMap((page) => {
      const title = page.title?.trim();
      const summary = page.extract?.replace(/\s+/g, " ").trim();
      return title && summary
        ? [{ title, summary, url: wikipediaUrl(title, page.canonicalurl) }]
        : [];
    }),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function httpsSource(value: unknown): KnowledgeSource | undefined {
  const candidate = record(value);
  const citation = record(candidate?.url_citation) ?? candidate;
  const urlValue = citation?.url;
  if (typeof urlValue !== "string") return undefined;
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:") return undefined;
    const suppliedTitle = citation?.title;
    const title = typeof suppliedTitle === "string" && suppliedTitle.trim()
      ? suppliedTitle.trim()
      : url.hostname;
    return { title, url: url.href };
  } catch {
    return undefined;
  }
}

export function parseWebSearchResponse(
  query: string,
  payload: unknown,
): WebSearchResponse {
  const response = record(payload);
  const output = Array.isArray(response?.output) ? response.output : [];
  const answerParts: string[] = [];
  const sources: KnowledgeSource[] = [];
  const appendSource = (value: unknown): void => {
    const normalized = httpsSource(value);
    if (normalized) sources.push(normalized);
  };
  for (const itemValue of output) {
    const item = record(itemValue);
    if (item?.type === "web_search_call") {
      const action = record(item.action);
      if (Array.isArray(action?.sources)) {
        for (const value of action.sources) appendSource(value);
      }
    }
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const contentValue of item.content) {
      const content = record(contentValue);
      if (content?.type !== "output_text") continue;
      if (typeof content.text === "string" && content.text.trim()) {
        answerParts.push(content.text.trim());
      }
      if (Array.isArray(content.annotations)) {
        for (const value of content.annotations) appendSource(value);
      }
    }
  }
  const answer = answerParts.join("\n").trim();
  if (!answer) throw new Error("Web search returned no answer.");
  const uniqueSources = new Map<string, KnowledgeSource>();
  for (const source of sources) {
    if (!uniqueSources.has(source.url)) uniqueSources.set(source.url, source);
  }
  return { query, answer, sources: [...uniqueSources.values()] };
}

export async function requestWebSearch(
  query: string,
  apiKey: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<WebSearchResponse> {
  const response = await fetchImplementation(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: WEB_SEARCH_MODEL,
      instructions:
        "Search the web and answer with concise, source-grounded evidence for " +
        "a voice assistant handoff. Give a self-contained answer in one or two " +
        "short sentences. Attribute key evidence by source title when useful. " +
        "Do not output or discuss raw URLs.",
      input: query,
      tools: [{ type: "web_search", search_context_size: "low" }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI web search failed (${response.status}).`);
  }
  return parseWebSearchResponse(query, await response.json());
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  response.statusCode = status;
  response.end(JSON.stringify({ error: { code, message } }));
}

export function createExternalKnowledgeMiddleware(
  apiKey: string | undefined,
  fetchImplementation: typeof fetch = fetch,
) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://local");
    const wikipedia = url.pathname === WIKIPEDIA_SEARCH_PATH;
    const web = url.pathname === WEB_SEARCH_PATH;
    if (!wikipedia && !web) {
      next();
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendError(response, 405, "method_not_allowed", "Method not allowed.");
      return;
    }
    if (!isAllowedRequestOrigin(request.headers.origin, requestHost(request))) {
      sendError(response, 403, "cross_origin_denied", "Cross-origin requests are denied.");
      return;
    }
    const query = normalizedQuery(url);
    if (!query) {
      sendError(response, 400, "invalid_query", "Search query must not be blank.");
      return;
    }
    if (web && !apiKey) {
      sendError(
        response,
        503,
        "web_search_unavailable",
        "Web search is unavailable: the local server needs OPENAI_API_KEY.",
      );
      return;
    }
    try {
      const result = wikipedia
        ? await requestWikipediaSearch(query, fetchImplementation)
        : await requestWebSearch(query, apiKey!, fetchImplementation);
      response.statusCode = 200;
      response.end(JSON.stringify(result));
    } catch (error) {
      console.error("External knowledge request failed:", error);
      sendError(
        response,
        502,
        wikipedia ? "wikipedia_failed" : "web_search_failed",
        wikipedia ? "Wikipedia lookup failed." : "Web search failed.",
      );
    }
  };
}
