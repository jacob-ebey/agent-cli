# `web_search`

## Description

Search the web using DuckDuckGo's public instant answer API and return concise result summaries with URLs.

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
- Returns structured summaries derived from abstract and related topic results.
- This tool depends on outbound network access being available in the runtime.
- The API may return sparse results for some queries compared with full search engines.
