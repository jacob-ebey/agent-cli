# `web_fetch`

## Description

Fetch a raw HTTP document from the web and return the response body as text using `response.text()`. This tool must NEVER be used for browsing websites. It is only allowed for raw HTTP requests such as API calls, where you need the direct response body.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "The absolute http or https URL to fetch."
    },
    "timeout_ms": {
      "type": "integer",
      "description": "Optional timeout in milliseconds for the HTTP request. Defaults to 10000.",
      "minimum": 1
    }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

## Notes

- Never use this tool for website browsing, navigation, rendered-page inspection, or general web exploration.
- Use `agent_web_browser` instead for browsing websites, navigation, text-based snapshots, and page interaction.
- Use this tool only for raw HTTP fetches, especially API requests where you need the exact response body without browser rendering.
- Always reads the response body with `response.text()`.
- Returns response metadata followed by the raw text body.
- Accepts only absolute `http` and `https` URLs.
