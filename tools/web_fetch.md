# `web_fetch`

## Description

Fetch a document from the web and return the response body as text using `response.text()`.

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

- Always reads the response body with `response.text()`.
- Returns response metadata followed by the raw text body.
- Accepts only absolute `http` and `https` URLs.
