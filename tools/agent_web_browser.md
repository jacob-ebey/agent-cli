# `agent_web_browser`

## Description

View a website and return a rendered page snapshot. Use this tool whenever you need to browse the web or inspect a live webpage as it appears in a browser. Do not use `web_fetch` for that; `web_fetch` is only for API calls and other raw HTTP requests.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "The absolute http or https URL to visit and inspect."
    },
    "timeout_ms": {
      "type": "integer",
      "description": "Optional timeout in milliseconds applied to each browser step. Defaults to 30000.",
      "minimum": 1
    }
  },
  "required": ["url"],
  "additionalProperties": false
}
```

## Metadata

```json
{
  "requiresApproval": true,
  "approvalScope": "command",
  "approvalPersistence": "persisted"
}
```

## Notes

- Use this tool for all web browsing and rendered page inspection.
- Do not use `web_fetch` for browsing; `web_fetch` is only for API requests and other raw HTTP calls.
- The tool visits the requested page and returns a browser snapshot of the rendered result.
- Only absolute `http` and `https` URLs are supported.
