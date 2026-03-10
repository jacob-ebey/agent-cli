# `read_file`

## Description

Read a UTF-8 text file from the workspace. Prefer this when you need to inspect a known file path, and use `offset` plus `limit` to page through large files instead of reading everything at once.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Relative path to the file you want to read."
    },
    "offset": {
      "type": "integer",
      "description": "Optional 1-based line number to start reading from.",
      "minimum": 1
    },
    "limit": {
      "type": "integer",
      "description": "Optional maximum number of lines to return.",
      "minimum": 1
    }
  },
  "required": ["path"],
  "additionalProperties": false
}
```

## Notes

- Returns numbered lines in `line|content` format.
- Paths must stay within the current workspace.
