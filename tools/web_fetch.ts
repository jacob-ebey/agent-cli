import { assertInteger, type ToolHandler } from "./runtime.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const USER_AGENT = "agent-cli/1.0 (+https://github.com/jacob-ebey/agent-cli)";

function clampInteger(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/*, application/json;q=0.9, */*;q=0.8",
        "User-Agent": USER_AGENT,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

export const execute: ToolHandler = async (argumentsObject) => {
  const url = argumentsObject.url;
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("url must be a non-empty string.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url.trim());
  } catch {
    throw new Error("url must be a valid absolute URL.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("url must use http or https.");
  }

  const requestedTimeoutMs = assertInteger(
    argumentsObject.timeout_ms,
    "timeout_ms",
    DEFAULT_TIMEOUT_MS
  );
  const timeoutMs = clampInteger(requestedTimeoutMs, 1, MAX_TIMEOUT_MS);

  const response = await fetchWithTimeout(parsedUrl.toString(), timeoutMs);
  const body = await response.text();

  return [
    `URL: ${parsedUrl.toString()}`,
    `Status: ${response.status} ${response.statusText}`.trim(),
    `Content-Type: ${response.headers.get("content-type") ?? "unknown"}`,
    `Content-Length: ${response.headers.get("content-length") ?? "unknown"}`,
    `Timeout ms: ${timeoutMs}`,
    "",
    body,
  ].join("\n");
};
