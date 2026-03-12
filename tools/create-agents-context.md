# `create-agents-context`

## Description

Finish the AGENTS.md discovery loop by returning the final markdown content that should be written to the repository root `AGENTS.md` file.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "markdown": {
      "type": "string",
      "description": "The complete AGENTS.md markdown document to write at the repository root."
    }
  },
  "required": ["markdown"],
  "additionalProperties": false
}
```

## Notes

- Use this tool exactly once, as the final step of the AGENTS.md sub-agent loop.
- Do not call this tool until you have inspected enough repository context to produce a useful document.
- The provided markdown should be concise, factual, and ready to save directly as `AGENTS.md`.
