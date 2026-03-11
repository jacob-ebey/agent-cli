# `ripgrep`

## Description

Search file contents inside the workspace by spawning ripgrep. Prefer this when you need to locate symbols, text, or patterns before deciding which files to read.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "The ripgrep pattern to search for."
    },
    "path": {
      "type": "string",
      "description": "Optional relative file or directory to search within. Defaults to the workspace root."
    },
    "glob": {
      "type": "string",
      "description": "Optional ripgrep glob, such as *.ts or src/**/*.tsx."
    },
    "max_results": {
      "type": "integer",
      "description": "Optional maximum number of matching lines to return.",
      "minimum": 1
    }
  },
  "required": ["pattern"],
  "additionalProperties": false
}
```

## Notes

- Search results include file paths and line numbers.
- Paths must stay within the current workspace.
