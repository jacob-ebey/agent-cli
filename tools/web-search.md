# `web-search`

## Description

Search the web using DuckDuckGo and return concise result summaries with URLs. It prefers the public instant answer API and falls back to DuckDuckGo's HTML results when the API is empty.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "The web search query."
    },
    "max_results": {
      "type": "integer",
      "description": "Optional maximum number of results to return. Values above 10 are clamped to 10.",
      "minimum": 1
    },
    "timeout_ms": {
      "type": "integer",
      "description": "Optional timeout in milliseconds for the HTTP request. Defaults to 10000.",
      "minimum": 1
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

## Notes

- Uses DuckDuckGo's instant answer API at `https://api.duckduckgo.com/`.
- Falls back to DuckDuckGo's HTML endpoint at `https://html.duckduckgo.com/html/` when the instant answer API has no usable results.
- Returns structured summaries derived from abstract, related topic, or parsed HTML search results.
- This tool depends on outbound network access being available in the runtime.
