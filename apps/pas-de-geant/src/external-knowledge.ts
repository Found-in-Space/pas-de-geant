export const WIKIPEDIA_SEARCH_PATH = "/api/knowledge/wikipedia";
export const WEB_SEARCH_PATH = "/api/knowledge/web";

export interface KnowledgeSource {
  readonly title: string;
  readonly url: string;
}

export interface WikipediaSearchResult extends KnowledgeSource {
  readonly summary: string;
}

export interface WikipediaSearchResponse {
  readonly query: string;
  readonly results: readonly WikipediaSearchResult[];
}

export interface WebSearchResponse {
  readonly query: string;
  readonly answer: string;
  readonly sources: readonly KnowledgeSource[];
}

export function parseKnowledgeSearchArguments(value: unknown): {
  query: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Search arguments must be an object.");
  }
  const query = (value as Record<string, unknown>).query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("Search query must be a non-blank string.");
  }
  return { query: query.trim() };
}

function source(value: unknown): KnowledgeSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.title !== "string" ||
      typeof candidate.url !== "string") return undefined;
  const title = candidate.title.trim();
  try {
    const url = new URL(candidate.url);
    if (!title || url.protocol !== "https:") return undefined;
    return { title, url: url.href };
  } catch {
    return undefined;
  }
}

function serverErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return undefined;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

async function fetchPayload(
  path: string,
  query: string,
  fetchImplementation: typeof fetch,
): Promise<unknown> {
  const parameters = new URLSearchParams({ q: query });
  const response = await fetchImplementation(`${path}?${parameters}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    throw new Error(
      serverErrorMessage(payload) ?? `Knowledge lookup failed (${response.status}).`,
    );
  }
  return payload;
}

export async function searchWikipedia(
  query: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<WikipediaSearchResponse> {
  const normalizedQuery = parseKnowledgeSearchArguments({ query }).query;
  const payload = await fetchPayload(
    WIKIPEDIA_SEARCH_PATH,
    normalizedQuery,
    fetchImplementation,
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Wikipedia returned an invalid response.");
  }
  const candidate = payload as Record<string, unknown>;
  if (!Array.isArray(candidate.results)) {
    throw new Error("Wikipedia returned an invalid response.");
  }
  const results = candidate.results.flatMap((value) => {
    const normalizedSource = source(value);
    if (!normalizedSource || !value || typeof value !== "object") return [];
    const summary = (value as Record<string, unknown>).summary;
    if (typeof summary !== "string" || !summary.trim()) return [];
    return [{ ...normalizedSource, summary: summary.trim() }];
  });
  return { query: normalizedQuery, results };
}

export async function searchWeb(
  query: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<WebSearchResponse> {
  const normalizedQuery = parseKnowledgeSearchArguments({ query }).query;
  const payload = await fetchPayload(
    WEB_SEARCH_PATH,
    normalizedQuery,
    fetchImplementation,
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Web search returned an invalid response.");
  }
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.answer !== "string" || !candidate.answer.trim() ||
      !Array.isArray(candidate.sources)) {
    throw new Error("Web search returned an invalid response.");
  }
  return {
    query: normalizedQuery,
    answer: candidate.answer.trim(),
    sources: candidate.sources.flatMap((value) => {
      const normalized = source(value);
      return normalized ? [normalized] : [];
    }),
  };
}
