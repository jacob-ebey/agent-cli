import { assertInteger, type ToolHandler } from "./runtime.ts";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const USER_AGENT = "agent-cli/1.0 (+https://github.com/jacob-ebey/agent-cli)";

type DuckDuckGoTopic = {
  FirstURL?: unknown;
  Result?: unknown;
  Text?: unknown;
  Topics?: unknown;
};

type DuckDuckGoResponse = {
  Abstract?: unknown;
  AbstractSource?: unknown;
  AbstractText?: unknown;
  AbstractURL?: unknown;
  Answer?: unknown;
  AnswerType?: unknown;
  Definition?: unknown;
  DefinitionSource?: unknown;
  DefinitionURL?: unknown;
  Heading?: unknown;
  Image?: unknown;
  ImageHeight?: unknown;
  ImageIsLogo?: unknown;
  ImageWidth?: unknown;
  Infobox?: unknown;
  Redirect?: unknown;
  RelatedTopics?: unknown;
  Results?: unknown;
  Type?: unknown;
  meta?: unknown;
};

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

function clampInteger(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function stripHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function toSearchResult(topic: DuckDuckGoTopic): SearchResult | null {
  const url = typeof topic.FirstURL === "string" ? topic.FirstURL.trim() : "";
  const text = typeof topic.Text === "string" ? stripHtml(topic.Text) : "";
  const resultHtml = typeof topic.Result === "string" ? stripHtml(topic.Result) : "";
  const snippet = text || resultHtml;

  if (!url || !snippet) {
    return null;
  }

  const dashIndex = snippet.indexOf(" - ");
  const title = dashIndex > 0 ? snippet.slice(0, dashIndex).trim() : url;
  const body = dashIndex > 0 ? snippet.slice(dashIndex + 3).trim() : snippet;

  return {
    title,
    url,
    snippet: body,
    source: "DuckDuckGo Instant Answer API",
  };
}

function collectTopicResults(value: unknown, collected: SearchResult[]) {
  if (!Array.isArray(value)) {
    return;
  }

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const topic = entry as DuckDuckGoTopic;
    const result = toSearchResult(topic);
    if (result) {
      collected.push(result);
      continue;
    }

    collectTopicResults(topic.Topics, collected);
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

export const execute: ToolHandler = async (argumentsObject) => {
  const query = argumentsObject.query;
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string.");
  }

  const requestedMaxResults = assertInteger(
    argumentsObject.max_results,
    "max_results",
    DEFAULT_MAX_RESULTS
  );
  const maxResults = clampInteger(requestedMaxResults, 1, MAX_RESULTS_LIMIT);

  const requestedTimeoutMs = assertInteger(
    argumentsObject.timeout_ms,
    "timeout_ms",
    DEFAULT_TIMEOUT_MS
  );
  const timeoutMs = clampInteger(requestedTimeoutMs, 1, MAX_TIMEOUT_MS);

  const endpoint = new URL("https://api.duckduckgo.com/");
  endpoint.searchParams.set("q", query.trim());
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("no_redirect", "1");
  endpoint.searchParams.set("no_html", "1");
  endpoint.searchParams.set("skip_disambig", "0");

  const response = await fetchWithTimeout(endpoint.toString(), timeoutMs);
  if (!response.ok) {
    throw new Error(`Web search failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as DuckDuckGoResponse;
  const results: SearchResult[] = [];

  if (
    typeof payload.AbstractText === "string" &&
    payload.AbstractText.trim() &&
    typeof payload.AbstractURL === "string" &&
    payload.AbstractURL.trim()
  ) {
    results.push({
      title:
        typeof payload.Heading === "string" && payload.Heading.trim()
          ? payload.Heading.trim()
          : payload.AbstractURL.trim(),
      url: payload.AbstractURL.trim(),
      snippet: stripHtml(payload.AbstractText.trim()),
      source:
        typeof payload.AbstractSource === "string" && payload.AbstractSource.trim()
          ? payload.AbstractSource.trim()
          : "DuckDuckGo Instant Answer API",
    });
  }

  collectTopicResults(payload.Results, results);
  collectTopicResults(payload.RelatedTopics, results);

  const uniqueResults = results.filter(
    (result, index, array) => array.findIndex((entry) => entry.url === result.url) === index
  );
  const limitedResults = uniqueResults.slice(0, maxResults);

  return [
    `Query: ${query.trim()}`,
    `Source: DuckDuckGo Instant Answer API`,
    `Timeout ms: ${timeoutMs}`,
    `Results: ${limitedResults.length}`,
    uniqueResults.length > maxResults ? `Truncated: showing first ${maxResults}` : null,
    "",
    limitedResults.length
      ? limitedResults
          .map(
            (result, index) =>
              [
                `${index + 1}. ${result.title}`,
                `URL: ${result.url}`,
                `Snippet: ${result.snippet}`,
                `Source: ${result.source}`,
              ].join("\n")
          )
          .join("\n\n")
      : "No results found.",
  ]
    .filter((line) => line !== null)
    .join("\n");
};
